/* global describe it before after */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const should = require('should');

const SCRIPT = path.join(__dirname, '..', 'deploy', 'g7-rig-remote.sh');

// /bin/sh, plus dash (the Pi's /bin/sh) when this machine has it.
const SHELLS = ['/bin/sh', '/bin/dash', '/usr/bin/dash'].filter((s) => fs.existsSync(s));

SHELLS.forEach((shell) => describe(`g7-rig-remote.sh (forced-command wrapper) under ${shell}`, () => {
  let tmp;
  let stubNode;
  let marker;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g7rig-remote-'));
    marker = path.join(tmp, 'node-ran');
    stubNode = path.join(tmp, 'node');
    // Echo each argument on its own line, then whatever came on stdin.
    fs.writeFileSync(stubNode, `#!/bin/sh\n: > "${marker}"\nfor a in "$@"; do printf 'ARG:%s\\n' "$a"; done\ncat\n`, { mode: 0o755 });
    // Keep the test from writing to the real syslog.
    fs.writeFileSync(path.join(tmp, 'logger'), `#!/bin/sh\necho "$*" >> "${tmp}/logged"\n`, { mode: 0o755 });
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const run = (cmd, input = '') => {
    fs.rmSync(marker, { force: true });
    const env = { PATH: `${tmp}:/usr/bin:/bin`, G7RIG_NODE: stubNode, LANG: 'en_US.UTF-8' };
    if (cmd !== undefined) env.SSH_ORIGINAL_COMMAND = cmd;
    const r = spawnSync(shell, [SCRIPT], { env, input, encoding: 'utf8' });
    return { ...r, ran: fs.existsSync(marker) };
  };

  it('passes sh -n', () => {
    spawnSync(shell, ['-n', SCRIPT]).status.should.equal(0);
  });

  it('is executable', () => {
    (fs.statSync(SCRIPT).mode & 0o111).should.not.equal(0); // eslint-disable-line no-bitwise
  });

  const allowed = ['status', 'export-key', 'import-key', 'scan DXCMab', 'scan DXCM12', 'pair 1234 DXCMab', 'pair 0000 DXCMZ9'];

  allowed.forEach((cmd) => {
    it(`execs node g7-rig.js for ${JSON.stringify(cmd)}`, () => {
      const r = run(cmd);
      r.status.should.equal(0, r.stderr);
      r.ran.should.equal(true);
      r.stdout.should.equal(['/usr/local/sbin/g7-rig.js', ...cmd.split(' ')].map((a) => `ARG:${a}\n`).join(''));
    });
  });

  it('passes stdin through to import-key', () => {
    const r = run('import-key', '{"x":1}');
    r.stdout.should.equal('ARG:/usr/local/sbin/g7-rig.js\nARG:import-key\n{"x":1}');
  });

  const rejected = [
    '', 'status ', ' status', 'status; id', 'status;id', 'status && id', 'status | id', 'status\nid',
    'export-key x', 'import-key -', 'scan', 'scan DXCM', 'scan DXCMa', 'scan DXCMa!', 'scan DXCMabc',
    'scan DXCMab && id', 'scan DXCMab; id', 'scan DXCM*?', 'scan DXCM[a]', 'scan DXCMé', 'scan  DXCMab',
    'pair 12345 DXCMab', 'pair 123 DXCMab', 'pair 1234 DXCMab extra', 'pair 1234  DXCMab',
    'pair 1234 DXCMab;id', 'pair 1a34 DXCMab', '$(id)', '`id`', 'status $(id)', 'cat /etc/shadow',
    'sh', 'STATUS', '--help',
  ];

  rejected.forEach((cmd) => {
    it(`rejects ${JSON.stringify(cmd)} with exit 2 and logs it`, () => {
      const r = run(cmd);
      r.status.should.equal(2);
      r.ran.should.equal(false);
      r.stdout.should.equal('');
      r.stderr.should.equal('rejected\n');
      fs.readFileSync(path.join(tmp, 'logged'), 'utf8').should.containEql('rejected');
    });
  });

  it('rejects a missing SSH_ORIGINAL_COMMAND', () => {
    const r = run(undefined);
    r.status.should.equal(2);
    r.ran.should.equal(false);
  });

  it('still exits 2 when logger fails', () => {
    fs.writeFileSync(path.join(tmp, 'logger'), '#!/bin/sh\nexit 7\n', { mode: 0o755 });
    const r = run('status; id');
    should(r.status).equal(2);
  });
}));

describe('setup-g7rig-access.sh', () => {
  SHELLS.forEach((shell) => {
    it(`passes ${shell} -n`, () => {
      spawnSync(shell, ['-n', path.join(__dirname, '..', 'deploy', 'setup-g7rig-access.sh')]).status.should.equal(0);
    });
  });
});
