/* global describe it */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const should = require('should');

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

  describe('swap on a read-only card (rpi-swap: Mechanism=none, no swap at all)', () => {
    const DROPIN = '/etc/rpi/swap.conf.d/90-g7-readonly.conf';
    const readonly = () => read('readonly.sh');
    const shFunction = (name) => {
      const m = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}$`, 'm').exec(readonly());
      if (!m) throw new Error(`no ${name}() in readonly.sh`);
      return m[0];
    };

    it('readonly.sh writes the drop-in only when rpi-swap is installed: [Main] / Mechanism=none', () => {
      const fn = shFunction('swap_off');
      fn.should.match(/\[ -f \/etc\/rpi\/swap\.conf \] \|\| \{/);
      fn.should.containEql(DROPIN);
      const body = /<<'SWAP'\n([\s\S]*?)\nSWAP\n/.exec(fn)[1].split('\n');
      body.filter((l) => !l.startsWith('#')).should.eql(['[Main]', 'Mechanism=none']);
      body.filter((l) => l.startsWith('#')).length.should.be.above(2); // says why
      readonly().should.not.match(/Mechanism=zram$/m);
    });

    // run a readonly.sh function against a scratch copy of /etc/rpi and /proc/swaps
    const runIn = (fn, call, files) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g7-swap-'));
      try {
        Object.keys(files).forEach((f) => {
          fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true });
          fs.writeFileSync(path.join(tmp, f), files[f]);
        });
        const text = shFunction(fn).split('/etc/rpi/').join(`${tmp}/etc/rpi/`)
          .split('/proc/swaps')
          .join(`${tmp}/proc/swaps`);
        const r = spawnSync('/bin/sh', ['-c', `${text}\n${call}`], { encoding: 'utf8' });
        r.status.should.equal(0, r.stderr);
        const dropin = path.join(tmp, DROPIN);
        return { stdout: r.stdout, dropin: fs.existsSync(dropin) ? fs.readFileSync(dropin, 'utf8') : null };
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    };

    it('swap_off replaces an existing zram drop-in (a device set up before) with Mechanism=none', () => {
      const r = runIn('swap_off', 'swap_off', {
        '/etc/rpi/swap.conf': '[Main]\nMechanism=auto\n',
        [DROPIN]: '# old\n[Main]\nMechanism=zram\n',
      });
      r.dropin.should.match(/^Mechanism=none$/m);
      r.dropin.should.not.match(/^Mechanism=zram$/m);
      r.stdout.should.match(/swap: off/);
    });

    it('swap_off leaves a system without rpi-swap alone', () => {
      should(runIn('swap_off', 'swap_off', {}).dropin).be.null();
    });

    const PROC_SWAPS_HEAD = 'Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n';
    it('status: off configured and nothing in use', () => {
      runIn('swap_status', 'swap_status', {
        '/etc/rpi/swap.conf': '', [DROPIN]: '[Main]\nMechanism=none\n', '/proc/swaps': PROC_SWAPS_HEAD,
      }).stdout.should.equal('swap: off (Mechanism=none)\nswap in use: none\n');
    });

    it('status: the old zram drop-in, with zram still in use until the next boot', () => {
      runIn('swap_status', 'swap_status', {
        '/etc/rpi/swap.conf': '',
        [DROPIN]: '[Main]\nMechanism=zram\n',
        '/proc/swaps': `${PROC_SWAPS_HEAD}/dev/zram0                              partition\t218652\t\t0\t\t100\n`,
      }).stdout.should.equal('swap: Mechanism=zram (old drop-in: run deploy/update-readonly.sh)\nswap in use: /dev/zram0\n');
    });

    it('status: rpi-swap default, or not installed', () => {
      runIn('swap_status', 'swap_status', { '/etc/rpi/swap.conf': '', '/proc/swaps': PROC_SWAPS_HEAD })
        .stdout.should.startWith('swap: rpi-swap default (no g7 drop-in)\n');
      runIn('swap_status', 'swap_status', { '/proc/swaps': PROC_SWAPS_HEAD })
        .stdout.should.startWith('swap: rpi-swap not installed\n');
    });

    it('readonly.sh runs it from enable and from units (re-runnable on a read-only Pi), status from status', () => {
      const s = readonly();
      /^ {2}units\)\n[\s\S]*?swap_off[\s\S]*?;;/m.test(s).should.equal(true);
      /^ {2}enable\)\n[\s\S]*?swap_off\n[\s\S]*?remove_swapfile_writable_card[\s\S]*?;;/m.test(s).should.equal(true);
      /^ {2}status\)\n[\s\S]*?swap_status[\s\S]*?;;/m.test(s).should.equal(true);
    });

    it('update-readonly.sh rewrites the drop-in (readonly.sh units) before staging it for the card', () => {
      const s = read('update-readonly.sh');
      const units = s.indexOf('sh "$HERE/readonly.sh" units');
      units.should.be.above(-1);
      s.indexOf('cp -a --parents').should.be.above(units);
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

  describe('g7-alive (reboots when userspace or the card stalls)', () => {
    const unit = () => fs.readFileSync(path.join(DEPLOY, 'systemd', 'g7-alive.service'), 'utf8');
    const section = (text, name) => {
      const m = new RegExp(`^\\[${name}\\]\\n([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, 'm').exec(text);
      return m ? m[1] : '';
    };

    it('install.sh installs the script and the unit, enables it and (re)starts it', () => {
      const s = read('install.sh');
      s.should.match(/install -o root -g root -m 755 "\$HERE\/g7-alive\.sh" \/usr\/local\/sbin\/g7-alive\n/);
      s.should.match(/install -m 644 "\$HERE\/systemd\/g7-alive\.service" \/etc\/systemd\/system\/g7-alive\.service\n/);
      s.should.match(/systemctl enable g7-alive\.service/);
      s.should.match(/systemctl restart g7-alive\.service/);
      s.indexOf('systemctl restart g7-alive.service').should.be.above(s.indexOf('systemctl daemon-reload'));
    });

    it('update-readonly.sh mirrors the script, the unit and its enable link to the card', () => {
      mirroredPaths().should.containDeep([
        '/usr/local/sbin/g7-alive',
        '/etc/systemd/system/g7-alive.service',
        '/etc/systemd/system/multi-user.target.wants/g7-alive.service',
      ]);
    });

    it('the unit: notify watchdog of 5 min, reboot at once on failure, no restart', () => {
      const svc = section(unit(), 'Service');
      svc.should.match(/^Type=notify$/m);
      svc.should.match(/^NotifyAccess=all$/m);
      svc.should.match(/^ExecStart=\/usr\/local\/sbin\/g7-alive$/m);
      svc.should.match(/^WatchdogSec=300$/m);
      svc.should.match(/^Restart=no$/m);
      svc.should.match(/^Nice=-5$/m);
      // FailureAction is a [Unit] setting (ignored with a warning in [Service])
      section(unit(), 'Unit').should.match(/^FailureAction=reboot-immediate$/m);
      svc.should.not.match(/FailureAction/);
      section(unit(), 'Install').should.match(/^WantedBy=multi-user\.target$/m);
    });

    it('the unit: no dependency on Lookout or Bluetooth; a missing script is skipped, not a failure', () => {
      const settings = unit().split('\n').filter((l) => !l.startsWith('#'));
      settings.filter((l) => /lookout|bluetooth/i.test(l)).should.eql([]);
      settings.filter((l) => /^(After|Requires|Wants|BindsTo|PartOf)=/.test(l)).should.eql([]);
      section(unit(), 'Unit').should.match(/^ConditionFileIsExecutable=\/usr\/local\/sbin\/g7-alive$/m);
      unit().should.not.match(/ConditionPathIsExecutable/);
    });

    it('the unit documents what happens on expiry and how to turn it off', () => {
      const comments = unit().split('\n').filter((l) => l.startsWith('#')).join('\n');
      comments.should.match(/systemctl disable --now g7-alive\.service/);
      comments.should.match(/watchdog/i);
      comments.should.match(/FailureAction/);
      comments.should.match(/clean stop/i);
    });
  });

  describe('g7-new-sensor (dropped from the repo) is removed from devices', () => {
    const OLD = '/usr/local/sbin/g7-new-sensor';
    const rmLines = (f) => read(f).split('\n').filter((l) => /\brm\b/.test(l) && l.includes('g7-new-sensor'))
      .map((l) => l.trim());

    it('install.sh removes it from the running system, by its literal path', () => {
      rmLines('install.sh').should.eql([`rm -f ${OLD}`]);
    });

    it('update-readonly.sh removes it from the card by its literal path, inside the unlocked window, and verifies', () => {
      const s = read('update-readonly.sh');
      rmLines('update-readonly.sh').should.eql([`rm -f /media/root-ro${OLD}`]);
      const decide = s.indexOf(`[ -e /media/root-ro${OLD} ]`);
      const unlock = s.indexOf('mount -o remount,rw "$L"');
      const rm = s.indexOf(`rm -f /media/root-ro${OLD}`);
      const relock = s.indexOf('\nrelock\n');
      decide.should.be.above(-1);
      unlock.should.be.above(decide); // decided before unlocking
      rm.should.be.above(unlock);
      relock.should.be.above(rm);
      s.should.match(/rm -f \/media\/root-ro\/usr\/local\/sbin\/g7-new-sensor\n\s*drop_caches/);
      s.indexOf(`[ -e /media/root-ro${OLD} ]`, relock).should.be.above(relock); // checked after relocking
    });

    it('is not mirrored onto the card any more', () => {
      mirroredPaths().should.not.containEql(OLD);
    });
  });

  describe('rsync for update-readonly.sh', () => {
    it('readonly.sh enable installs rsync while the card is still writable', () => {
      /^ {2}enable\)\n[\s\S]*?command -v rsync[\s\S]*?apt-get install -y -q rsync[\s\S]*?set_cmdline on[\s\S]*?;;/m
        .test(read('readonly.sh')).should.equal(true);
    });

    it('update-readonly.sh stops before changing anything when rsync is missing', () => {
      const s = read('update-readonly.sh');
      const check = s.indexOf('command -v rsync');
      check.should.be.above(-1);
      check.should.be.below(s.indexOf('sh "$HERE/install.sh"'));
    });
  });

  describe('install.sh and Node under /opt/node', () => {
    it('warns when /opt/node/bin/node (what g7-rig-remote runs) is missing', () => {
      read('g7-rig-remote.sh').should.match(/NODE=\$\{G7RIG_NODE:-\/opt\/node\/bin\/node\}/);
      read('install.sh').should.match(/\[ -x \/opt\/node\/bin\/node \] \|\| echo "warning: /);
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
