/* global describe it beforeEach afterEach */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const persist = require('node-persist');
const should = require('should');

const { run } = require('../deploy/g7-rig');
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
    return { code: 0, stdout: '', stderr: '' };
  };
  return { exec, calls };
};

describe('g7-rig CLI', () => {
  let tmp;
  let io;
  let out;
  let err;

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
    };
  };

  beforeEach(async () => {
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
        central: '00:00:00:00:00:01',
      },
      last_reading: { time: '2026-11-10T11:55:00.000Z', glucose: 125, trend: 10 },
      last_heard: { time: '2026-11-10T11:59:30.000Z', rssi: -71 },
      pairing: { state: 'paired', since: null, error: null },
      errors: ['Error: sample failure'],
    });
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
      const b = fakeExec({ 'bluetoothctl show': show('B8:27:EB:00:00:0B') });
      io = makeIo('b', b.exec, record);
      (await run(['import-key'], io)).should.equal(0, err);
      fs.readFileSync(path.join(tmp, 'b', 'g7-central'), 'utf8').should.containEql('B8:27:EB:00:00:0A');
      const lines = b.calls.map((c) => c.line);
      const at = (l) => lines.indexOf(l);
      at('btmgmt --index 0 power off').should.be.above(-1);
      at('btmgmt --index 0 public-addr B8:27:EB:00:00:0A').should.be.above(at('btmgmt --index 0 power off'));
      at('systemctl restart bluetooth').should.be.above(at('btmgmt --index 0 public-addr B8:27:EB:00:00:0A'));
      at('systemctl start lookout').should.be.above(at('systemctl restart bluetooth'));
    });

    it('import-key leaves Bluetooth alone when the address already matches', async () => {
      io = makeIo('a', fakeExec({ 'bluetoothctl show': show('B8:27:EB:00:00:0A') }).exec);
      (await run(['export-key'], io)).should.equal(0, err);
      const record = out;
      const b = fakeExec({ 'bluetoothctl show': show('B8:27:EB:00:00:0A') });
      io = makeIo('b', b.exec, record);
      (await run(['import-key'], io)).should.equal(0, err);
      b.calls.filter((c) => c.line.startsWith('btmgmt')).should.eql([]);
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
    fs.readFileSync(envPath, 'utf8').should.equal(envFile('AA:BB:CC:DD:EE:FF').replace('--no_xdripaps', '--no_xdripaps --no_auto_pair'));
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
    (await run(['pair', '1234', 'DXCMab'], io)).should.equal(3);
    b.calls.map((c) => c.line).filter((l) => !l.startsWith('systemctl show') && !l.startsWith('findmnt') && l !== 'bluetoothctl show').should.eql([]);
  });

  it('pair runs g7-new-sensor, records the request and restarts Lookout', async () => {
    const b = fakeExec();
    io = makeIo('b', b.exec);
    (await run(['pair', '4321', 'DXCMcd'], io)).should.equal(0, err);
    JSON.parse(out).should.eql({ ok: true });
    const lines = b.calls.map((c) => c.line).filter((l) => !l.startsWith('systemctl show') && !l.startsWith('findmnt') && l !== 'bluetoothctl show');
    lines.should.eql(['/usr/local/sbin/g7-new-sensor 4321 DXCMcd', 'systemctl restart lookout']);
    const stored = await readStore(path.join(tmp, 'b', 'storage'), ['pairRequest', 'sensorName', 'keyRejected']);
    stored.should.eql({
      pairRequest: { code: '4321', name: 'DXCMcd', at: NOW },
      sensorName: 'DXCMcd',
      keyRejected: undefined,
    });
    fs.readFileSync(path.join(tmp, 'b', 'lookout.env'), 'utf8').should.containEql('--no_auto_pair');
  });

  it('pair reports a g7-new-sensor failure and records nothing', async () => {
    const b = fakeExec({
      '/usr/local/sbin/g7-new-sensor 4321 DXCMcd': { code: 1, stdout: 'scanning\n', stderr: 'g7-new-sensor: DXCMcd not seen\n' },
    });
    io = makeIo('b', b.exec);
    (await run(['pair', '4321', 'DXCMcd'], io)).should.equal(1);
    err.should.match(/DXCMcd not seen/);
    out.should.equal('');
    b.calls.map((c) => c.line).should.not.containEql('systemctl restart lookout');
    const stored = await readStore(path.join(tmp, 'b', 'storage'), ['sensorName']);
    stored.sensorName.should.equal('DXCMzz');
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
  });

  it('runs as a script: rejects a bad command with exit 2', () => {
    const r = spawnSync(process.execPath, [CLI, 'cat', '/etc/shadow'], { encoding: 'utf8' });
    r.status.should.equal(2);
  });
});
