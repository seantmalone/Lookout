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

  describe('harden.sh: Wi-Fi power save off (NetworkManager drop-in)', () => {
    const CONF = '/etc/NetworkManager/conf.d/90-g7-wifi-powersave.conf';
    const fnText = () => {
      const m = /^wifi_powersave_off\(\) \{\n[\s\S]*?\n\}$/m.exec(read('harden.sh'));
      if (!m) throw new Error('no wifi_powersave_off() in harden.sh');
      return m[0];
    };

    // run wifi_powersave_off against a scratch /etc/NetworkManager and a stub
    // nmcli that logs its arguments (none when nmcli is null)
    const run = ({ confD = true, existing = null, nmcli = '' } = {}) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g7-wifi-'));
      try {
        if (confD) fs.mkdirSync(path.join(tmp, 'etc/NetworkManager/conf.d'), { recursive: true });
        if (existing !== null) fs.writeFileSync(path.join(tmp, CONF), existing);
        const bin = path.join(tmp, 'bin');
        fs.mkdirSync(bin);
        // only what the function needs besides nmcli
        ['cat', 'chmod', 'cmp', 'mv', 'rm', 'sed', 'head'].forEach((c) => {
          const which = spawnSync('/bin/sh', ['-c', `command -v ${c}`], { encoding: 'utf8' }).stdout.trim();
          fs.symlinkSync(which, path.join(bin, c));
        });
        if (nmcli !== null) {
          fs.writeFileSync(path.join(bin, 'nmcli'), `#!/bin/sh\necho "$*" >> "${tmp}/nmcli.log"\n${nmcli}\n`, { mode: 0o755 });
        }
        const text = fnText().split('/etc/NetworkManager/').join(`${tmp}/etc/NetworkManager/`);
        const r = spawnSync('/bin/sh', ['-c', `${text}\nwifi_powersave_off`], {
          encoding: 'utf8', env: { PATH: bin },
        });
        const conf = path.join(tmp, CONF);
        const log = path.join(tmp, 'nmcli.log');
        return {
          status: r.status,
          out: r.stdout + r.stderr,
          conf: fs.existsSync(conf) ? fs.readFileSync(conf, 'utf8') : null,
          mode: fs.existsSync(conf) ? (fs.statSync(conf).mode % 0o1000) : null,
          calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [],
          left: fs.readdirSync(path.join(tmp, 'etc/NetworkManager/conf.d')),
        };
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    };

    const ACTIVE = [
      '[ -n "$PS" ] || PS=disable',
      'case "$*" in',
      '  "-t -f TYPE,UUID connection show --active") printf "loopback:aaaa\\n802-11-wireless:1234-uuid\\n" ;;',
      '  "-g 802-11-wireless.powersave connection show uuid 1234-uuid") echo "$PS" ;;',
      'esac',
    ].join('\n');

    it('writes [connection] / wifi.powersave = 2 (disable), mode 644, and says why', () => {
      const r = run({ nmcli: ACTIVE });
      r.status.should.equal(0, r.out);
      const lines = r.conf.split('\n').filter(Boolean);
      lines.filter((l) => !l.startsWith('#')).should.eql(['[connection]', 'wifi.powersave = 2']);
      lines.filter((l) => l.startsWith('#')).length.should.be.above(1);
      r.mode.should.equal(0o644);
      r.left.should.eql(['90-g7-wifi-powersave.conf']); // no .tmp left behind
    });

    it('reloads the configuration (never restarts NetworkManager) and reports the active connection', () => {
      const r = run({ nmcli: ACTIVE });
      r.calls[0].should.equal('general reload conf');
      r.calls.should.containEql('-g 802-11-wireless.powersave connection show uuid 1234-uuid');
      r.out.should.match(/next reconnect or after a reboot/);
      r.out.should.match(/active connection: disable \(off\)/);
      const code = fnText().split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
      code.should.not.match(/systemctl|service NetworkManager|nmcli [^\n]*(networking off|radio wifi off)/);
      read('harden.sh').should.not.match(/^[^#]*(systemctl \S+ NetworkManager|restart NetworkManager)/m);
    });

    it('is idempotent: a second run leaves the same file and says so', () => {
      const first = run({ nmcli: ACTIVE });
      const second = run({ existing: first.conf, nmcli: ACTIVE });
      second.conf.should.equal(first.conf);
      second.out.should.match(/already off by default/);
      second.left.should.eql(['90-g7-wifi-powersave.conf']);
    });

    it('replaces a file with other content', () => {
      run({ existing: '[connection]\nwifi.powersave = 3\n', nmcli: ACTIVE }).conf
        .should.match(/^wifi\.powersave = 2$/m);
    });

    it('flags a connection that turns power save on itself', () => {
      run({ nmcli: `PS=enable\n${ACTIVE}` }).out
        .should.match(/sets enable itself \(on\); to turn it off: nmcli connection modify uuid 1234-uuid 802-11-wireless\.powersave disable/);
      run({ nmcli: `PS=default\n${ACTIVE}` }).out.should.match(/active connection: default/);
    });

    it('without an active Wi-Fi connection, or without nmcli, still writes the file', () => {
      const none = run({ nmcli: 'exit 0' });
      none.status.should.equal(0, none.out);
      none.out.should.match(/no active Wi-Fi connection/);
      none.conf.should.match(/^wifi\.powersave = 2$/m);
      const noNmcli = run({ nmcli: null });
      noNmcli.status.should.equal(0, noNmcli.out);
      noNmcli.conf.should.match(/^wifi\.powersave = 2$/m);
      noNmcli.out.should.match(/nmcli not found/);
    });

    it('does nothing without NetworkManager\'s conf.d', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g7-wifi-'));
      try {
        const text = fnText().split('/etc/NetworkManager/').join(`${tmp}/etc/NetworkManager/`);
        const r = spawnSync('/bin/sh', ['-c', `${text}\nwifi_powersave_off`], { encoding: 'utf8' });
        r.status.should.equal(0, r.stderr);
        r.stdout.should.match(/not found \(no NetworkManager\); left unchanged/);
        fs.existsSync(path.join(tmp, 'etc')).should.equal(false);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('harden.sh runs it, and says on a read-only card that update-readonly.sh puts it on the card', () => {
      const s = read('harden.sh');
      s.should.match(/^wifi_powersave_off \|\| /m);
      s.should.match(/update-readonly\.sh copies it onto the card/);
    });

    it('update-readonly.sh carries the drop-in to the card', () => {
      mirroredPaths().should.containEql(CONF);
    });
  });

  describe('harden.sh: BlueZ TemporaryTimeout (an active 0 back to the shipped default)', () => {
    const MAIN = '/etc/bluetooth/main.conf';
    // a trimmed Raspberry Pi OS 13 / BlueZ 5.82 main.conf
    const conf = (line) => ['[General]', '', '# How long to keep temporary devices around',
      '# The value is in seconds. Default is 30.', '# 0 = disable timer, i.e. never keep temporary devices',
      line, '', '#Experimental = false', '[Policy]', '#AutoEnable=true', ''].join('\n');
    const DEFAULT = '#TemporaryTimeout = 30';
    const fnText = (script, name) => {
      const m = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}$`, 'm').exec(read(script));
      if (!m) throw new Error(`no ${name}() in ${script}`);
      return m[0];
    };
    const ttSed = (script) => /^TT_SED='([^']*)'$/m.exec(read(script))[1];

    // run harden.sh's bt_temporary_timeout against a scratch /etc/bluetooth
    const run = (shell, content, mode = 0o644) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g7-bluez-'));
      try {
        const file = path.join(tmp, MAIN);
        if (content !== null) {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, content, { mode });
          fs.chmodSync(file, mode);
        }
        const text = fnText('harden.sh', 'bt_temporary_timeout').split('/etc/bluetooth/').join(`${tmp}/etc/bluetooth/`);
        const r = spawnSync(shell, ['-c', `TT_SED='${ttSed('harden.sh')}'\n${text}\nbt_temporary_timeout`], { encoding: 'utf8' });
        return {
          status: r.status,
          out: r.stdout + r.stderr,
          conf: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null,
          mode: fs.existsSync(file) ? (fs.statSync(file).mode % 0o1000) : null,
          left: fs.existsSync(path.dirname(file)) ? fs.readdirSync(path.dirname(file)) : [],
        };
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    };

    SHELLS.forEach((shell) => {
      it(`replaces an active TemporaryTimeout = 0 with the shipped default line, and only that (${shell})`, () => {
        ['TemporaryTimeout = 0', 'TemporaryTimeout=0', '  TemporaryTimeout =  0  '].forEach((line) => {
          const r = run(shell, conf(line));
          r.status.should.equal(0, r.out);
          r.conf.should.equal(conf(DEFAULT));
          r.out.should.match(/TemporaryTimeout = 0/);
          r.out.should.match(/systemctl restart bluetooth/);
          r.out.should.match(/reboot/);
          r.left.should.eql(['main.conf']); // no temp file left behind
        });
      });

      it(`keeps the file's mode, and a second run changes nothing (${shell})`, () => {
        const r = run(shell, conf('TemporaryTimeout = 0'), 0o640);
        r.mode.should.equal(0o640);
        const again = run(shell, r.conf);
        again.conf.should.equal(r.conf);
        again.out.should.match(/TemporaryTimeout: not set .*default: 30 s/);
      });

      it(`leaves other values and commented lines alone, and reports them (${shell})`, () => {
        const sixty = run(shell, conf('TemporaryTimeout = 60'));
        sixty.conf.should.equal(conf('TemporaryTimeout = 60'));
        sixty.out.should.match(/TemporaryTimeout = 60 .*left unchanged/);
        sixty.out.should.not.match(/restart bluetooth/);
        [conf('#TemporaryTimeout = 0'), conf(DEFAULT), conf('')].forEach((c) => {
          const r = run(shell, c);
          r.conf.should.equal(c);
          r.out.should.match(/not set .*default: 30 s/);
        });
      });

      it(`says so when there is no main.conf (${shell})`, () => {
        const r = run(shell, null);
        r.status.should.equal(0, r.out);
        r.out.should.match(/not found; left unchanged/);
      });
    });

    it('never restarts Bluetooth itself; harden.sh runs it, and says update-readonly.sh carries it to a read-only card', () => {
      // (only in what it tells you to run)
      const code = fnText('harden.sh', 'bt_temporary_timeout').split('\n').filter((l) => !/^\s*(#|echo )/.test(l)).join('\n');
      code.should.not.match(/systemctl (restart|stop|start|reload)|service bluetooth|kill/);
      const s = read('harden.sh');
      // (only in what it tells you to run)
      s.should.not.match(/^(?![^#]*echo )[^#]*systemctl \S+ bluetooth/m);
      s.should.match(/^bt_temporary_timeout \|\| /m);
      s.should.match(/^ {8}echo "Bluetooth: the card is read-only; [^\n]*update-readonly\.sh corrects the card's copy"$/m);
    });

    it('update-readonly.sh uses the same correction', () => {
      ttSed('update-readonly.sh').should.equal(ttSed('harden.sh'));
    });

    it('update-readonly.sh corrects the card\'s copy only (not mirrored wholesale), inside the unlocked window, and verifies', () => {
      const s = read('update-readonly.sh');
      mirroredPaths().should.not.containEql(MAIN);
      const decide = s.indexOf('FIX_TT=yes');
      const stage = s.indexOf('"$STAGE/bluetooth-main.conf"');
      const unlock = s.indexOf('mount -o remount,rw "$L"');
      const write = s.indexOf('mv -f "$L/etc/bluetooth/main.conf.g7tmp" "$L/etc/bluetooth/main.conf"');
      const relock = s.indexOf('\nrelock\n');
      [decide, stage, write].forEach((i) => i.should.be.above(-1));
      unlock.should.be.above(decide); // decided and staged before unlocking
      unlock.should.be.above(stage);
      write.should.be.above(unlock);
      relock.should.be.above(write);
      s.indexOf('cmp -s "$STAGE/bluetooth-main.conf" "$L/etc/bluetooth/main.conf"', relock).should.be.above(relock);
    });

    // update-readonly.sh's decision and staging, against a scratch card and running system
    const stageFn = () => fnText('update-readonly.sh', 'stage_bt_main_conf');
    const runStage = (card, running) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g7-bluez-card-'));
      try {
        const put = (p, c) => {
          if (c === null) return;
          fs.mkdirSync(path.dirname(path.join(tmp, p)), { recursive: true });
          fs.writeFileSync(path.join(tmp, p), c);
        };
        put('/card/etc/bluetooth/main.conf', card);
        put('/etc/bluetooth/main.conf', running);
        fs.mkdirSync(path.join(tmp, 'stage'));
        const text = stageFn().split('$L/etc/bluetooth/').join('@CARD@')
          .split('/etc/bluetooth/')
          .join(`${tmp}/etc/bluetooth/`)
          .split('@CARD@')
          .join(`${tmp}/card/etc/bluetooth/`);
        const r = spawnSync('/bin/sh', ['-c', `TT_SED='${ttSed('update-readonly.sh')}'\nSTAGE=${tmp}/stage\nFIX_TT=no\n${text}\nstage_bt_main_conf\necho "FIX_TT=$FIX_TT"`], { encoding: 'utf8' });
        const staged = path.join(tmp, 'stage', 'bluetooth-main.conf');
        return {
          status: r.status,
          out: r.stdout + r.stderr,
          staged: fs.existsSync(staged) ? fs.readFileSync(staged, 'utf8') : null,
        };
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    };

    it('update-readonly.sh: card has 0, running system corrected (harden.sh ran) -> stages the card\'s copy with the one line fixed', () => {
      const card = conf('TemporaryTimeout = 0').replace('#AutoEnable=true', '#AutoEnable=true\n# a line only the card has');
      const r = runStage(card, conf(DEFAULT));
      r.status.should.equal(0, r.out);
      r.out.should.match(/FIX_TT=yes/);
      r.staged.should.equal(card.replace('TemporaryTimeout = 0', DEFAULT));
    });

    it('update-readonly.sh: nothing to do when the card is fine; asks for harden.sh first when the running system still has 0', () => {
      const fine = runStage(conf(DEFAULT), conf(DEFAULT));
      fine.out.should.match(/FIX_TT=no/);
      should(fine.staged).be.null();
      const notHardened = runStage(conf('TemporaryTimeout = 0'), conf('TemporaryTimeout = 0'));
      notHardened.out.should.match(/FIX_TT=no/);
      notHardened.out.should.match(/run deploy\/harden\.sh/);
      should(notHardened.staged).be.null();
      runStage(null, null).out.should.match(/FIX_TT=no/);
    });

    it('readonly.sh status shows the value in use (running system and card)', () => {
      const fn = ['tt_value', 'tt_describe', 'bt_temporary_timeout_status'].map((n) => fnText('readonly.sh', n)).join('\n');
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g7-bluez-st-'));
      try {
        const runIt = (running, card) => {
          [['/etc/bluetooth/main.conf', running], ['/media/root-ro/etc/bluetooth/main.conf', card]].forEach(([p, c]) => {
            const f = path.join(tmp, p);
            fs.rmSync(f, { force: true });
            if (c === null) return;
            fs.mkdirSync(path.dirname(f), { recursive: true });
            fs.writeFileSync(f, c);
          });
          const text = fn.split('/media/root-ro/etc/bluetooth/').join('@CARD@')
            .split('/etc/bluetooth/').join(`${tmp}/etc/bluetooth/`)
            .split('@CARD@')
            .join(`${tmp}/media/root-ro/etc/bluetooth/`);
          // no overlay helper here: say the overlay is active, so the card is read too
          const r = spawnSync('/bin/sh', ['-c', `overlay_active() { true; }\n${text}\nbt_temporary_timeout_status`], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
          r.status.should.equal(0, r.stderr);
          return r.stdout;
        };
        runIt(conf(DEFAULT), conf(DEFAULT)).should.startWith('bluetooth TemporaryTimeout: 30 s (BlueZ default)\n');
        runIt(conf('TemporaryTimeout = 0'), conf('TemporaryTimeout = 0'))
          .should.match(/^bluetooth TemporaryTimeout: 0 \(devices are never forgotten: run deploy\/harden\.sh\)\n/);
        runIt(conf('TemporaryTimeout = 60'), conf('TemporaryTimeout = 60')).should.startWith('bluetooth TemporaryTimeout: 60 s\n');
        runIt(conf(DEFAULT), conf('TemporaryTimeout = 0'))
          .should.match(/card's main\.conf: TemporaryTimeout 0 \(run deploy\/update-readonly\.sh\)/);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('readonly.sh runs it from status', () => {
      /^ {2}status\)\n[\s\S]*?bt_temporary_timeout_status[\s\S]*?;;/m.test(read('readonly.sh')).should.equal(true);
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

  describe('g7-netwatch (reboots when the network has fallen over)', () => {
    const unitFile = (f) => fs.readFileSync(path.join(DEPLOY, 'systemd', f), 'utf8');

    it('install.sh installs the script and both units, and enables the timer after daemon-reload', () => {
      const s = read('install.sh');
      s.should.match(/install -o root -g root -m 755 "\$HERE\/g7-netwatch\.sh" \/usr\/local\/sbin\/g7-netwatch\n/);
      s.should.match(/install -m 644 "\$HERE\/systemd\/g7-netwatch\.service" \/etc\/systemd\/system\/g7-netwatch\.service\n/);
      s.should.match(/install -m 644 "\$HERE\/systemd\/g7-netwatch\.timer" \/etc\/systemd\/system\/g7-netwatch\.timer\n/);
      s.indexOf('systemctl enable --now g7-netwatch.timer').should.be.above(s.indexOf('systemctl daemon-reload'));
    });

    it('update-readonly.sh mirrors the script, both units and the timer\'s enable link to the card', () => {
      mirroredPaths().should.containDeep([
        '/usr/local/sbin/g7-netwatch',
        '/etc/systemd/system/g7-netwatch.service',
        '/etc/systemd/system/g7-netwatch.timer',
        '/etc/systemd/system/timers.target.wants/g7-netwatch.timer',
      ]);
    });

    it('the service: oneshot at nice 10, runs the script with no arguments', () => {
      const svc = unitFile('g7-netwatch.service');
      svc.should.match(/^Type=oneshot$/m);
      svc.should.match(/^Nice=10$/m);
      svc.should.match(/^ExecStart=\/usr\/local\/sbin\/g7-netwatch$/m);
      svc.should.match(/^ConditionFileIsExecutable=\/usr\/local\/sbin\/g7-netwatch$/m);
      svc.should.not.match(/^\[Install\]/m); // started by the timer only
    });

    it('the timer: 3 min after boot, then every minute, 10 s accuracy', () => {
      const timer = unitFile('g7-netwatch.timer');
      timer.should.match(/^OnBootSec=3min$/m);
      timer.should.match(/^OnUnitActiveSec=1min$/m);
      timer.should.match(/^AccuracySec=10s$/m);
      timer.should.match(/^WantedBy=timers\.target$/m);
    });
  });

  describe('lab-netwatch (hand-installed before g7-netwatch) is removed from devices', () => {
    const OLD = [
      '/usr/local/sbin/lab-netwatch',
      '/etc/systemd/system/lab-netwatch.service',
      '/etc/systemd/system/lab-netwatch.timer',
      '/etc/systemd/system/timers.target.wants/lab-netwatch.timer',
    ];
    const rmLines = (f) => read(f).split('\n').filter((l) => /\brm\b/.test(l) && l.includes('lab-netwatch'))
      .map((l) => l.trim());

    it('install.sh stops and disables the old timer (tolerating its absence), then removes the files', () => {
      const s = read('install.sh');
      const disable = s.indexOf('systemctl disable --now lab-netwatch.timer >/dev/null 2>&1 || true');
      disable.should.be.above(-1);
      rmLines('install.sh').should.eql([`rm -f ${OLD.join(' ')}`]);
      s.indexOf(rmLines('install.sh')[0]).should.be.above(disable);
      s.indexOf('systemctl daemon-reload').should.be.above(s.indexOf(rmLines('install.sh')[0]));
    });

    it('update-readonly.sh removes them from the card by literal paths, inside the unlocked window, and verifies', () => {
      const s = read('update-readonly.sh');
      rmLines('update-readonly.sh').should.eql(OLD.map((p) => `rm -f /media/root-ro${p}`));
      const list = /^LAB_NETWATCH="([^"]*)"/m.exec(s);
      list[1].split(/\s+/).filter(Boolean).should.eql(OLD.map((p) => `/media/root-ro${p}`));
      const decide = s.indexOf('for p in $LAB_NETWATCH; do');
      const unlock = s.indexOf('mount -o remount,rw "$L"');
      const rm = s.indexOf(`rm -f /media/root-ro${OLD[0]}`);
      const relock = s.indexOf('\nrelock\n');
      decide.should.be.above(-1);
      unlock.should.be.above(decide); // decided before unlocking
      rm.should.be.above(unlock);
      relock.should.be.above(rm);
      s.should.match(/rm -f \/media\/root-ro\/etc\/systemd\/system\/timers\.target\.wants\/lab-netwatch\.timer\n\s*drop_caches/);
      s.indexOf('for p in $LAB_NETWATCH; do', relock).should.be.above(relock); // checked after relocking
    });

    it('is not mirrored onto the card', () => {
      mirroredPaths().filter((p) => p.includes('lab-netwatch')).should.eql([]);
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

  describe('g7-central-apply (the watchdog runs it after a restart)', () => {
    it('asks bluetoothctl only under a time limit', () => {
      const code = read('g7-central-apply.sh').split('\n').filter((l) => !/^\s*#/.test(l));
      const calls = code.filter((l) => /bluetoothctl/.test(l));
      calls.length.should.be.above(0);
      calls.forEach((l) => l.should.match(/timeout \d+ bluetoothctl/));
    });
  });

  describe('install.sh and Node under /opt/node', () => {
    it('warns when /opt/node/bin/node (what g7-rig-remote runs) is missing', () => {
      read('g7-rig-remote.sh').should.match(/NODE=\$\{G7RIG_NODE:-\/opt\/node\/bin\/node\}/);
      read('install.sh').should.match(/\[ -x \/opt\/node\/bin\/node \] \|\| echo "warning: /);
    });
  });

  describe('lookout.env.example', () => {
    // eslint-disable-next-line global-require
    const env = require('../lib/g7rig/env');
    const args = () => env.readArgs(read('lookout.env.example'));

    it('has the fleet collector shape: watch slot, no xDripAPS, no auto-pair, no reboot, no pin', () => {
      const a = args();
      a.medical.should.equal(false);
      should(a.sensorAddress).be.null();
      const tokens = a.args.split(/\s+/);
      tokens.should.containDeep(['--openaps', '--display_type', 'watch', '--no_xdripaps', '--no_auto_pair', '--no_reboot']);
      tokens[tokens.indexOf('--display_type') + 1].should.equal('watch');
    });

    it('is what g7-rig pair would leave unchanged (fleet flags and slot already there)', () => {
      const text = read('lookout.env.example');
      ['--no_auto_pair', '--no_reboot'].reduce((t, f) => env.ensureFlag(t, f), env.ensureDisplayType(text))
        .should.equal(text);
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

    it('runs the local-only g7-rig command at nice 10 every 5 minutes, with 6 min to finish', () => {
      const svc = fs.readFileSync(path.join(DEPLOY, 'systemd', 'g7-bt-watchdog.service'), 'utf8');
      svc.should.match(/^ExecStart=@NODE_BIN@\/node \/usr\/local\/sbin\/g7-rig\.js bt-watchdog$/m);
      // nice 19 / idle I/O starved it on a saturated Pi Zero: it is the recovery path
      svc.should.match(/^Nice=10$/m);
      svc.should.not.match(/^IOSchedulingClass=idle$/m);
      svc.should.match(/^TimeoutStartSec=6min$/m); // test/g7rig-cli.js checks the helpers' limits fit
      const timer = fs.readFileSync(path.join(DEPLOY, 'systemd', 'g7-bt-watchdog.timer'), 'utf8');
      timer.should.match(/^OnUnitActiveSec=5min$/m);
      timer.should.match(/^WantedBy=timers\.target$/m);
    });
  });
});
