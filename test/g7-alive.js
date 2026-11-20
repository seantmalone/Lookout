/* global describe it before after beforeEach afterEach */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
require('should');

const SCRIPT = path.join(__dirname, '..', 'deploy', 'g7-alive.sh');

// /bin/sh, plus dash (the Pi's /bin/sh) when this machine has it.
const SHELLS = ['/bin/sh', '/bin/dash', '/usr/bin/dash'].filter((s) => fs.existsSync(s));

// Every external command g7-alive runs is a stub here (PATH is only the stub
// directory); each records its arguments in calls.log.
const STUBS = {
  date: 'echo 1700000000',
  // timeout SECONDS CMD...: run CMD (the real one would end it after SECONDS)
  timeout: 'shift; exec "$@"',
  dd: 'exit 0',
  'systemd-notify': 'exit 0',
  findmnt: 'exit 1',
  lsblk: 'exit 1',
  // the loop's sleep: stop the loop as systemd would (SIGTERM)
  sleep: 'kill -TERM $PPID',
};

// eslint-disable-next-line func-names, prefer-arrow-callback
SHELLS.forEach((shell) => describe(`g7-alive.sh (responsiveness watchdog) under ${shell}`, function () {
  this.timeout(10000); // a shell and several stubs per test
  let base; // the default stubs (made once: a new executable is slow to start on some systems)
  let tmp; // this test's overrides, first on PATH
  let log;

  const writeStub = (dir, name, body) => {
    fs.writeFileSync(
      path.join(dir, name),
      `#!/bin/sh\necho "${name} $*" >> "$G7_TEST_LOG"\n${body}\n`,
      { mode: 0o755 },
    );
  };
  const stub = (name, body) => writeStub(tmp, name, body);

  before(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'g7-alive-base-'));
    Object.keys(STUBS).forEach((n) => writeStub(base, n, STUBS[n]));
  });

  after(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g7-alive-'));
    log = path.join(tmp, 'calls.log');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const run = (args, env = { G7_ALIVE_DEVICE: '/dev/mmcblk0' }) => {
    const r = spawnSync(shell, [SCRIPT, ...args], {
      env: { PATH: `${tmp}:${base}`, G7_TEST_LOG: log, ...env }, encoding: 'utf8', timeout: 10000,
    });
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
    return { ...r, calls };
  };
  const of = (calls, cmd) => calls.filter((l) => l.split(' ')[0] === cmd);

  it('is executable', () => {
    (fs.statSync(SCRIPT).mode & 0o111).should.not.equal(0); // eslint-disable-line no-bitwise
  });

  it('all good: runs a program, reads one block from the card with direct I/O, then notifies', () => {
    const r = run(['--once']);
    r.status.should.equal(0, r.stdout + r.stderr);
    of(r.calls, 'date').length.should.equal(1);
    const dd = of(r.calls, 'dd');
    dd.length.should.equal(1);
    const ddArgs = dd[0].split(' ');
    ddArgs.should.containDeep(['if=/dev/mmcblk0', 'of=/dev/null', 'bs=4096', 'count=1', 'iflag=direct']);
    const skip = Number(ddArgs.find((a) => a.startsWith('skip=')).slice(5));
    skip.should.be.within(0, 4095);
    // the read is under timeout(1), so a hang is told apart from an error
    of(r.calls, 'timeout')[0].should.match(/^timeout \d+ dd /);
    of(r.calls, 'systemd-notify').should.eql(['systemd-notify WATCHDOG=1']);
    r.calls.indexOf('systemd-notify WATCHDOG=1').should.be.above(r.calls.indexOf(dd[0]));
  });

  it('the exec check fails: no notification', () => {
    stub('date', 'exit 1');
    const r = run(['--once']);
    r.status.should.not.equal(0);
    of(r.calls, 'systemd-notify').should.eql([]);
  });

  it('a card read ERROR: one log line, no notification', () => {
    stub('dd', "echo \"dd: error reading '/dev/mmcblk0': Input/output error\" >&2; exit 1");
    const r = run(['--once']);
    r.status.should.not.equal(0);
    of(r.calls, 'systemd-notify').should.eql([]);
    const lines = r.stdout.trim().split('\n').filter((l) => /ERROR/.test(l));
    lines.length.should.equal(1);
    lines[0].should.containEql('Input/output error');
  });

  it('a card read that does not answer (timeout, exit 124): no notification, logged as a hang', () => {
    stub('timeout', 'exit 124');
    const r = run(['--once']);
    r.status.should.not.equal(0);
    of(r.calls, 'systemd-notify').should.eql([]);
    r.stdout.should.match(/no answer/);
    r.stdout.should.not.match(/ERROR/);
  });

  it('the card device cannot be determined: logs it once and notifies on the exec check alone', () => {
    const r = run(['--once'], {});
    r.status.should.equal(0, r.stdout + r.stderr);
    of(r.calls, 'dd').should.eql([]);
    of(r.calls, 'systemd-notify').should.eql(['systemd-notify WATCHDOG=1']);
    r.stdout.split('\n').filter((l) => /card check off/.test(l)).length.should.equal(1);
  });

  it('finds the device from the mount under /media/root-ro, else /; not a block device -> off', () => {
    // a source that is not a block device here (a test machine has no mmcblk0)
    stub('findmnt', '[ "$4" = /media/root-ro ] && echo /dev/no-such-mmcblk0p2');
    const r = run(['--once'], {});
    r.status.should.equal(0);
    of(r.calls, 'findmnt')[0].should.equal('findmnt -n -o SOURCE /media/root-ro');
    of(r.calls, 'dd').should.eql([]);
    r.stdout.should.match(/card check off/);
    // overlayroot's / is "overlayroot": not a device either
    stub('findmnt', '[ "$4" = / ] && echo overlayroot; exit 0');
    run(['--once'], {}).stdout.should.match(/card check off/);
  });

  it('the loop: READY=1 after a first good read, a WATCHDOG=1 per good round, exit 0 on SIGTERM', () => {
    const r = run([]);
    r.status.should.equal(0, r.stdout + r.stderr);
    of(r.calls, 'systemd-notify').should.eql(['systemd-notify --ready', 'systemd-notify WATCHDOG=1']);
    of(r.calls, 'dd').length.should.equal(2); // the start check and the first round
    of(r.calls, 'sleep').should.eql(['sleep 30']);
  });

  it('the loop: a card that cannot be read at start is not checked (no reboot loop on a wrong device)', () => {
    stub('dd', 'exit 1');
    const r = run([]);
    r.status.should.equal(0, r.stdout + r.stderr);
    r.stdout.should.match(/card check off/);
    of(r.calls, 'dd').length.should.equal(1);
    of(r.calls, 'systemd-notify').should.eql(['systemd-notify --ready', 'systemd-notify WATCHDOG=1']);
  });

  it('varies the block it reads from round to round', () => {
    const counter = path.join(tmp, 'sleeps');
    stub('sleep', `n=0; [ -f "${counter}" ] && read n < "${counter}"; n=$((n + 1)); echo $n > "${counter}"
[ $n -ge 3 ] && kill -TERM $PPID; exit 0`);
    const r = run([]);
    r.status.should.equal(0, r.stdout + r.stderr);
    const skips = of(r.calls, 'dd').map((l) => /skip=(\d+)/.exec(l)[1]);
    skips.length.should.equal(4);
    new Set(skips).size.should.equal(4);
  });

  it('rejects unknown arguments', () => {
    run(['--bogus']).status.should.equal(2);
  });
}));
