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

  describe('harden.sh: 64 MB CMA instead of 256 MB (dtoverlay=vc4-kms-v3d,cma-64)', () => {
    const harden = () => read('harden.sh');
    const cmaSed = () => /^CMA_SED='([^']*)'$/m.exec(harden())[1];
    const edit = (text) => {
      const r = spawnSync('sed', [cmaSed()], { input: text, encoding: 'utf8' });
      r.status.should.equal(0, r.stderr);
      return r.stdout;
    };

    it('changes a line that is exactly dtoverlay=vc4-kms-v3d, and nothing else', () => {
      edit('# comment\ndtparam=audio=on\ndtoverlay=vc4-kms-v3d\nmax_framebuffers=2\n')
        .should.equal('# comment\ndtparam=audio=on\ndtoverlay=vc4-kms-v3d,cma-64\nmax_framebuffers=2\n');
    });

    it('is idempotent and leaves overlays with parameters, comments and other overlays alone', () => {
      [
        'dtoverlay=vc4-kms-v3d,cma-64\n',
        'dtoverlay=vc4-kms-v3d,cma-128\n',
        'dtoverlay=vc4-kms-v3d,noaudio\n',
        '#dtoverlay=vc4-kms-v3d\n',
        'dtoverlay=vc4-fkms-v3d\n',
        'dtoverlay=vc4-kms-v3d-pi4\n',
        ' dtoverlay=vc4-kms-v3d\n',
        'dtparam=audio=on\n',
      ].forEach((t) => edit(t).should.equal(t));
      const once = edit('dtoverlay=vc4-kms-v3d\n');
      edit(once).should.equal(once);
    });

    it('edits only when the exact line is there, with the boot partition writable just for that', () => {
      const s = harden();
      const step = s.slice(s.indexOf('# 5.'));
      step.should.match(/if grep -qx 'dtoverlay=vc4-kms-v3d' \/boot\/firmware\/config\.txt; then/);
      step.should.match(/with_boot_rw cma64_config/);
      step.should.match(/next boot/);
      const fn = /^with_boot_rw\(\) \{\n([\s\S]*?)\n\}$/m.exec(s)[1];
      fn.should.match(/mount -o remount,rw \/boot\/firmware/);
      fn.should.match(/mount -o remount,ro \/boot\/firmware/);
    });

    it('keeps a one-time backup next to config.txt, like /etc/fstab.pre-harden', () => {
      const fn = /^cma64_config\(\) \{\n([\s\S]*?)\n\}$/m.exec(harden())[1];
      fn.should.match(/\[ -e \/boot\/firmware\/config\.txt\.pre-harden \] \|\| cp \/boot\/firmware\/config\.txt \/boot\/firmware\/config\.txt\.pre-harden/);
      fn.should.match(/sed -i "\$CMA_SED" \/boot\/firmware\/config\.txt/);
    });
  });

  describe('swap on a read-only card (rpi-swap: zram only, no swap file)', () => {
    const DROPIN = '/etc/rpi/swap.conf.d/90-g7-readonly.conf';
    const readonly = () => read('readonly.sh');

    it('readonly.sh writes the drop-in only when rpi-swap is installed', () => {
      const s = readonly();
      const fn = /^swap_zram_only\(\) \{\n([\s\S]*?)\n\}$/m.exec(s);
      fn.should.be.ok();
      fn[1].should.match(/\[ -f \/etc\/rpi\/swap\.conf \] \|\| \{/);
      fn[1].should.containEql(DROPIN);
      const body = /<<'SWAP'\n([\s\S]*?)\nSWAP\n/.exec(fn[1])[1].split('\n');
      body.filter((l) => !l.startsWith('#')).should.eql(['[Main]', 'Mechanism=zram']);
      body.filter((l) => l.startsWith('#')).length.should.be.above(2); // says why
    });

    it('readonly.sh runs it from enable and from units (re-runnable on a read-only Pi)', () => {
      const s = readonly();
      /^ {2}units\)\n[\s\S]*?swap_zram_only[\s\S]*?;;/m.test(s).should.equal(true);
      /^ {2}enable\)\n[\s\S]*?swap_zram_only\n[\s\S]*?remove_swapfile_writable_card[\s\S]*?;;/m.test(s).should.equal(true);
    });

    it('update-readonly.sh carries the drop-in to the card', () => {
      mirroredPaths().should.containEql(DROPIN);
    });

    it('removes the swap file with literal paths only, on the card, never through the overlay', () => {
      const rmLines = (f) => read(f).split('\n').filter((l) => /\brm\b/.test(l) && /swap/.test(l)).map((l) => l.trim());
      rmLines('readonly.sh').should.eql(['rm -f /var/swap']);
      rmLines('update-readonly.sh').should.eql(['rm -f /media/root-ro/var/swap']);
      // the writable-card removal refuses to run under the overlay
      /^remove_swapfile_writable_card\(\) \{\n[\s\S]*?overlay_active && [\s\S]*?rm -f \/var\/swap[\s\S]*?\n\}$/m
        .test(readonly()).should.equal(true);
    });

    it('update-readonly.sh removes it inside the unlocked window and verifies after relocking', () => {
      const s = read('update-readonly.sh');
      const unlock = s.indexOf('mount -o remount,rw "$L"');
      const rm = s.indexOf('rm -f /media/root-ro/var/swap');
      const relock = s.indexOf('\nrelock\n');
      unlock.should.be.above(-1);
      rm.should.be.above(unlock);
      relock.should.be.above(rm);
      s.indexOf('[ -e /media/root-ro/var/swap ]', relock).should.be.above(relock);
    });

    it('update-readonly.sh drops the caches after removing the swap file and in relock', () => {
      const s = read('update-readonly.sh');
      s.should.match(/echo 2 > \/proc\/sys\/vm\/drop_caches 2>\/dev\/null \|\| true/);
      s.should.match(/rm -f \/media\/root-ro\/var\/swap\n\s*drop_caches/);
      s.should.match(/relock\(\) \{[\s\S]*?\[ \$i -eq 5 \] && drop_caches[\s\S]*?\n\}/);
    });
  });

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
