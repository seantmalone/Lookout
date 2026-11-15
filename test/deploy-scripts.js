/* global describe it */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
require('should');

const DEPLOY = path.join(__dirname, '..', 'deploy');
const read = (f) => fs.readFileSync(path.join(DEPLOY, f), 'utf8');
const SCRIPTS = fs.readdirSync(DEPLOY).filter((f) => f.endsWith('.sh'));
// /bin/sh, plus dash (the Pi's /bin/sh) when this machine has it.
const SHELLS = ['/bin/sh', '/bin/dash', '/usr/bin/dash'].filter((s) => fs.existsSync(s));

// The managed PATHS that update-readonly.sh mirrors onto the read-only card.
const mirroredPaths = () => {
  const m = /^PATHS="([^"]*)"/m.exec(read('update-readonly.sh'));
  return m[1].split(/\s+/).filter(Boolean);
};

describe('deploy scripts', () => {
  SCRIPTS.forEach((f) => SHELLS.forEach((shell) => {
    it(`${f} passes ${shell} -n`, () => {
      const r = spawnSync(shell, ['-n', path.join(DEPLOY, f)], { encoding: 'utf8' });
      r.status.should.equal(0, r.stderr);
    });
  }));

  describe('g7-bt-watchdog units', () => {
    it('install.sh installs the service and enables the timer', () => {
      const s = read('install.sh');
      s.should.match(/systemd\/g7-bt-watchdog\.service" > \/etc\/systemd\/system\/g7-bt-watchdog\.service/);
      s.should.match(/systemd\/g7-bt-watchdog\.timer" \/etc\/systemd\/system\/g7-bt-watchdog\.timer/);
      s.should.match(/systemctl enable --now g7-bt-watchdog\.timer/);
    });

    it('update-readonly.sh mirrors both units and the timer\'s enable link to the card', () => {
      mirroredPaths().should.containDeep([
        '/etc/systemd/system/g7-bt-watchdog.service',
        '/etc/systemd/system/g7-bt-watchdog.timer',
        '/etc/systemd/system/timers.target.wants/g7-bt-watchdog.timer',
      ]);
    });

    it('runs the local-only g7-rig command at nice 19 every 5 minutes', () => {
      const svc = fs.readFileSync(path.join(DEPLOY, 'systemd', 'g7-bt-watchdog.service'), 'utf8');
      svc.should.match(/^ExecStart=@NODE_BIN@\/node \/usr\/local\/sbin\/g7-rig\.js bt-watchdog$/m);
      svc.should.match(/^Nice=19$/m);
      const timer = fs.readFileSync(path.join(DEPLOY, 'systemd', 'g7-bt-watchdog.timer'), 'utf8');
      timer.should.match(/^OnUnitActiveSec=5min$/m);
      timer.should.match(/^WantedBy=timers\.target$/m);
    });
  });
});
