/* global describe it before after beforeEach afterEach */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
require('should');

const SCRIPT = path.join(__dirname, '..', 'deploy', 'g7-netwatch.sh');

// /bin/sh, plus dash (the Pi's /bin/sh) when this machine has it.
const SHELLS = ['/bin/sh', '/bin/dash', '/usr/bin/dash'].filter((s) => fs.existsSync(s));

const GW = '10.0.0.1';

// Every external command g7-netwatch runs is a stub here (PATH is only the
// stub directory plus a real mkdir); each records its arguments in calls.log.
// ping answers unless PING_RC says otherwise.
const STUBS = {
  ip: `echo "default via ${GW} dev wlan0 proto dhcp src 10.0.0.9 metric 600"`,
  ping: 'exit ${PING_RC:-0}', // eslint-disable-line no-template-curly-in-string
  logger: 'exit 0',
  journalctl: 'exit 0',
  systemctl: 'exit 0',
};

// eslint-disable-next-line func-names, prefer-arrow-callback
SHELLS.forEach((shell) => describe(`g7-netwatch.sh (network watchdog) under ${shell}`, function () {
  this.timeout(60000); // up to 60 runs of a shell and its stubs per test
  let base;
  let tmp;
  let log;
  let state;

  const writeStub = (dir, name, body) => {
    fs.writeFileSync(
      path.join(dir, name),
      `#!/bin/sh\necho "${name} $*" >> "$G7_TEST_LOG"\n${body}\n`,
      { mode: 0o755 },
    );
  };
  const stub = (name, body) => writeStub(tmp, name, body);

  before(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'g7-netwatch-base-'));
    Object.keys(STUBS).forEach((n) => writeStub(base, n, STUBS[n]));
    const mkdir = spawnSync('/bin/sh', ['-c', 'command -v mkdir'], { encoding: 'utf8' }).stdout.trim();
    fs.symlinkSync(mkdir, path.join(base, 'mkdir'));
  });

  after(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g7-netwatch-'));
    log = path.join(tmp, 'calls.log');
    state = path.join(tmp, 'state'); // not there yet: the script creates it
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // One run (one minute of the timer); calls are this run's only.
  const run = (args = [], env = {}) => {
    if (fs.existsSync(log)) fs.unlinkSync(log);
    const r = spawnSync(shell, [SCRIPT, ...args], {
      env: {
        PATH: `${tmp}:${base}`, G7_TEST_LOG: log, G7_NETWATCH_STATE_DIR: state, ...env,
      },
      encoding: 'utf8',
      timeout: 10000,
    });
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
    return { ...r, calls };
  };
  const up = (args) => run(args);
  const down = (args) => run(args, { PING_RC: '1' });
  // n runs with the gateway not answering; the calls of each run
  const downFor = (n, args) => Array.from({ length: n }, () => down(args));
  const of = (calls, cmd) => calls.filter((l) => l.split(' ')[0] === cmd);
  const logged = (runs) => [].concat(...runs.map((r) => of(r.calls, 'logger')));
  const rebootCalls = (runs) => [].concat(...runs.map((r) => of(r.calls, 'systemctl')));

  it('is executable', () => {
    (fs.statSync(SCRIPT).mode & 0o111).should.not.equal(0); // eslint-disable-line no-bitwise
  });

  it('gateway answers: pings it twice with a 3 s wait, logs nothing, reboots nothing', () => {
    const r = up();
    r.status.should.equal(0, r.stdout + r.stderr);
    of(r.calls, 'ping').should.eql([`ping -c 2 -W 3 ${GW}`]);
    of(r.calls, 'logger').should.eql([]);
    of(r.calls, 'systemctl').should.eql([]);
    r.stdout.should.equal('');
    // and again: still silent
    of(up().calls, 'logger').should.eql([]);
  });

  it('network up earlier this boot, then down for 9 minutes: no reboot; logs at minute 1 and 5', () => {
    up();
    const runs = downFor(9);
    runs.forEach((r) => r.status.should.equal(0, r.stdout + r.stderr));
    rebootCalls(runs).should.eql([]);
    const lines = logged(runs);
    lines.length.should.equal(2);
    lines[0].should.equal(`logger -t g7-netwatch network down: gateway ${GW} does not answer; rebooting if still down after 10 min`);
    lines[1].should.equal(`logger -t g7-netwatch network still down after 5 min: gateway ${GW} does not answer`);
    of(runs[0].calls, 'logger').length.should.equal(1); // the first minute down
    of(runs[4].calls, 'logger').length.should.equal(1); // the fifth
  });

  it('the 10th minute down after having been up: one clear line, journal synced, systemctl reboot once', () => {
    up();
    downFor(9);
    const r = down();
    r.status.should.equal(0, r.stdout + r.stderr);
    of(r.calls, 'logger').should.eql(['logger -t g7-netwatch network down for 10 min after working earlier this boot: rebooting']);
    of(r.calls, 'systemctl').should.eql(['systemctl reboot']);
    const iSync = r.calls.indexOf('journalctl --sync');
    iSync.should.be.above(r.calls.indexOf(of(r.calls, 'logger')[0]));
    r.calls.indexOf('systemctl reboot').should.be.above(iSync);
  });

  it('never up since boot: no reboot at 10 min; one at 60 min; a line every 5 min meanwhile', () => {
    const runs = downFor(59);
    rebootCalls(runs).should.eql([]);
    const lines = logged(runs);
    lines[0].should.equal(`logger -t g7-netwatch network down: gateway ${GW} does not answer; no network yet since boot, rebooting if still down after 60 min`);
    lines.slice(1).should.eql([5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]
      .map((n) => `logger -t g7-netwatch network still down after ${n} min: gateway ${GW} does not answer`));
    const r = down();
    of(r.calls, 'logger').should.eql(['logger -t g7-netwatch no network for 60 min since boot: rebooting']);
    of(r.calls, 'systemctl').should.eql(['systemctl reboot']);
    r.calls.should.containEql('journalctl --sync');
  });

  it('recovery: logs how long it was down, then counts from zero again', () => {
    up();
    downFor(7);
    const back = up();
    of(back.calls, 'logger').should.eql([`logger -t g7-netwatch network back after 7 min down (gateway ${GW} answers)`]);
    of(up().calls, 'logger').should.eql([]); // reset: silent again
    // a new outage starts at minute 1 and still needs 10 minutes (up since boot)
    const runs = downFor(9);
    rebootCalls(runs).should.eql([]);
    logged(runs)[0].should.match(/^logger -t g7-netwatch network down: .*after 10 min$/);
    of(down().calls, 'systemctl').should.eql(['systemctl reboot']);
  });

  it('recovery before it was ever up also counts as up since boot from then on', () => {
    downFor(30);
    of(up().calls, 'logger').should.eql([`logger -t g7-netwatch network back after 30 min down (gateway ${GW} answers)`]);
    downFor(9);
    of(down().calls, 'systemctl').should.eql(['systemctl reboot']);
  });

  it('no default route counts as down (and ping is not run)', () => {
    stub('ip', 'exit 0');
    const r = run();
    of(r.calls, 'ping').should.eql([]);
    of(r.calls, 'logger').should.eql(['logger -t g7-netwatch network down: no default route; no network yet since boot, rebooting if still down after 60 min']);
    stub('ip', STUBS.ip);
    up(); // network up
    stub('ip', 'exit 0');
    const runs = Array.from({ length: 10 }, () => run());
    logged(runs)[1].should.equal('logger -t g7-netwatch network still down after 5 min: no default route');
    rebootCalls(runs).should.eql(['systemctl reboot']);
  });

  it('reads the gateway from the "via" of the first default route', () => {
    stub('ip', `echo "default via 192.168.7.1 dev wlan0 proto dhcp metric 600"
echo "default via 10.9.9.9 dev eth0 metric 700"`);
    of(run().calls, 'ping').should.eql(['ping -c 2 -W 3 192.168.7.1']);
    of(run().calls, 'ip').should.eql(['ip route show default']);
  });

  it('--dry-run never reboots: prints what it would do, no logger, no journalctl, no systemctl', () => {
    const ok = up(['--dry-run']);
    ok.status.should.equal(0, ok.stdout + ok.stderr);
    ok.stdout.should.match(new RegExp(`network OK: gateway ${GW.replace(/\./g, '\\.')} answers`));
    const runs = downFor(12, ['--dry-run']);
    runs.forEach((r) => r.status.should.equal(0, r.stdout + r.stderr));
    runs.forEach((r) => r.calls.filter((l) => /^(logger|journalctl|systemctl) /.test(l)).should.eql([]));
    runs[0].stdout.should.match(/network down: gateway 10\.0\.0\.1 does not answer; rebooting if still down after 10 min/);
    runs[8].stdout.should.not.match(/would reboot/);
    runs[9].stdout.should.match(/network down for 10 min after working earlier this boot: would reboot now \(dry run: not rebooting\)/);
    // never up, 60 minutes
    fs.rmSync(state, { recursive: true, force: true });
    const never = downFor(60, ['--dry-run']);
    rebootCalls(never).should.eql([]);
    never[59].stdout.should.match(/no network for 60 min since boot: would reboot now/);
  });

  it('thresholds, gateway and log interval can be overridden through the environment', () => {
    const env = {
      G7_NETWATCH_GATEWAY: '192.0.2.1', G7_NETWATCH_REBOOT_MIN: '3', G7_NETWATCH_LOG_EVERY_MIN: '2',
    };
    run([], env);
    const runs = Array.from({ length: 3 }, () => run([], { ...env, PING_RC: '1' }));
    runs.forEach((r) => of(r.calls, 'ip').should.eql([]));
    of(runs[0].calls, 'ping').should.eql(['ping -c 2 -W 3 192.0.2.1']);
    logged(runs)[1].should.equal('logger -t g7-netwatch network still down after 2 min: gateway 192.0.2.1 does not answer');
    rebootCalls(runs).should.eql(['systemctl reboot']);
    of(runs[2].calls, 'logger')[0].should.containEql('down for 3 min');
    // the never-up threshold
    fs.rmSync(state, { recursive: true, force: true });
    const never = Array.from({ length: 4 }, () => run([], { G7_NETWATCH_NEVER_UP_REBOOT_MIN: '4', PING_RC: '1' }));
    rebootCalls(never.slice(0, 3)).should.eql([]);
    of(never[3].calls, 'systemctl').should.eql(['systemctl reboot']);
  });

  it('a damaged state file counts as zero minutes down', () => {
    up();
    fs.writeFileSync(path.join(state, 'down'), 'garbage\n');
    const r = down();
    of(r.calls, 'logger')[0].should.match(/network down: /);
    of(r.calls, 'systemctl').should.eql([]);
  });

  it('a failed systemctl reboot is logged and the run fails', () => {
    stub('systemctl', 'exit 1');
    up();
    downFor(9);
    const r = down();
    r.status.should.not.equal(0);
    of(r.calls, 'logger').length.should.equal(2);
    of(r.calls, 'logger')[1].should.match(/systemctl reboot failed/);
  });

  it('rejects unknown arguments', () => {
    run(['--bogus']).status.should.equal(2);
  });
}));
