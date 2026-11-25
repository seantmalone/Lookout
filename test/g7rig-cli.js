/* global describe it beforeEach afterEach */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const persist = require('node-persist');
const should = require('should');

const { run, defaultExec } = require('../deploy/g7-rig');
const { fingerprint } = require('../lib/g7rig/status');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'deploy', 'g7-rig.js');
const KEY = '00112233445566778899aabbccddeeff';
const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const MIN = 60 * 1000;

const envFile = (addr) => [
  'NIGHTSCOUT_HOST=https://ns.example.com',
  'API_SECRET=not-a-real-secret',
  `LOOKOUT_ARGS=--display_type watch --sensor_address ${addr} --no_xdripaps`,
  '',
].join('\n');

const openStore = async (dir) => {
  const store = persist.create({ dir, expiredInterval: false });
  await store.init();
  return store;
};

const seed = async (dir, items) => {
  const store = await openStore(dir);
  await Promise.all(Object.keys(items).map((k) => store.setItem(k, items[k])));
};

const readStore = async (dir, keys) => {
  const store = await openStore(dir);
  const out = {};
  await Promise.all(keys.map(async (k) => { out[k] = await store.getItem(k); }));
  return out;
};

// A fake for every external command; records what was run.
// What a read-only Pi Zero W collector shows (trimmed).
const PROC = {
  '/proc/loadavg': '0.93 0.71 0.55 1/123 4567\n',
  '/proc/meminfo': 'MemTotal:         437312 kB\nMemFree:          120344 kB\nMemAvailable:     262292 kB\n'
    + 'SwapTotal:             0 kB\nSwapFree:              0 kB\n',
  '/proc/mounts': '/dev/mmcblk0p2 /media/root-ro ext4 ro,relatime 0 0\ntmpfs-root /media/root-rw tmpfs rw,relatime 0 0\n'
    + 'overlayroot / overlay rw,relatime,lowerdir=/media/root-ro,upperdir=/media/root-rw/overlay 0 0\n',
};

const fakeExec = (overrides = {}) => {
  const calls = [];
  const exec = async (cmd, args = [], opts = {}) => {
    const line = [cmd, ...args].join(' ');
    calls.push({ line, opts });
    if (overrides[line]) return overrides[line];
    if (line === 'systemctl show lookout -p WorkingDirectory --value') return { code: 0, stdout: `${ROOT}\n`, stderr: '' };
    if (line === 'systemctl is-active lookout') return { code: 0, stdout: 'active\n', stderr: '' };
    if (line === 'bluetoothctl show') return { code: 0, stdout: 'Controller 00:00:00:00:00:01 (public)\n\tPowered: yes\n', stderr: '' };
    if (line.startsWith('findmnt -no OPTIONS')) return { code: 0, stdout: 'ro,relatime\n', stderr: '' };
    if (line.startsWith('journalctl')) return { code: 0, stdout: 'got glucose\nError: sample failure\nuploaded SGV\n', stderr: '' };
    if (line === 'vcgencmd get_throttled') return { code: 0, stdout: 'throttled=0x0\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  return { exec, calls };
};

describe('g7-rig CLI', () => {
  let tmp;
  let io;
  let out;
  let err;
  let procFiles;
  let statfsCalls;

  const makeIo = (name, exec, stdin = '') => {
    out = '';
    err = '';
    return {
      exec,
      env: {
        G7RIG_STORAGE: path.join(tmp, name, 'storage'),
        G7RIG_ENV: path.join(tmp, name, 'lookout.env'),
        G7RIG_CACHE: path.join(tmp, name, 'cache'),
        G7RIG_CENTRAL: path.join(tmp, name, 'g7-central'),
      },
      readStdin: async () => stdin,
      stdout: (s) => { out += s; },
      stderr: (s) => { err += s; },
      now: () => NOW,
      hostname: () => `rig-${name}`,
      uptime: () => 1234.5,
      getuid: () => 1000,
      readFile: (f) => {
        if (!(f in procFiles)) throw new Error(`ENOENT: ${f}`);
        return procFiles[f];
      },
      statfs: (f) => {
        statfsCalls.push(f);
        if (f !== '/media/root-rw') throw new Error(`ENOENT: ${f}`);
        return { bsize: 4096, blocks: 54784, bfree: 54374 };
      },
    };
  };

  beforeEach(async () => {
    procFiles = { ...PROC };
    statfsCalls = [];
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g7rig-cli-'));
    ['a', 'b'].forEach((n) => fs.mkdirSync(path.join(tmp, n, 'storage'), { recursive: true }));
    fs.writeFileSync(path.join(tmp, 'a', 'lookout.env'), envFile('AA:BB:CC:DD:EE:FF'), { mode: 0o600 });
    fs.writeFileSync(path.join(tmp, 'b', 'lookout.env'), envFile('11:22:33:44:55:66'), { mode: 0o600 });
    await seed(path.join(tmp, 'a', 'storage'), {
      id: '1234',
      sensorName: 'DXCMab',
      sensorKey: { key: KEY, address: 'AA:BB:CC:DD:EE:FF' },
      glucoseHist: [{
        readDateMills: NOW - 5 * MIN, glucose: 125, trend: 10, sessionStartDate: '2026-11-05T07:55:00.000Z',
      }],
      sensorSeen: { time: NOW - 30 * 1000, rssi: -71, address: 'AA:BB:CC:DD:EE:FF' },
    });
    await seed(path.join(tmp, 'b', 'storage'), {
      id: '9999',
      sensorName: 'DXCMzz',
      sensorKey: { key: 'ffeeddccbbaa99887766554433221100', address: '11:22:33:44:55:66' },
      keyRejected: { at: NOW - MIN },
      pairRequest: { code: '9999', name: 'DXCMzz', at: NOW - 20 * MIN },
    });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('status prints the status JSON, without the key', async () => {
    const { exec } = fakeExec();
    io = makeIo('a', exec);
    (await run(['status'], io)).should.equal(0, err);
    out.should.not.containEql(KEY);
    JSON.parse(out).should.eql({
      host: 'rig-a',
      version: '2.0.8',
      uptime_s: 1234,
      lookout_active: true,
      bluetooth_powered: true,
      sensor: {
        code: '1234',
        name: 'DXCMab',
        address: 'AA:BB:CC:DD:EE:FF',
        key_fingerprint: fingerprint(KEY),
        session_start: '2026-11-05T07:55:00.000Z',
        session_length_s: null,
        paired_at: null,
        central: '00:00:00:00:00:01',
      },
      last_reading: { time: '2026-11-10T11:55:00.000Z', glucose: 125, trend: 10 },
      last_heard: { time: '2026-11-10T11:59:30.000Z', rssi: -71 },
      pairing: { state: 'paired', since: null, error: null },
      errors: ['Error: sample failure'],
      health: {
        load1: 0.93,
        mem_total_kb: 437312,
        mem_available_kb: 262292,
        swap_total_kb: 0,
        swap_used_kb: 0,
        overlay_used_kb: 1640,
        overlay_total_kb: 219136,
        throttled: '0x0',
      },
    });
  });

  const NO_HEALTH = {
    load1: null,
    mem_total_kb: null,
    mem_available_kb: null,
    swap_total_kb: null,
    swap_used_kb: null,
    overlay_used_kb: null,
    overlay_total_kb: null,
    throttled: null,
  };

  it('status health: vcgencmd (time-limited) is the only extra command', async () => {
    const a = fakeExec();
    io = makeIo('a', a.exec);
    (await run(['status'], io)).should.equal(0, err);
    const v = a.calls.filter((c) => c.line.startsWith('vcgencmd'));
    v.map((c) => c.line).should.eql(['vcgencmd get_throttled']);
    v[0].opts.timeoutMs.should.be.belowOrEqual(10000);
    a.calls.map((c) => c.line.split(' ')[0]).should.not.containEql('df');
    statfsCalls.should.eql(['/media/root-rw']);
  });

  it('status health: overlay null when /media/root-rw is not mounted (card writable)', async () => {
    procFiles['/proc/mounts'] = '/dev/mmcblk0p2 / ext4 rw,noatime 0 0\n';
    io = makeIo('a', fakeExec().exec);
    (await run(['status'], io)).should.equal(0, err);
    const h = JSON.parse(out).health;
    should(h.overlay_used_kb).be.null();
    should(h.overlay_total_kb).be.null();
    h.mem_total_kb.should.equal(437312);
    statfsCalls.should.eql([]);
  });

  it('status health: throttled null when vcgencmd is missing or fails', async () => {
    io = makeIo('a', fakeExec({ 'vcgencmd get_throttled': { code: 127, stdout: '', stderr: 'not found' } }).exec);
    (await run(['status'], io)).should.equal(0, err);
    should(JSON.parse(out).health.throttled).be.null();
    io = makeIo('a', fakeExec({ 'vcgencmd get_throttled': { code: 255, stdout: 'throttled=0x0\n', stderr: 'VCHI failed' } }).exec);
    (await run(['status'], io)).should.equal(0, err);
    should(JSON.parse(out).health.throttled).be.null();
  });

  it('status health: nothing readable -> every field null, status still ok', async () => {
    procFiles = {};
    io = makeIo('a', fakeExec({ 'vcgencmd get_throttled': { code: 127, stdout: '', stderr: '' } }).exec);
    io.statfs = () => { throw new Error('EIO'); };
    (await run(['status'], io)).should.equal(0, err);
    const s = JSON.parse(out);
    s.health.should.eql(NO_HEALTH);
    s.uptime_s.should.equal(1234);
    s.sensor.code.should.equal('1234');
  });

  it('status health: a throwing reader does not fail status', async () => {
    io = makeIo('a', fakeExec().exec);
    io.readFile = () => { throw new Error('EIO'); };
    io.statfs = () => { throw new Error('EIO'); };
    (await run(['status'], io)).should.equal(0, err);
    JSON.parse(out).health.should.eql({ ...NO_HEALTH, throttled: '0x0' });
  });

  it('status degrades when systemd, BlueZ and the journal are unavailable', async () => {
    const missing = { code: 127, stdout: '', stderr: 'not found' };
    const { exec } = fakeExec({
      'systemctl show lookout -p WorkingDirectory --value': missing,
      'systemctl is-active lookout': { code: 3, stdout: 'inactive\n', stderr: '' },
      'bluetoothctl show': missing,
      'journalctl -u lookout -o cat -n 300 --no-pager': missing,
    });
    io = makeIo('a', exec);
    (await run(['status'], io)).should.equal(0, err);
    const s = JSON.parse(out);
    s.lookout_active.should.equal(false);
    s.bluetooth_powered.should.equal(false);
    s.errors.should.eql([]);
    should(s.version).be.null();
  });

  it('status reads the journal at most every 5 minutes (cached errors)', async () => {
    const a = fakeExec();
    io = makeIo('a', a.exec);
    (await run(['status'], io)).should.equal(0, err);
    (await run(['status'], io)).should.equal(0, err);
    JSON.parse(out.trim().split('\n').pop()).errors.should.eql(['Error: sample failure']);
    a.calls.filter((c) => c.line.startsWith('journalctl')).length.should.equal(1);

    io.now = () => NOW + 301 * 1000;
    (await run(['status'], io)).should.equal(0, err);
    a.calls.filter((c) => c.line.startsWith('journalctl')).length.should.equal(2);
  });

  it('persist does nothing when the card is not read-only', async () => {
    const a = fakeExec({ 'findmnt -no FSTYPE /': { code: 0, stdout: 'ext4\n', stderr: '' } });
    io = makeIo('a', a.exec);
    (await run(['persist'], io)).should.equal(0, err);
    JSON.parse(out).should.eql({ ok: true, readOnly: false, changed: 0 });
    a.calls.filter((c) => c.line.startsWith('mount')).should.eql([]);
  });

  it('persist copies the sensor items to the read-only card, then relocks it', async () => {
    const lower = path.join(tmp, 'card');
    const a = fakeExec({
      'findmnt -no FSTYPE /': { code: 0, stdout: 'overlay\n', stderr: '' },
      [`findmnt -no TARGET ${lower}`]: { code: 0, stdout: `${lower}\n`, stderr: '' },
    });
    io = makeIo('a', a.exec);
    io.env.G7RIG_LOWER = lower;
    (await run(['persist'], io)).should.equal(0, err);
    const res = JSON.parse(out);
    res.readOnly.should.equal(true);
    res.changed.should.be.above(0);
    const lines = a.calls.map((c) => c.line).filter((l) => l.startsWith('mount') || l === 'sync');
    lines.should.eql([`mount -o remount,rw ${lower}`, 'sync', `mount -o remount,ro ${lower}`]);
    const cardStorage = path.join(lower, tmp, 'a', 'storage');
    fs.readdirSync(cardStorage).length.should.be.above(0);

    // second run: nothing to write, the card is not unlocked at all
    const b = fakeExec({
      'findmnt -no FSTYPE /': { code: 0, stdout: 'overlay\n', stderr: '' },
      [`findmnt -no TARGET ${lower}`]: { code: 0, stdout: `${lower}\n`, stderr: '' },
    });
    io = makeIo('a', b.exec);
    io.env.G7RIG_LOWER = lower;
    (await run(['persist'], io)).should.equal(0, err);
    JSON.parse(out).changed.should.equal(0);
    b.calls.filter((c) => c.line.startsWith('mount')).should.eql([]);
  });

  it('persist retries the relock until the card is read-only again', async () => {
    const lower = path.join(tmp, 'card');
    let tries = 0;
    const a = fakeExec({
      'findmnt -no FSTYPE /': { code: 0, stdout: 'overlay\n', stderr: '' },
      [`findmnt -no TARGET ${lower}`]: { code: 0, stdout: `${lower}\n`, stderr: '' },
    });
    const exec = async (cmd, args = [], opts = {}) => {
      const line = [cmd, ...args].join(' ');
      if (line === `mount -o remount,ro ${lower}`) {
        tries += 1;
        a.calls.push({ line, opts });
        return tries < 3 ? { code: 32, stdout: '', stderr: 'mount point is busy' } : { code: 0, stdout: '', stderr: '' };
      }
      if (line === `findmnt -no OPTIONS ${lower}`) return { code: 0, stdout: tries >= 3 ? 'ro,relatime\n' : 'rw,relatime\n', stderr: '' };
      return a.exec(cmd, args, opts);
    };
    io = makeIo('a', exec);
    io.env.G7RIG_LOWER = lower;
    io.sleep = async () => {};
    (await run(['persist'], io)).should.equal(0, err);
    tries.should.equal(3);
  });

  it('persist drops the caches once when the relock keeps failing', async () => {
    const lower = path.join(tmp, 'card');
    let dropped = false;
    let tries = 0;
    const a = fakeExec({
      'findmnt -no FSTYPE /': { code: 0, stdout: 'overlay\n', stderr: '' },
      [`findmnt -no TARGET ${lower}`]: { code: 0, stdout: `${lower}\n`, stderr: '' },
    });
    const exec = async (cmd, args = [], opts = {}) => {
      const line = [cmd, ...args].join(' ');
      if (line === 'sh -c echo 2 > /proc/sys/vm/drop_caches') {
        a.calls.push({ line, opts });
        dropped = true;
        return { code: 0, stdout: '', stderr: '' };
      }
      if (line === `mount -o remount,ro ${lower}`) {
        tries += 1;
        a.calls.push({ line, opts });
        return dropped ? { code: 0, stdout: '', stderr: '' } : { code: 32, stdout: '', stderr: 'mount point is busy' };
      }
      if (line === `findmnt -no OPTIONS ${lower}`) return { code: 0, stdout: dropped ? 'ro,relatime\n' : 'rw,relatime\n', stderr: '' };
      return a.exec(cmd, args, opts);
    };
    io = makeIo('a', exec);
    io.env.G7RIG_LOWER = lower;
    io.sleep = async () => {};
    (await run(['persist'], io)).should.equal(0, err);
    tries.should.equal(6);
    a.calls.filter((c) => c.line.includes('drop_caches')).length.should.equal(1);
  });

  it('persist fails loudly if the card cannot be relocked', async () => {
    const lower = path.join(tmp, 'card');
    const a = fakeExec({
      'findmnt -no FSTYPE /': { code: 0, stdout: 'overlay\n', stderr: '' },
      [`findmnt -no TARGET ${lower}`]: { code: 0, stdout: `${lower}\n`, stderr: '' },
      [`mount -o remount,ro ${lower}`]: { code: 32, stdout: '', stderr: 'mount point is busy' },
      [`findmnt -no OPTIONS ${lower}`]: { code: 0, stdout: 'rw,relatime\n', stderr: '' },
    });
    io = makeIo('a', a.exec);
    io.env.G7RIG_LOWER = lower;
    io.sleep = async () => {};
    (await run(['persist'], io)).should.not.equal(0);
    err.should.match(/still writable/);
  });

  it('persist relocks the card even when copying fails', async () => {
    const lower = path.join(tmp, 'card');
    fs.writeFileSync(path.join(tmp, 'card-is-a-file'), 'x');
    const a = fakeExec({
      'findmnt -no FSTYPE /': { code: 0, stdout: 'overlay\n', stderr: '' },
      [`findmnt -no TARGET ${path.join(tmp, 'card-is-a-file')}`]: { code: 0, stdout: 'x\n', stderr: '' },
    });
    io = makeIo('a', a.exec);
    io.env.G7RIG_LOWER = path.join(tmp, 'card-is-a-file');
    (await run(['persist'], io)).should.not.equal(0);
    a.calls.map((c) => c.line).filter((l) => l.startsWith('mount')).pop()
      .should.equal(`mount -o remount,ro ${path.join(tmp, 'card-is-a-file')}`);
    should(lower).be.ok();
  });

  describe('bt-watchdog (local only: g7-bt-watchdog.timer)', () => {
    const ADVERTS = '> HCI Event: LE Meta Event (0x3e) plen 43\n      LE Advertising Report (0x02)\n';
    const showDiscovering = {
      code: 0, stdout: 'Controller 00:00:00:00:00:01 (public)\n\tPowered: yes\n\tDiscovering: yes\n', stderr: '',
    };
    const sample = (stdout) => ({ code: 124, stdout, stderr: '' }); // timeout(1) ends btmon: exit 124
    let apply;

    const watchIo = (overrides = {}) => {
      const a = fakeExec({
        'systemctl is-active bluetooth': { code: 0, stdout: 'active\n', stderr: '' },
        'bluetoothctl show': showDiscovering,
        'timeout 10 btmon': sample(''),
        ...overrides,
      });
      io = makeIo('a', a.exec);
      io.env.G7RIG_CENTRAL_APPLY = apply;
      return a;
    };
    const lines = (a) => a.calls.map((c) => c.line);
    const restarts = (a) => lines(a).filter((l) => l === 'systemctl restart bluetooth');

    beforeEach(() => {
      apply = path.join(tmp, 'g7-central-apply');
      fs.writeFileSync(apply, '#!/bin/sh\n', { mode: 0o755 });
    });

    it('samples btmon for 10 s under timeout(1), with no terminal wrapper', async () => {
      const a = watchIo({ 'timeout 10 btmon': sample(ADVERTS) });
      (await run(['bt-watchdog'], io)).should.equal(0, err);
      const call = a.calls.find((c) => c.line === 'timeout 10 btmon');
      should(call).be.ok();
      call.opts.timeoutMs.should.be.above(10000);
      lines(a).filter((l) => l.startsWith('script')).should.eql([]);
      restarts(a).should.eql([]);
      out.should.equal('');
    });

    it('restarts Bluetooth after 3 empty samples in a row, then re-applies the fleet address', async () => {
      const a = watchIo();
      (await run(['bt-watchdog'], io)).should.equal(0, err);
      (await run(['bt-watchdog'], io)).should.equal(0, err);
      restarts(a).should.eql([]);
      (await run(['bt-watchdog'], io)).should.equal(0, err);
      out.should.match(/no advertisements heard.*restarting bluetooth/);
      out.trim().split('\n').filter((l) => /restarting bluetooth/.test(l)).length.should.equal(1);
      const seq = lines(a);
      const r = seq.indexOf('systemctl restart bluetooth');
      r.should.be.above(-1);
      seq.indexOf(apply).should.be.above(r);
      restarts(a).length.should.equal(1);
    });

    it('a heard advertisement resets the count', async () => {
      const a = watchIo();
      await run(['bt-watchdog'], io);
      await run(['bt-watchdog'], io);
      const b = watchIo({ 'timeout 10 btmon': sample(ADVERTS) });
      await run(['bt-watchdog'], io);
      const c = watchIo();
      await run(['bt-watchdog'], io);
      await run(['bt-watchdog'], io);
      [a, b, c].forEach((x) => restarts(x).should.eql([]));
    });

    it('restarts at most once an hour', async () => {
      const a = watchIo();
      for (let i = 0; i < 6; i += 1) (await run(['bt-watchdog'], io)).should.equal(0, err); // eslint-disable-line no-await-in-loop
      restarts(a).length.should.equal(1);
      io.now = () => NOW + 61 * MIN;
      (await run(['bt-watchdog'], io)).should.equal(0, err);
      restarts(a).length.should.equal(2);
    });

    it('does not sample or act while bluetooth.service is not active', async () => {
      const a = watchIo({ 'systemctl is-active bluetooth': { code: 3, stdout: 'inactive\n', stderr: '' } });
      for (let i = 0; i < 4; i += 1) await run(['bt-watchdog'], io); // eslint-disable-line no-await-in-loop
      lines(a).filter((l) => l.includes('btmon')).should.eql([]);
      restarts(a).should.eql([]);
    });

    it('does not sample or act when the adapter is off or not discovering', async () => {
      const off = watchIo({ 'bluetoothctl show': { code: 0, stdout: 'Controller 00:00:00:00:00:01 (public)\n\tPowered: no\n\tDiscovering: yes\n', stderr: '' } });
      for (let i = 0; i < 4; i += 1) await run(['bt-watchdog'], io); // eslint-disable-line no-await-in-loop
      const idle = watchIo({ 'bluetoothctl show': { code: 0, stdout: 'Controller 00:00:00:00:00:01 (public)\n\tPowered: yes\n\tDiscovering: no\n', stderr: '' } });
      for (let i = 0; i < 4; i += 1) await run(['bt-watchdog'], io); // eslint-disable-line no-await-in-loop
      [off, idle].forEach((x) => {
        lines(x).filter((l) => l.includes('btmon')).should.eql([]);
        restarts(x).should.eql([]);
      });
    });

    it('a failed sample (btmon missing) is not counted as silence', async () => {
      const a = watchIo({ 'timeout 10 btmon': { code: 127, stdout: '', stderr: 'timeout: failed to run command btmon' } });
      for (let i = 0; i < 4; i += 1) (await run(['bt-watchdog'], io)).should.equal(0, err); // eslint-disable-line no-await-in-loop
      restarts(a).should.eql([]);
    });

    it('skips the address step when g7-central-apply is not installed', async () => {
      apply = path.join(tmp, 'not-installed');
      const a = watchIo();
      for (let i = 0; i < 3; i += 1) await run(['bt-watchdog'], io); // eslint-disable-line no-await-in-loop
      restarts(a).length.should.equal(1);
      lines(a).filter((l) => l.includes('central')).should.eql([]);
    });

    it('fails loudly (exit 1) if the restart fails, and still waits an hour before the next', async () => {
      const a = watchIo({ 'systemctl restart bluetooth': { code: 1, stdout: '', stderr: 'Job failed' } });
      for (let i = 0; i < 3; i += 1) await run(['bt-watchdog'], io); // eslint-disable-line no-await-in-loop
      err.should.match(/restarting bluetooth failed/);
      for (let i = 0; i < 3; i += 1) await run(['bt-watchdog'], io); // eslint-disable-line no-await-in-loop
      restarts(a).length.should.equal(1);
    });

    it('is not reachable through the remote wrapper rules', async () => {
      const a = watchIo();
      (await run(['bt-watchdog', 'now'], io)).should.equal(2);
      a.calls.should.eql([]);
    });
  });

  describe('the central Bluetooth address (the sensor only accepts the key from it)', () => {
    const show = (mac) => ({ code: 0, stdout: `Controller ${mac} (public)\n\tPowered: yes\n`, stderr: '' });

    it('status reports the adapter address as sensor.central', async () => {
      io = makeIo('a', fakeExec({ 'bluetoothctl show': show('B8:27:EB:00:00:0A') }).exec);
      (await run(['status'], io)).should.equal(0, err);
      JSON.parse(out).sensor.central.should.equal('B8:27:EB:00:00:0A');
    });

    it('export-key includes the adapter address when none is configured', async () => {
      io = makeIo('a', fakeExec({ 'bluetoothctl show': show('B8:27:EB:00:00:0A') }).exec);
      (await run(['export-key'], io)).should.equal(0, err);
      JSON.parse(out).central.should.equal('B8:27:EB:00:00:0A');
    });

    it('export-key exports the address the adapter presents, not a stale file', async () => {
      fs.writeFileSync(path.join(tmp, 'a', 'g7-central'), 'B8:27:EB:00:00:0C\n');
      io = makeIo('a', fakeExec({ 'bluetoothctl show': show('B8:27:EB:00:00:0A') }).exec);
      (await run(['export-key'], io)).should.equal(0, err);
      JSON.parse(out).central.should.equal('B8:27:EB:00:00:0A');
    });

    it('export-key falls back to the configured address when Bluetooth cannot be asked', async () => {
      fs.writeFileSync(path.join(tmp, 'a', 'g7-central'), 'B8:27:EB:00:00:0C\n');
      io = makeIo('a', fakeExec({ 'bluetoothctl show': { code: 1, stdout: '', stderr: 'no controller' } }).exec);
      (await run(['export-key'], io)).should.equal(0, err);
      JSON.parse(out).central.should.equal('B8:27:EB:00:00:0C');
    });

    it('import-key adopts another central address and applies it before Lookout starts', async () => {
      io = makeIo('a', fakeExec({ 'bluetoothctl show': show('B8:27:EB:00:00:0A') }).exec);
      (await run(['export-key'], io)).should.equal(0, err);
      const record = out;
      // a fake adapter: reports the new address once public-addr ran
      let addr = 'B8:27:EB:00:00:0B';
      const b = fakeExec();
      const exec = async (cmd, args = [], opts = {}) => {
        const line = [cmd, ...args].join(' ');
        if (line === 'bluetoothctl show') {
          b.calls.push({ line, opts });
          return show(addr);
        }
        const m = / public-addr ([0-9A-F:]{17}) /.exec(` ${line} `);
        if (m) [, addr] = m;
        return b.exec(cmd, args, opts);
      };
      io = makeIo('b', exec, record);
      (await run(['import-key'], io)).should.equal(0, err);
      fs.readFileSync(path.join(tmp, 'b', 'g7-central'), 'utf8').should.containEql('B8:27:EB:00:00:0A');
      const lines = b.calls.map((c) => c.line);
      // btmgmt hangs without a terminal (as under sudo/ssh/systemd): it runs inside script(1)
      const at = (l) => lines.findIndex((x) => x === `script -qec ${l} /dev/null`);
      at('btmgmt --index 0 power off').should.be.above(-1);
      at('btmgmt --index 0 public-addr B8:27:EB:00:00:0A').should.be.above(at('btmgmt --index 0 power off'));
      lines.indexOf('systemctl restart bluetooth').should.be.above(at('btmgmt --index 0 public-addr B8:27:EB:00:00:0A'));
      lines.indexOf('systemctl start lookout').should.be.above(lines.indexOf('systemctl restart bluetooth'));
      lines.filter((l) => l.startsWith('btmgmt')).should.eql([]); // never bare
      b.calls.filter((c) => c.line.startsWith('script')).forEach((c) => c.opts.timeoutMs.should.be.below(60000));
    });

    it('import-key fails loudly if the adapter keeps its old address', async () => {
      io = makeIo('a', fakeExec({ 'bluetoothctl show': show('B8:27:EB:00:00:0A') }).exec);
      (await run(['export-key'], io)).should.equal(0, err);
      const record = out;
      const b = fakeExec({ 'bluetoothctl show': show('B8:27:EB:00:00:0B') });
      io = makeIo('b', b.exec, record);
      (await run(['import-key'], io)).should.not.equal(0);
      err.should.match(/could not set the Bluetooth address/);
      b.calls.map((c) => c.line).should.containEql('systemctl start lookout'); // Lookout still restarted
    });

    it('import-key leaves Bluetooth alone when the address already matches', async () => {
      io = makeIo('a', fakeExec({ 'bluetoothctl show': show('B8:27:EB:00:00:0A') }).exec);
      (await run(['export-key'], io)).should.equal(0, err);
      const record = out;
      const b = fakeExec({ 'bluetoothctl show': show('B8:27:EB:00:00:0A') });
      io = makeIo('b', b.exec, record);
      (await run(['import-key'], io)).should.equal(0, err);
      b.calls.filter((c) => c.line.includes('btmgmt')).should.eql([]);
    });
  });

  it('export-key then import-key copies the key to another collector', async () => {
    const a = fakeExec();
    io = makeIo('a', a.exec);
    (await run(['export-key'], io)).should.equal(0, err);
    const record = JSON.parse(out);
    record.should.eql({
      code: '1234', name: 'DXCMab', address: 'AA:BB:CC:DD:EE:FF', key: KEY, central: '00:00:00:00:00:01',
    });

    const b = fakeExec();
    io = makeIo('b', b.exec, JSON.stringify(record));
    (await run(['import-key'], io)).should.equal(0, err);
    JSON.parse(out).should.eql({ ok: true });
    out.should.not.containEql(KEY);
    err.should.not.containEql(KEY);

    b.calls.map((c) => c.line).filter((l) => !l.startsWith('systemctl show') && !l.startsWith('findmnt') && l !== 'bluetoothctl show').should.eql([
      'systemctl stop lookout',
      'bluetoothctl remove 11:22:33:44:55:66',
      'bluetoothctl remove AA:BB:CC:DD:EE:FF',
      'systemctl start lookout',
    ]);
    b.calls.forEach((c) => c.line.should.not.containEql(KEY));

    const stored = await readStore(path.join(tmp, 'b', 'storage'), ['id', 'sensorKey', 'sensorName', 'pairRequest', 'keyRejected']);
    stored.should.eql({
      id: '1234',
      sensorKey: { key: KEY, address: 'AA:BB:CC:DD:EE:FF' },
      sensorName: 'DXCMab',
      pairRequest: undefined,
      keyRejected: undefined,
    });

    const envPath = path.join(tmp, 'b', 'lookout.env');
    // fleet mode is switched on by import-key
    fs.readFileSync(envPath, 'utf8').should.equal(envFile('AA:BB:CC:DD:EE:FF').replace(' --sensor_address AA:BB:CC:DD:EE:FF', '').replace('--no_xdripaps', '--no_xdripaps --no_auto_pair --no_reboot'));
    (fs.statSync(envPath).mode & 0o777).should.equal(0o600); // eslint-disable-line no-bitwise
    fs.readdirSync(path.join(tmp, 'b')).sort().should.eql(['g7-central', 'lookout.env', 'storage']);

    // b now reports the same sensor as a
    io = makeIo('b', fakeExec().exec);
    (await run(['status'], io)).should.equal(0, err);
    const s = JSON.parse(out);
    s.sensor.key_fingerprint.should.equal(fingerprint(KEY));
    s.sensor.address.should.equal('AA:BB:CC:DD:EE:FF');
    s.pairing.state.should.equal('paired');

    io = makeIo('b', fakeExec().exec);
    (await run(['export-key'], io)).should.equal(0, err);
    JSON.parse(out).should.eql(record);
  });

  describe('the stored pairing time (pairedAt)', () => {
    const PAIRED = NOW - 3 * 60 * MIN;
    const PAIRED_ISO = new Date(PAIRED).toISOString();

    it('status reports paired_at as an ISO time when storage has pairedAt', async () => {
      await seed(path.join(tmp, 'a', 'storage'), { pairedAt: PAIRED });
      io = makeIo('a', fakeExec().exec);
      (await run(['status'], io)).should.equal(0, err);
      JSON.parse(out).sensor.paired_at.should.equal(PAIRED_ISO);
    });

    it('status reports paired_at as null when storage has none', async () => {
      io = makeIo('a', fakeExec().exec);
      (await run(['status'], io)).should.equal(0, err);
      should(JSON.parse(out).sensor.paired_at).be.null();
    });

    it('export-key includes paired_at, and import-key carries it to the other collector', async () => {
      await seed(path.join(tmp, 'a', 'storage'), { pairedAt: PAIRED });
      io = makeIo('a', fakeExec().exec);
      (await run(['export-key'], io)).should.equal(0, err);
      const record = JSON.parse(out);
      record.paired_at.should.equal(PAIRED_ISO);

      io = makeIo('b', fakeExec().exec, JSON.stringify(record));
      (await run(['import-key'], io)).should.equal(0, err);
      (await readStore(path.join(tmp, 'b', 'storage'), ['pairedAt'])).pairedAt.should.equal(PAIRED);

      io = makeIo('b', fakeExec().exec);
      (await run(['status'], io)).should.equal(0, err);
      JSON.parse(out).sensor.paired_at.should.equal(PAIRED_ISO);
    });
  });

  it('import-key keeps Lookout running when the record is bad, without echoing it', async () => {
    const b = fakeExec();
    io = makeIo('b', b.exec, `{"code":"12","name":"DXCMab","address":"AA:BB:CC:DD:EE:FF","key":"${KEY}"}`);
    (await run(['import-key'], io)).should.equal(1);
    err.should.match(/bad code/);
    err.should.not.containEql(KEY);
    b.calls.map((c) => c.line).should.not.containEql('systemctl stop lookout');

    io = makeIo('b', b.exec, `not json ${KEY}`);
    (await run(['import-key'], io)).should.equal(1);
    err.should.not.containEql(KEY);
  });

  it('import-key and pair refuse the medical slot (exit 3)', async () => {
    fs.writeFileSync(path.join(tmp, 'b', 'lookout.env'), 'LOOKOUT_ARGS=--force_medical_slot --display_type medical\n');
    const record = {
      code: '1234', name: 'DXCMab', address: 'AA:BB:CC:DD:EE:FF', key: KEY,
    };
    const b = fakeExec();
    io = makeIo('b', b.exec, JSON.stringify(record));
    (await run(['import-key'], io)).should.equal(3);
    err.should.match(/medical/);
    io = makeIo('b', b.exec);
    (await run(['pair', '1234'], io)).should.equal(3);
    b.calls.map((c) => c.line).filter((l) => !l.startsWith('systemctl show') && !l.startsWith('findmnt') && l !== 'bluetoothctl show').should.eql([]);
  });

  it('pair sets the code, clears the old sensor and lets Lookout find the new one', async () => {
    const b = fakeExec();
    io = makeIo('b', b.exec);
    (await run(['pair', '4321'], io)).should.equal(0, err);
    JSON.parse(out).should.eql({ ok: true });
    const lines = b.calls.map((c) => c.line).filter((l) => !l.startsWith('systemctl show') && !l.startsWith('findmnt') && l !== 'bluetoothctl show');
    // no scan and no separate tool: what `lookout id` does, plus the pair request
    lines.should.eql(['systemctl stop lookout', 'bluetoothctl remove 11:22:33:44:55:66', 'systemctl start lookout']);
    const stored = await readStore(path.join(tmp, 'b', 'storage'), ['id', 'sensorKey', 'sensorName', 'pairRequest', 'keyRejected', 'pairedAt',
      'g5Calibration', 'expiredCal', 'bgChecks']);
    stored.id.should.equal('4321');
    should(stored.sensorKey).not.be.ok(); // the old key is gone
    should(stored.sensorName).not.be.ok(); // learned from the new sensor
    stored.pairRequest.should.eql({ code: '4321', at: NOW });
    should(stored.keyRejected).not.be.ok();
    should(stored.pairedAt).not.be.ok();
    stored.g5Calibration.type.should.equal('Unity'); // calibration reset, as `lookout id` does
    should(stored.expiredCal).not.be.ok();
    should(stored.bgChecks).not.be.ok();
    const fleetEnv = fs.readFileSync(path.join(tmp, 'b', 'lookout.env'), 'utf8');
    fleetEnv.should.containEql('--no_auto_pair');
    fleetEnv.should.containEql('--no_reboot'); // fleet collectors never reboot on missed reads
    fleetEnv.should.not.containEql('--sensor_address'); // no pin: Lookout latches after authenticating
    fleetEnv.should.containEql('--display_type watch');
  });

  it('pair still starts Lookout when something fails half way', async () => {
    const b = fakeExec({ 'bluetoothctl remove 11:22:33:44:55:66': { code: 1, stdout: '', stderr: 'not available' } });
    io = makeIo('b', b.exec);
    (await run(['pair', '4321'], io)).should.equal(0, err);
    b.calls.map((c) => c.line).should.containEql('systemctl start lookout');
  });

  it('scan prints what bluetoothctl heard for exactly that name', async () => {
    const b = fakeExec({
      'bluetoothctl --timeout 70 scan le': { code: 0, stdout: '[NEW] Device AA:BB:CC:DD:EE:FF DXCMab\n[CHG] Device AA:BB:CC:DD:EE:FF RSSI: 0xffffffb9 (-71)\n', stderr: '' },
      'bluetoothctl devices': { code: 0, stdout: 'Device AA:BB:CC:DD:EE:FF DXCMab\n', stderr: '' },
    });
    io = makeIo('b', b.exec);
    (await run(['scan', 'DXCMab'], io)).should.equal(0, err);
    JSON.parse(out).should.eql({ heard: true, rssi: -71, address: 'AA:BB:CC:DD:EE:FF' });
  });

  it('rejects anything parseRemote rejects (exit 2)', async () => {
    const b = fakeExec();
    io = makeIo('b', b.exec);
    (await run(['status;', 'id'], io)).should.equal(2);
    (await run([], io)).should.equal(2);
    (await run(['pair', '12345', 'DXCMab'], io)).should.equal(2);
    b.calls.should.eql([]);
  });

  it('runs as a script: status against a temp storage dir with no systemd on PATH', () => {
    const r = spawnSync(process.execPath, [CLI, 'status'], {
      env: {
        PATH: path.join(tmp, 'a'),
        G7RIG_STORAGE: path.join(tmp, 'a', 'storage'),
        G7RIG_ENV: path.join(tmp, 'a', 'lookout.env'),
      },
      encoding: 'utf8',
    });
    r.status.should.equal(0, r.stderr);
    r.stdout.should.not.containEql(KEY);
    const s = JSON.parse(r.stdout);
    s.sensor.key_fingerprint.should.equal(fingerprint(KEY));
    s.lookout_active.should.equal(false);
    // the real readers: every health field present (null where this machine has no /proc etc.)
    Object.keys(s.health).should.eql(['load1', 'mem_total_kb', 'mem_available_kb', 'swap_total_kb',
      'swap_used_kb', 'overlay_used_kb', 'overlay_total_kb', 'throttled']);
  });

  it('runs as a script: rejects a bad command with exit 2', () => {
    const r = spawnSync(process.execPath, [CLI, 'cat', '/etc/shadow'], { encoding: 'utf8' });
    r.status.should.equal(2);
  });
});

describe('g7-rig exec (time limits on helpers)', () => {
  it('runs a command and reports its exit code and output', async () => {
    const r = await defaultExec('sh', ['-c', 'echo hi; echo err >&2; exit 3'], { timeoutMs: 5000 });
    r.should.eql({
      code: 3, stdout: 'hi\n', stderr: 'err\n', timedOut: false,
    });
  });

  it('kills a command that runs past its limit: exit 124, timedOut, the output so far', async () => {
    const t0 = Date.now();
    const r = await defaultExec('sh', ['-c', 'echo partial; exec sleep 5'], { timeoutMs: 200 });
    (Date.now() - t0).should.be.below(2000);
    r.code.should.equal(124);
    r.timedOut.should.equal(true);
    r.stdout.should.equal('partial\n');
  });

  it('returns at the limit even when a grandchild still holds the output open', async () => {
    // the killed shell leaves `sleep` behind with its stdout: "close" would wait for it
    const t0 = Date.now();
    const r = await defaultExec('sh', ['-c', 'sleep 3 & wait'], { timeoutMs: 200 });
    (Date.now() - t0).should.be.below(1500);
    r.timedOut.should.equal(true);
  });

  it('a missing command is exit 127, not a time-out', async () => {
    const r = await defaultExec('no-such-command-g7rig', [], { timeoutMs: 5000 });
    r.code.should.equal(127);
    r.timedOut.should.equal(false);
  });
});
