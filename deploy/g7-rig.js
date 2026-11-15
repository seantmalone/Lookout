#!/usr/bin/env node
// g7-rig: the fleet UI's interface to one Lookout collector. Installed as
// /usr/local/sbin/g7-rig.js (with lib/g7rig in /usr/local/lib/g7rig) and
// reached over SSH only through /usr/local/sbin/g7-rig-remote, as root.
//
//   g7-rig.js status              JSON status (never the key)
//   g7-rig.js scan DXCMxx         {heard, rssi, address} for exactly that name
//   g7-rig.js pair NNNN           forget the old sensor, pair with the next that accepts the code
//   g7-rig.js export-key          {code, name, address, key, central?, paired_at?}
//   g7-rig.js import-key          read that record on stdin and install it
//
// Local only (systemd units on the collector; g7-rig-remote never passes them):
//   g7-rig.js persist             copy what must survive onto the read-only card
//   g7-rig.js bt-watchdog         restart Bluetooth if it is discovering but deaf
//
// Exit codes: 0 ok, 1 error, 2 rejected command, 3 refused (medical slot).
// Test overrides: G7RIG_STORAGE (storage dir), G7RIG_ENV (env file), G7RIG_CACHE (cache dir).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Relative to this file both in the repo (deploy/../lib) and when installed
// (/usr/local/sbin/../lib = /usr/local/lib).
const { parseRemote } = require('../lib/g7rig/validate');
const env = require('../lib/g7rig/env');
const status = require('../lib/g7rig/status');
const { makeDurable, fsyncDir, writeAtomic } = require('../lib/g7rig/durable');
const { planSync, applySync, bondAddress } = require('../lib/g7rig/persist');
const central = require('../lib/g7rig/central');
const keyfile = require('../lib/g7rig/keyfile');
const { parseScan } = require('../lib/g7rig/scan');
const btwatch = require('../lib/g7rig/btwatch');

const ENV_FILE = '/etc/lookout.env';
// fleet collectors: never pair on their own, and never reboot on missed reads
// (the wearer is usually just nearer another collector)
const FLEET_FLAGS = ['--no_auto_pair', '--no_reboot'];
const withFleetFlags = (text) => FLEET_FLAGS.reduce((t, flag) => env.ensureFlag(t, flag), text);
const SCAN_SECONDS = 70;
// what a collector's env needs: fleet flags, an explicit slot, and no
// --sensor_address pin (Lookout latches onto the address that authenticates)
const collectorEnv = (text) => env.ensureDisplayType(withFleetFlags(env.removeSensorAddress(text)));
const STORAGE_KEYS = ['id', 'sensorName', 'sensorKey', 'glucoseHist', 'sensorSeen',
  'pairRequest', 'keyRejected', 'sensorStart', 'sessionLengthSeconds', 'pairedAt'];

const fail = (message, exitCode = 1) => Object.assign(new Error(message), { exitCode });

// exec(cmd, args, {input, env, timeoutMs}) -> {code, stdout, stderr}; never throws.
const defaultExec = (cmd, args = [], opts = {}) => new Promise((resolve) => {
  let stdout = '';
  let stderr = '';
  let child;
  try {
    child = spawn(cmd, args, { env: opts.env || process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    resolve({ code: 127, stdout: '', stderr: e.message });
    return;
  }
  // Our own timer: spawn's `timeout` option is left running when the command
  // is missing (ENOENT) and keeps the process alive.
  const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs || 120000);
  const done = (r) => { clearTimeout(timer); resolve(r); };
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('error', (e) => done({ code: 127, stdout, stderr: stderr || e.message }));
  child.on('close', (code) => done({ code: code === null ? 1 : code, stdout, stderr }));
  child.stdin.on('error', () => {});
  child.stdin.end(opts.input || '');
});

const realIo = () => ({
  exec: defaultExec,
  env: process.env,
  readStdin: () => new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { data += d; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  }),
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  now: () => Date.now(),
  hostname: () => os.hostname(),
  uptime: () => os.uptime(),
  getuid: () => (process.getuid ? process.getuid() : -1),
});

const lastLine = (text) => String(text || '').trim().split('\n').pop() || '';

const lookoutDir = async (io) => {
  const r = await io.exec('systemctl', ['show', 'lookout', '-p', 'WorkingDirectory', '--value']);
  const dir = r.code === 0 ? r.stdout.trim() : '';
  return dir && fs.existsSync(dir) ? dir : null;
};

const lookoutVersion = (dir) => {
  if (!dir) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version || null;
  } catch (e) {
    return null;
  }
};

// node-persist from Lookout's own node_modules (same version and format).
const openStorage = async (io, dir) => {
  const storageDir = io.env.G7RIG_STORAGE || (dir && path.join(dir, 'storage'));
  if (!storageDir || !fs.existsSync(storageDir)) throw fail('Lookout storage not found');
  const local = dir && path.join(dir, 'node_modules', 'node-persist');
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const persist = require(local && fs.existsSync(local) ? local : 'node-persist');
  const store = persist.create({
    dir: storageDir, forgiveParseErrors: true, expiredInterval: false,
  });
  await store.init();
  makeDurable(store); // crash-safe writes, as in Lookout
  return { store, storageDir };
};

const readItems = async (store) => {
  const items = {};
  await Promise.all(STORAGE_KEYS.map(async (k) => {
    const v = await store.getItem(k);
    if (v !== undefined && v !== null) items[k] = v;
  }));
  return items;
};

// We run as root; Lookout runs as its own user and must be able to rewrite
// every item later, so hand new/changed files back to the directory's owner.
const fixOwnership = (io, storageDir) => {
  if (io.getuid() !== 0) return;
  const { uid, gid } = fs.statSync(storageDir);
  fs.readdirSync(storageDir).forEach((f) => fs.chownSync(path.join(storageDir, f), uid, gid));
};

// What Lookout's calibration.clearCalibration does (as `lookout id`): drop the
// old calibration and start again from unity.
const CAL_KEYS = ['g5Calibration', 'expiredCal', 'bgChecks'];
const unityCalibration = (now) => ({
  date: now, scale: 1, intercept: 0, slope: 1000, type: 'Unity',
});

const writeItems = async (io, { store, storageDir }, sets, dels = []) => {
  // node-persist v2 calls are not safe to run in parallel on one instance's files
  // for the same key; these are distinct keys, but keep it simple and serial.
  /* eslint-disable no-restricted-syntax, no-await-in-loop */
  for (const k of Object.keys(sets)) await store.setItem(k, sets[k]);
  for (const k of dels) await store.removeItem(k);
  /* eslint-enable no-restricted-syntax, no-await-in-loop */
  fixOwnership(io, storageDir);
};

const envPath = (io) => io.env.G7RIG_ENV || ENV_FILE;

const readEnv = (io, required = false) => {
  try {
    return fs.readFileSync(envPath(io), 'utf8');
  } catch (e) {
    if (required) throw fail(`${envPath(io)} not readable`);
    return '';
  }
};

// Atomic replace, mode 600, same owner as before.
const writeEnv = (io, text) => {
  const file = envPath(io);
  const before = fs.statSync(file);
  const tmp = `${file}.g7rig-${process.pid}`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(tmp, 0o600);
  if (io.getuid() === 0) fs.chownSync(tmp, before.uid, before.gid);
  fs.renameSync(tmp, file);
  fsyncDir(path.dirname(file)); // the rename itself survives a power cut
};

const refuseMedical = (envText) => {
  if (env.readArgs(envText).medical) {
    throw fail('LOOKOUT_ARGS uses the medical slot (--display_type medical / --force_medical_slot / --alternate); refusing', 3);
  }
};

const mustRun = async (io, cmd, args, what) => {
  const r = await io.exec(cmd, args);
  if (r.code !== 0) throw fail(`${what} failed: ${lastLine(r.stderr) || `exit ${r.code}`}`);
  return r;
};

const printJson = (io, obj) => io.stdout(`${JSON.stringify(obj)}\n`);

const cacheDir = (io) => io.env.G7RIG_CACHE || '/run/g7-rig';
const centralPath = (io) => io.env.G7RIG_CENTRAL || central.FILE;
const readCentral = (io) => {
  try {
    return central.parse(fs.readFileSync(centralPath(io), 'utf8'));
  } catch (e) {
    return null;
  }
};
const currentAdapter = async (io) => central.adapterAddress((await io.exec('bluetoothctl', ['show'])).stdout);

// Give this collector's adapter the shared address (the sensor only accepts
// the key from the address of the collector that paired). Lookout must be
// stopped; BlueZ is restarted so it picks the new address up.
// btmgmt hangs when it has no terminal (as under sudo over ssh, or systemd):
// run it inside script(1), with a time limit, and check the result separately.
const btmgmt = (io, args) => {
  const cmd = `btmgmt ${args.join(' ')}`;
  return io.exec('script', ['-qec', cmd, '/dev/null'], { timeoutMs: 20000 });
};

const applyCentral = async (io, mac) => {
  await btmgmt(io, ['--index', '0', 'power', 'off']);
  await btmgmt(io, ['--index', '0', 'public-addr', mac]);
  await mustRun(io, 'systemctl', ['restart', 'bluetooth'], 'restarting bluetooth');
  await btmgmt(io, ['--index', '0', 'power', 'on']);
  const now = await currentAdapter(io);
  if (now !== mac) throw fail(`could not set the Bluetooth address to ${mac} (it is ${now || 'unknown'})`);
};

// Read-only card (overlayroot): the card itself is mounted read-only here.
const lowerRoot = (io) => io.env.G7RIG_LOWER || '/media/root-ro';
const BT_DIR = '/var/lib/bluetooth';

const readOnlyRoot = async (io) => {
  const root = await io.exec('findmnt', ['-no', 'FSTYPE', '/']);
  if (root.code !== 0 || root.stdout.trim() !== 'overlay') return false;
  const lower = await io.exec('findmnt', ['-no', 'TARGET', lowerRoot(io)]);
  return lower.code === 0 && lower.stdout.trim() !== '';
};

// one persist at a time (the path unit and import-key may overlap)
const withLock = async (io, fn) => {
  const lock = path.join(cacheDir(io), 'persist.lock');
  fs.mkdirSync(cacheDir(io), { recursive: true, mode: 0o700 });
  for (let i = 0; ; i += 1) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      let age = 0;
      try {
        age = Date.now() - fs.statSync(lock).mtimeMs;
      } catch (e2) {
        age = 0;
      }
      if (age > 120000) fs.rmSync(lock, { recursive: true, force: true }); // left by a crash
      else if (i > 300) throw fail('another persist is still running');
      await new Promise((r) => { setTimeout(r, 100); }); // eslint-disable-line no-await-in-loop
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
};

// "busy" right after many writes can last tens of seconds
const RELOCK_TRIES = 60;

// After this many failed tries, drop the dentry/inode caches once.
const RELOCK_DROP_AFTER = 5;

// Make the card read-only again, retrying: a remount right after writing can
// briefly fail with "mount point is busy". Verified against the mount table.
// persist deletes files on the card (scratch storage files, stale bonds); if
// the overlay still has one cached, it stays "unlinked but in use" on the card
// and every remount to read-only fails until the caches are dropped.
const relock = async (io, lower) => {
  const sleep = io.sleep || ((ms) => new Promise((r) => { setTimeout(r, ms); }));
  for (let i = 0; i < RELOCK_TRIES; i += 1) {
    if (i === RELOCK_DROP_AFTER) {
      await io.exec('sync', []); // eslint-disable-line no-await-in-loop
      // failure tolerated: the retries go on either way
      await io.exec('sh', ['-c', 'echo 2 > /proc/sys/vm/drop_caches']); // eslint-disable-line no-await-in-loop
    }
    await io.exec('sync', []); // eslint-disable-line no-await-in-loop
    await io.exec('mount', ['-o', 'remount,ro', lower]); // eslint-disable-line no-await-in-loop
    const opts = await io.exec('findmnt', ['-no', 'OPTIONS', lower]); // eslint-disable-line no-await-in-loop
    if (opts.code === 0 && opts.stdout.trim().split(',')[0] === 'ro') return;
    await sleep(1000); // eslint-disable-line no-await-in-loop
  }
  throw fail(`the card (${lower}) is still writable after ${RELOCK_TRIES} tries to relock it`);
};

// Copy what must survive a power cut onto the read-only card (see persist.js).
const persistNow = async (io) => {
  if (!(await readOnlyRoot(io))) return { ok: true, readOnly: false, changed: 0 };
  return withLock(io, async () => {
    const dir = await lookoutDir(io);
    const storageDir = io.env.G7RIG_STORAGE || (dir && path.join(dir, 'storage'));
    if (!storageDir) throw fail('Lookout storage not found');
    // the bond to keep: the stored key's sensor, else an env pin
    let sensorKey = null;
    try {
      sensorKey = await (await openStorage(io, dir)).store.getItem('sensorKey');
    } catch (e) {
      sensorKey = null;
    }
    const pinned = env.readArgs(readEnv(io)).sensorAddress;
    const sensorAddress = bondAddress({ sensorKey, pinned });
    const lower = lowerRoot(io);
    const ops = planSync({
      upperRoot: '/',
      lowerRoot: lower,
      storageDir,
      envPath: envPath(io),
      btDir: BT_DIR,
      sensorAddress,
      extraFiles: [centralPath(io)],
    });
    if (!ops.length) return { ok: true, readOnly: true, changed: 0 };
    await mustRun(io, 'mount', ['-o', 'remount,rw', lower], 'unlocking the card');
    try {
      applySync(ops, { lowerRoot: lower, upperRoot: '/' });
    } finally {
      await relock(io, lower);
    }
    return { ok: true, readOnly: true, changed: ops.length };
  });
};

// after pair / import-key: best effort (the path unit retries on the next change)
const persistQuietly = async (io) => {
  try {
    await persistNow(io);
  } catch (e) {
    io.stderr(`warning: could not save to the read-only card: ${e.message}\n`);
  }
};

// Reading the journal costs a Pi Zero ~1.5 s of CPU, and the UI asks for a
// status every minute: keep the recent errors for ERRORS_TTL_MS in /run.
const ERRORS_TTL_MS = 5 * 60 * 1000;

const recentErrorsCached = async (io) => {
  const file = path.join(cacheDir(io), 'errors.json');
  try {
    const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    const age = io.now() - cached.at;
    if (age >= 0 && age < ERRORS_TTL_MS && Array.isArray(cached.errors)) return cached.errors;
  } catch (e) {
    // no cache yet, or unreadable: read the journal
  }
  const journal = await io.exec('journalctl', ['-u', 'lookout', '-o', 'cat', '-n', '300', '--no-pager']);
  const errors = journal.code === 0 ? status.recentErrors(journal.stdout) : [];
  try {
    fs.mkdirSync(cacheDir(io), { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ at: io.now(), errors }), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  } catch (e) {
    // best effort
  }
  return errors;
};

// Bluetooth watchdog (lib/g7rig/btwatch.js): state in /run, so a reboot
// starts clean.
const centralApplyPath = (io) => io.env.G7RIG_CENTRAL_APPLY || '/usr/local/sbin/g7-central-apply';

const readWatchState = (file) => {
  try {
    return btwatch.parseState(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return btwatch.parseState(null);
  }
};

const writeWatchState = (file, state) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
};

// Is the adapter discovering? (bluetooth.service active, powered, Discovering: yes)
const btDiscovering = async (io) => {
  const active = await io.exec('systemctl', ['is-active', 'bluetooth']);
  if (active.code !== 0 || active.stdout.trim() !== 'active') return false;
  const show = await io.exec('bluetoothctl', ['show'], { timeoutMs: 15000 });
  if (show.code !== 0) return false;
  const a = btwatch.adapterState(show.stdout);
  return a.powered && a.discovering;
};

// Advertising reports heard in SAMPLE_SECONDS of btmon, or null if btmon did
// not run. btmon needs no terminal; timeout(1) ends it (exit 124).
const sampleAdverts = async (io) => {
  const s = btwatch.SAMPLE_SECONDS;
  const mon = await io.exec('timeout', [String(s), 'btmon'], { timeoutMs: (s + 10) * 1000 });
  if (mon.code !== 0 && mon.code !== 124) return null;
  return btwatch.countAdverts(mon.stdout);
};

const btWatchdog = async (io) => {
  const file = path.join(cacheDir(io), 'btwatch.json');
  const prev = readWatchState(file);
  const discovering = await btDiscovering(io);
  const adverts = discovering ? await sampleAdverts(io) : null;
  const d = btwatch.decide({
    discovering, adverts, ...prev, now: io.now(),
  });
  // saved before acting, so a failing restart is still limited to one an hour
  writeWatchState(file, d.state);
  if (d.reason === 'miss') {
    io.stdout(`bt-watchdog: discovering but no advertisements heard in ${btwatch.SAMPLE_SECONDS} s (${d.state.misses} of ${btwatch.MISSES_TO_ACT})\n`);
  } else if (d.reason === 'rate-limited') {
    const min = Math.round((io.now() - prev.lastRestart) / 60000);
    io.stdout(`bt-watchdog: still no advertisements; not restarting again yet (last restart ${min} min ago, at most one per hour)\n`);
  }
  if (!d.act) return;
  io.stdout(`bt-watchdog: adapter discovering but no advertisements heard in ${btwatch.MISSES_TO_ACT} samples of ${btwatch.SAMPLE_SECONDS} s; restarting bluetooth\n`);
  await mustRun(io, 'systemctl', ['restart', 'bluetooth'], 'restarting bluetooth');
  // the fleet's shared address (g7-central-apply waits for the adapter itself)
  const apply = centralApplyPath(io);
  if (fs.existsSync(apply)) {
    const r = await io.exec(apply, [], { timeoutMs: 120000 });
    if (r.code !== 0) io.stderr(`bt-watchdog: g7-central-apply failed: ${lastLine(r.stderr) || `exit ${r.code}`}\n`);
  }
};

const LOCAL_COMMANDS = ['persist', 'bt-watchdog'];

const commands = {
  // local only (not allowed through g7-rig-remote): run by g7-persist.service
  persist: async (io) => {
    printJson(io, await persistNow(io));
  },

  // local only: run by g7-bt-watchdog.service every 5 minutes
  'bt-watchdog': btWatchdog,

  status: async (io) => {
    const dir = await lookoutDir(io);
    const storage = await readItems((await openStorage(io, dir)).store);
    const [active, bt, errors] = await Promise.all([
      io.exec('systemctl', ['is-active', 'lookout']),
      io.exec('bluetoothctl', ['show']),
      recentErrorsCached(io),
    ]);
    const built = status.build({
      storage,
      envText: readEnv(io),
      lookoutActive: active.code === 0 && active.stdout.trim() === 'active',
      btPowered: bt.code === 0 && /^\s*Powered:\s*yes\s*$/m.test(bt.stdout),
      now: io.now(),
      host: io.hostname(),
      uptimeS: io.uptime(),
      version: lookoutVersion(dir),
      errors,
    });
    // the address this collector presents to the sensor
    built.sensor.central = bt.code === 0 ? central.adapterAddress(bt.stdout) : null;
    printJson(io, built);
  },

  scan: async (io, [name]) => {
    const scan = await io.exec('bluetoothctl', ['--timeout', String(SCAN_SECONDS), 'scan', 'le'], {
      timeoutMs: (SCAN_SECONDS + 15) * 1000,
    });
    const devices = await io.exec('bluetoothctl', ['devices']);
    await io.exec('bluetoothctl', ['scan', 'off']);
    if (scan.code === 127) throw fail(`bluetoothctl failed: ${lastLine(scan.stderr)}`);
    printJson(io, parseScan(`${scan.stdout}\n${scan.stderr}`, devices.stdout, name));
  },

  // Like `lookout id <code>`, plus a pair request for fleet mode: Lookout then
  // connects to any DXCM sensor, keeps the one that accepts the code, and from
  // then on only that address. No scan here: this returns within seconds.
  pair: async (io, [code]) => {
    const envText = readEnv(io, true);
    refuseMedical(envText);
    const nextEnv = collectorEnv(envText);

    const dir = await lookoutDir(io);
    const storage = await openStorage(io, dir);
    const old = await readItems(storage.store);
    const addresses = [env.readArgs(envText).sensorAddress, old.sensorKey && old.sensorKey.address]
      .filter(Boolean).map((a) => a.toUpperCase())
      .filter((a, i, all) => all.indexOf(a) === i);

    await mustRun(io, 'systemctl', ['stop', 'lookout'], 'stopping lookout');
    try {
      const now = io.now();
      await writeItems(io, storage, {}, ['sensorKey', 'sensorName', 'keyRejected', 'pairedAt', ...CAL_KEYS]);
      await writeItems(io, storage, {
        id: code,
        g5Calibration: unityCalibration(now),
        pairRequest: { code, at: now },
      });
      if (nextEnv !== envText) writeEnv(io, nextEnv);
      // the old sensor's bond (failures are fine: it may not be bonded)
      // eslint-disable-next-line no-restricted-syntax
      for (const mac of addresses) await io.exec('bluetoothctl', ['remove', mac]); // eslint-disable-line no-await-in-loop
      await persistQuietly(io);
    } finally {
      await mustRun(io, 'systemctl', ['start', 'lookout'], 'starting lookout');
    }
    printJson(io, { ok: true });
  },

  'export-key': async (io) => {
    const dir = await lookoutDir(io);
    const storage = await readItems((await openStorage(io, dir)).store);
    // The only place the key is ever printed.
    // the address the sensor sees from this collector (and accepted the key from)
    const shared = (await currentAdapter(io)) || readCentral(io);
    printJson(io, keyfile.exportRecord({ storage, envText: readEnv(io), central: shared }));
  },

  'import-key': async (io) => {
    let parsed;
    try {
      parsed = JSON.parse(await io.readStdin());
    } catch (e) {
      throw fail('bad record: not JSON'); // JSON.parse messages quote the input
    }
    const record = keyfile.validateImport(parsed);
    const envText = readEnv(io, true);
    refuseMedical(envText);
    // no pin: the address in sensorKey is what Lookout connects to
    const nextEnv = collectorEnv(envText);

    const dir = await lookoutDir(io);
    const storage = await openStorage(io, dir);
    const old = await readItems(storage.store);
    const addresses = [env.readArgs(envText).sensorAddress, old.sensorKey && old.sensorKey.address,
      record.address].filter(Boolean).map((a) => a.toUpperCase())
      .filter((a, i, all) => all.indexOf(a) === i);

    await mustRun(io, 'systemctl', ['stop', 'lookout'], 'stopping lookout');
    try {
      await writeItems(io, storage, {
        id: record.code,
        sensorKey: { key: record.key, address: record.address },
        ...(record.name ? { sensorName: record.name } : {}),
        ...(record.paired_at ? { pairedAt: Date.parse(record.paired_at) } : {}),
      }, ['pairRequest', 'keyRejected', ...(record.name ? [] : ['sensorName'])]);
      writeEnv(io, nextEnv);
      // eslint-disable-next-line no-restricted-syntax
      for (const mac of addresses) await io.exec('bluetoothctl', ['remove', mac]); // eslint-disable-line no-await-in-loop
      if (record.central) {
        writeAtomic(centralPath(io), central.format(record.central));
        fs.chmodSync(centralPath(io), 0o644);
        if ((await currentAdapter(io)) !== record.central) await applyCentral(io, record.central);
      }
      await persistQuietly(io);
    } finally {
      await mustRun(io, 'systemctl', ['start', 'lookout'], 'starting lookout');
    }
    printJson(io, { ok: true });
  },
};

const run = async (argv, io) => {
  let parsed;
  try {
    // local-only commands: g7-rig-remote never passes them
    const line = argv.join(' ');
    parsed = LOCAL_COMMANDS.includes(line) ? { cmd: line, args: [] } : parseRemote(line);
  } catch (e) {
    io.stderr('rejected\n');
    return 2;
  }
  try {
    await commands[parsed.cmd](io, parsed.args);
    return 0;
  } catch (e) {
    io.stderr(`g7-rig ${parsed.cmd}: ${e.message}\n`);
    return e.exitCode || 1;
  }
};

module.exports = { run, defaultExec };

if (require.main === module) {
  run(process.argv.slice(2), realIo()).then((code) => { process.exitCode = code; });
}
