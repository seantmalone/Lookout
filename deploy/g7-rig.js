#!/usr/bin/env node
// g7-rig: the fleet UI's interface to one Lookout collector. Installed as
// /usr/local/sbin/g7-rig.js (with lib/g7rig in /usr/local/lib/g7rig) and
// reached over SSH only through /usr/local/sbin/g7-rig-remote, as root.
//
//   g7-rig.js status              JSON status (never the key)
//   g7-rig.js scan DXCMxx         {heard, rssi, address} for exactly that name
//   g7-rig.js pair NNNN DXCMxx    g7-new-sensor, then ask Lookout to pair
//   g7-rig.js export-key          {code, name, address, key}
//   g7-rig.js import-key          read that record on stdin and install it
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
const { makeDurable, fsyncDir } = require('../lib/g7rig/durable');
const keyfile = require('../lib/g7rig/keyfile');
const { parseScan } = require('../lib/g7rig/scan');

const ENV_FILE = '/etc/lookout.env';
const NEW_SENSOR = '/usr/local/sbin/g7-new-sensor';
const FLEET_FLAG = '--no_auto_pair';
const SCAN_SECONDS = 70;
const STORAGE_KEYS = ['id', 'sensorName', 'sensorKey', 'glucoseHist', 'sensorSeen',
  'pairRequest', 'keyRejected', 'sensorStart', 'sessionLengthSeconds'];

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

// node-persist from Lookout's own node_modules, as g7-new-sensor does.
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
    throw fail('LOOKOUT_ARGS uses the medical slot (--force_medical_slot / --alternate); refusing', 3);
  }
};

const mustRun = async (io, cmd, args, what) => {
  const r = await io.exec(cmd, args);
  if (r.code !== 0) throw fail(`${what} failed: ${lastLine(r.stderr) || `exit ${r.code}`}`);
  return r;
};

const printJson = (io, obj) => io.stdout(`${JSON.stringify(obj)}\n`);

// Reading the journal costs a Pi Zero ~1.5 s of CPU, and the UI asks for a
// status every minute: keep the recent errors for ERRORS_TTL_MS in /run.
const ERRORS_TTL_MS = 5 * 60 * 1000;
const cacheDir = (io) => io.env.G7RIG_CACHE || '/run/g7-rig';

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

const commands = {
  status: async (io) => {
    const dir = await lookoutDir(io);
    const storage = await readItems((await openStorage(io, dir)).store);
    const [active, bt, errors] = await Promise.all([
      io.exec('systemctl', ['is-active', 'lookout']),
      io.exec('bluetoothctl', ['show']),
      recentErrorsCached(io),
    ]);
    printJson(io, status.build({
      storage,
      envText: readEnv(io),
      lookoutActive: active.code === 0 && active.stdout.trim() === 'active',
      btPowered: bt.code === 0 && /^\s*Powered:\s*yes\s*$/m.test(bt.stdout),
      now: io.now(),
      host: io.hostname(),
      uptimeS: io.uptime(),
      version: lookoutVersion(dir),
      errors,
    }));
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

  pair: async (io, [code, name]) => {
    const envText = readEnv(io, true);
    refuseMedical(envText);
    // fleet mode: after this pairing, never re-pair on its own (the key is shared)
    const fleetEnv = env.ensureFlag(envText, FLEET_FLAG);
    if (fleetEnv !== envText) writeEnv(io, fleetEnv);
    // g7-new-sensor: exact-name scan, pins --sensor_address, stores the code,
    // clears the old key and bond, restarts Lookout.
    const r = await io.exec(NEW_SENSOR, [code, name], {
      env: { ...process.env, SCAN_SECONDS: String(SCAN_SECONDS) },
      timeoutMs: (SCAN_SECONDS + 60) * 1000,
    });
    if (r.stdout || r.stderr) io.stderr(`${r.stdout}${r.stderr}`);
    if (r.code !== 0) throw fail(`g7-new-sensor failed: ${lastLine(r.stderr) || `exit ${r.code}`}`);
    const dir = await lookoutDir(io);
    const storage = await openStorage(io, dir);
    await writeItems(io, storage, { pairRequest: { code, name, at: io.now() }, sensorName: name }, ['keyRejected']);
    await mustRun(io, 'systemctl', ['restart', 'lookout'], 'restarting lookout');
    printJson(io, { ok: true });
  },

  'export-key': async (io) => {
    const dir = await lookoutDir(io);
    const storage = await readItems((await openStorage(io, dir)).store);
    // The only place the key is ever printed.
    printJson(io, keyfile.exportRecord({ storage, envText: readEnv(io) }));
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
    const nextEnv = env.ensureFlag(env.setSensorAddress(envText, record.address), FLEET_FLAG);

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
        sensorName: record.name,
      }, ['pairRequest', 'keyRejected']);
      writeEnv(io, nextEnv);
      // eslint-disable-next-line no-restricted-syntax
      for (const mac of addresses) await io.exec('bluetoothctl', ['remove', mac]); // eslint-disable-line no-await-in-loop
    } finally {
      await mustRun(io, 'systemctl', ['start', 'lookout'], 'starting lookout');
    }
    printJson(io, { ok: true });
  },
};

const run = async (argv, io) => {
  let parsed;
  try {
    parsed = parseRemote(argv.join(' '));
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
