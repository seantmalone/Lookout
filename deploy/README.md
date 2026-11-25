# Lookout collectors for a Dexcom G7

How to set up, run and debug a **collector**: a Raspberry Pi that reads a
Dexcom G7 with Lookout and uploads to Nightscout, as one of a fleet managed
by a separate UI device. Tested with a Pi Zero W (single core), Raspberry Pi
OS 13 (trixie) with BlueZ 5.82 and systemd 257, and Node 22.

Placeholders used below: `collector-a`, `collector-b` (collectors),
`ui-device` (the fleet UI), `pi` (the login user that runs Lookout),
`1234` (a sensor code), `DXCMxx` (a sensor name), `AA:BB:CC:DD:EE:FF` (a
Bluetooth address).

## Contents

1. [What a collector is](#1-what-a-collector-is)
2. [Setting up a collector](#2-setting-up-a-collector)
3. [Updating a collector](#3-updating-a-collector)
4. [Pairing a sensor](#4-pairing-a-sensor)
5. [Safe to unplug: the read-only card](#5-safe-to-unplug-the-read-only-card)
6. [Memory, watchdogs and health](#6-memory-watchdogs-and-health)
7. [Troubleshooting](#7-troubleshooting)
8. [Testing another Lookout or xdrip-js build on a collector](#8-testing-another-lookout-or-xdrip-js-build-on-a-collector)
9. [Known limits and open questions](#9-known-limits-and-open-questions)

## 1. What a collector is

### The fleet model

Lookout reads the G7 on the **watch** display slot (3), so the pump (slot 1,
for example an Omnipod 5) and the phone app (slot 2) keep their own
connections. Several collectors (in different rooms, say) read the same
sensor on that one slot:

- **One shared key.** A G7 slot holds one pairing key. One collector pairs;
  the fleet UI copies the resulting key to the others. If each collector
  paired by itself, every pairing would replace the slot's key and lock the
  others out.
- **One shared Bluetooth address.** The G7 ties the slot's key to the
  Bluetooth address of the collector that paired: a key presented from any
  other address is refused. So every collector presents the same public
  address. The address travels with the key (`central` in the key record);
  `import-key` stores it in `/etc/g7-central`, and `g7-central.service`
  (`/usr/local/sbin/g7-central-apply`) sets the adapter to it at every boot,
  after `bluetooth.service` and before `lookout.service`. The collector that
  paired already has that address and needs no `/etc/g7-central` (it gets
  one only if the UI imports the record into it as well).
- **Never pairs by itself** (`--no_auto_pair`). A collector with a key
  only authenticates with it; if the sensor refuses it, Lookout logs it,
  marks the key rejected (`pairing.state` `failed` in `status`) and waits.
  It runs a pairing only when `g7-rig pair` asked for one.
- **Never reboots on failed reads** (`--no_reboot`). Upstream Lookout
  reboots the rig after repeated failed reads. In a fleet, failed reads
  usually just mean the wearer is near another collector.
- **No duplicate uploads.** In fleet mode Lookout asks Nightscout for an
  `sgv` entry within 2.5 minutes of a reading before uploading it, so one
  reading heard by two collectors is stored once. If that check fails it
  uploads anyway.
- **Managed over SSH.** The UI device (a separate project, with its own
  `dexcom-ui.service`; it can be a collector too) polls every collector through a locked-down
  account and runs the commands below.

### g7-rig: the UI's interface

`/usr/local/sbin/g7-rig.js` (its logic in `/usr/local/lib/g7rig`), run as
root. Over SSH only these forms are accepted:

| Command | What it does |
|---|---|
| `status` | JSON: host, Lookout version and state, the sensor (`code`, `name`, `address`, `key_fingerprint`, `session_start`, `session_length_s`, `paired_at`, `central`), `last_reading`, `last_heard`, `pairing` (`idle`, `waiting`, `paired`, `failed`), up to 5 recent error lines and `health` ([section 6](#health-in-g7-rig-status)). Only a fingerprint of the key (first 12 hex characters of its SHA-256), never the key. |
| `pair NNNN` | Starts a pairing with code `NNNN` ([section 4](#4-pairing-a-sensor)). Returns within seconds. |
| `export-key` | Prints `{code, name, address, key, central, paired_at}` (`name` may be null; `central` and `paired_at` may be missing). The only command that outputs the key. |
| `import-key` | Reads that record on stdin: stores the key, code, name and `paired_at`, removes the old Bluetooth bonds, writes `/etc/g7-central` and sets the adapter's address if the record has `central`, saves to the card, restarts Lookout. |
| `scan DXCMxx` | Listens 70 s for that sensor name; prints `{heard, rssi, address}`. A diagnostic: pairing does not use it. |

`pair` and `import-key` also make the env file a collector's: they add
`--no_auto_pair`, `--no_reboot` and `--display_type watch` if missing,
remove any `--sensor_address` pin, and refuse (exit 3) if `LOOKOUT_ARGS`
selects the medical slot (`--display_type medical`, `--force_medical_slot`,
`--alternate`). Exit codes: 0 ok, 1 error, 2 rejected command, 3 refused.

Two more commands run only locally, from systemd units: `persist`
([section 5](#5-safe-to-unplug-the-read-only-card)) and `bt-watchdog`
([section 6](#the-bluetooth-watchdog)). To run any command on the collector
itself:

```sh
sudo /opt/node/bin/node /usr/local/sbin/g7-rig.js status
```

### The g7rig account

`deploy/setup-g7rig-access.sh` creates the system user `g7rig`:

- **No password** (`*`), login only with the UI's key, in
  `~g7rig/.ssh/authorized_keys` as
  `restrict,command="sudo /usr/local/sbin/g7-rig-remote" <key>`: whatever
  the UI asks for, sshd runs the forced command, with no shell, port
  forwarding or terminal.
- **sudoers** (`/etc/sudoers.d/g7rig`): `g7rig` may run exactly
  `/usr/local/sbin/g7-rig-remote` as root, keeping `SSH_ORIGINAL_COMMAND`.
- **The wrapper** (`/usr/local/sbin/g7-rig-remote`) accepts exactly the
  forms in the table above (`DXCM` plus 2 letters or digits, 4 digits) and
  logs and rejects anything else (exit 2); `g7-rig.js` checks the same rules
  again. It runs `/opt/node/bin/node` (sudo resets `PATH`).
- **Priority.** The wrapper runs `g7-rig.js` at nice 10 and, where
  `ionice` exists, best-effort I/O priority 7: low enough not to disturb
  Lookout (nice -15), high enough to finish while bluetoothd and
  dbus-daemon (nice 0) are busy. At nice 19 with idle I/O, `status` missed
  the UI's timeout during every failing Lookout read.
- **Linger** (`loginctl enable-linger g7rig`): keeps g7rig's systemd user
  manager running; otherwise each SSH login (one a minute from the UI)
  starts a fresh one, about 2.5 s of CPU on a Pi Zero.

### Why the system changes are needed

- **`bluetooth.service.d/g7.conf`** (`bluetoothd --noplugin=gap`). After
  service discovery, BlueZ's GAP plugin reads the G7's preferred connection
  parameters and applies them: 75 ms interval with peripheral latency 40.
  That lets the sensor skip up to 3 s of connection events, so it misses
  Lookout's J-PAKE replies and hangs up, with status `0a0300` or a silent
  drop. The Dexcom app on Android keeps latency 0. This plugin is the only
  BlueZ change; the stock `bluetoothd` is used.
- **`lookout.service.d/priority.conf`** (`Nice=-15`). A G7 allows about 3.3 s
  per pairing step. On a single-core Pi Zero, dbus-daemon, NetworkManager and
  bluetoothd handle every Bluetooth notification and compete with Lookout's
  replies. A multi-core Pi (Zero 2 W or later) has more headroom.
- **`--no_xdripaps`**. Skips posting to a local OpenAPS xDripAPS server on
  127.0.0.1:5000, which a Lookout-only rig doesn't have.
- **`--openaps`**. Lookout watches a few OpenAPS files there. The default,
  `/root/myopenaps`, cannot be read by the non-root user Lookout runs as;
  point it at a directory in that user's home. It need not exist.

Pairing details live in xdrip-js: P-256 maths through OpenSSL, proof checks
deferred until after each reply, write-without-response fragments, and the
Authentication subscription made before ExtraData.

### What is installed where

| On the collector | From | By |
|---|---|---|
| `/etc/systemd/system/lookout.service`, `lookout.service.d/priority.conf` | `deploy/systemd/` | `install.sh` |
| `/etc/systemd/system/bluetooth.service.d/g7.conf` | `deploy/systemd/` | `install.sh` |
| `/etc/lookout.env` (only if missing) | `deploy/lookout.env.example` | `install.sh` |
| `/usr/local/sbin/g7-rig.js`, `/usr/local/lib/g7rig/*.js`, `/usr/local/sbin/g7-rig-remote` | `deploy/`, `lib/g7rig/` | `install.sh`, `setup-g7rig-access.sh` |
| `/usr/local/sbin/g7-central-apply`, `g7-central.service` (enabled) | `deploy/` | `install.sh` |
| `g7-bt-watchdog.service`, `g7-bt-watchdog.timer` (enabled) | `deploy/systemd/` | `install.sh` |
| `/usr/local/sbin/g7-alive`, `g7-alive.service` (enabled) | `deploy/` | `install.sh` |
| `/usr/local/sbin/g7-netwatch`, `g7-netwatch.service`, `g7-netwatch.timer` (enabled) | `deploy/` | `install.sh` |
| user `g7rig` (linger), its `authorized_keys`, `/etc/sudoers.d/g7rig` | | `setup-g7rig-access.sh` |
| `/etc/systemd/journald.conf.d/zz-unplug-safe.conf`; apt-daily, apt-daily-upgrade, man-db timers and unattended-upgrades off; `/boot/firmware` read-only in `/etc/fstab`; `dtoverlay=vc4-kms-v3d,cma-64`; `/etc/NetworkManager/conf.d/90-g7-wifi-powersave.conf` (Wi-Fi power save off); an active `TemporaryTimeout = 0` in `/etc/bluetooth/main.conf` back to the shipped `#TemporaryTimeout = 30` | generated / edited | `harden.sh` (`update-readonly.sh` copies the Wi-Fi drop-in to a read-only card and applies the same `main.conf` correction to the card's copy) |
| `g7-persist.service`, `g7-persist.timer`, `g7-persist.path` (enabled); `systemd-remount-fs.service.d/overlayroot.conf`; `/etc/rpi/swap.conf.d/90-g7-readonly.conf`; packages `overlayroot`, `rsync`; `overlayroot=tmpfs` in `/boot/firmware/cmdline.txt` | `deploy/systemd/`, generated | `readonly.sh enable` (`units` for the first three) |
| `/etc/g7-central` | the key record | `g7-rig import-key` |

`install.sh` also deletes `/usr/local/sbin/g7-new-sensor`, an older script
that `g7-rig pair` replaced, and `lab-netwatch` (`/usr/local/sbin/lab-netwatch`,
`lab-netwatch.service`, `lab-netwatch.timer` and its enable link), an
earlier version of g7-netwatch installed by hand on one collector; it stops
and disables that timer first. `update-readonly.sh` deletes both from the
card.

## 2. Setting up a collector

In this order; steps 1 to 9 on a writable card, because once the card is
read-only (step 10) changes to the system last only until the next boot.

1. **Flash** Raspberry Pi OS Lite 13 (trixie), 32-bit for a Pi Zero W, with
   Raspberry Pi Imager: set the host name, the user, Wi-Fi and your SSH key
   there. Its kernel command line already has `fsck.repair=yes` (`harden.sh`
   checks it); keep it.
2. **Wi-Fi power save off.** With it on, the collectors' Wi-Fi dropped under
   load. `harden.sh` (step 9) turns it off for every Wi-Fi connection,
   present and future: it writes the NetworkManager drop-in
   `/etc/NetworkManager/conf.d/90-g7-wifi-powersave.conf`
   (`[connection]` / `wifi.powersave = 2`, i.e. disable), the default for
   any connection that does not set power save itself. It does not restart
   NetworkManager (that would cut an SSH session over Wi-Fi); it reloads its
   configuration, and existing connections pick the default up when they
   next reconnect or after a reboot. It prints the active Wi-Fi
   connection's own setting. To check a connection, or to turn power save
   off for one connection immediately (a connection that sets `enable`
   itself is not changed by the drop-in):

   ```sh
   nmcli -t -f NAME,TYPE connection show            # the Wi-Fi connection's name
   nmcli -g 802-11-wireless.powersave connection show "<connection>"   # disable, or default (= the drop-in)
   sudo nmcli connection modify "<connection>" 802-11-wireless.powersave disable
   ```

   A `modify` is active after the connection is next brought up (or a
   reboot).
3. **Bluetooth not blocked.** `rfkill` is not installed on Raspberry Pi OS
   Lite; read the state from `/sys` (`soft` and `hard` must be 0 for the
   `bluetooth` entry), and check that the adapter is powered:

   ```sh
   grep . /sys/class/rfkill/rfkill*/type /sys/class/rfkill/rfkill*/soft /sys/class/rfkill/rfkill*/hard
   bluetoothctl show | grep -E 'Controller|Powered'
   ```

   To unblock: `echo 0 | sudo tee /sys/class/rfkill/rfkillN/soft` (N from
   the listing). systemd-rfkill restores the saved state at each boot, which
   on a read-only card is the one saved on the card: unblock before step 10.

   Leave `TemporaryTimeout` in `/etc/bluetooth/main.conf` at BlueZ's
   default (the shipped, commented `#TemporaryTimeout = 30`). With 0,
   bluetoothd never forgets a device it saw while discovering, and after a
   few days it is too slow to answer
   ([section 6](#a-collector-that-stopped-answering-2026-11-24)).
   `harden.sh` (step 9) puts an active 0 back to the default and reports
   any other value.
4. **Node 22 in `/opt/node`.** The devices run Node v22.23.4 there;
   `g7-rig-remote` and the units expect `/opt/node/bin/node`. The Pi Zero W
   is ARMv6, for which nodejs.org has no official builds; the unofficial
   builds have one (`node-v22.x.y-linux-armv6l.tar.xz` from
   https://unofficial-builds.nodejs.org/download/release/). On a newer Pi
   use the official `linux-armv7l` or `linux-arm64` build.

   ```sh
   V=v22.x.y                                  # a current Node 22 release
   curl -fLO https://unofficial-builds.nodejs.org/download/release/$V/node-$V-linux-armv6l.tar.xz
   sudo mkdir -p /opt/node
   sudo tar -xJf node-$V-linux-armv6l.tar.xz -C /opt/node --strip-components=1
   echo 'PATH=/opt/node/bin:$PATH' >> ~/.profile && . ~/.profile
   node --version
   ```

5. **Checkout.** This fork's `g7-fixes` branch of Lookout in `~/src/Lookout`,
   and `npm install` there. The fleet also needs this fork's xdrip-js
   (`g7-fixes`, [section 9](#9-known-limits-and-open-questions)).
   `package.json` names that branch and `package-lock.json` pins a commit of
   it with the fleet changes, so a plain `npm install` gives a working fleet
   collector:

   ```sh
   cd ~/src/Lookout && npm install
   ```

   A checkout of xdrip-js next to Lookout, linked in place of the installed
   one, is only for developing xdrip-js:

   ```sh
   rm -rf node_modules/xdrip-js && ln -s ../../xdrip-js node_modules/xdrip-js   # ~/src/xdrip-js, branch g7-fixes
   (cd ~/src/xdrip-js && npm install --omit=dev)                              # its own dependencies
   ```

   `update-readonly.sh` copies such a linked xdrip-js checkout onto the card
   along with Lookout (not its `node_modules`). How the devices' checkouts
   and dependencies were first installed is not recorded.
6. **`sudo deploy/install.sh`**: the units, the Bluetooth fix, g7-rig, the
   three watchdogs (Bluetooth, alive, network;
   [table above](#what-is-installed-where)). It restarts `bluetooth` and
   `g7-alive` and enables the network watchdog's timer, so there is nothing
   else to do for them; it never restarts Lookout. Re-run it after every
   update (on a read-only card `update-readonly.sh` does).
7. **The env file**: `sudoedit /etc/lookout.env`. Set `NIGHTSCOUT_HOST` and
   `API_SECRET`, and `LOOKOUT_ARGS` in this shape (the example has it; the
   devices run exactly these options):

   ```sh
   LOOKOUT_ARGS=--openaps /home/pi/myopenaps --display_type watch --no_xdripaps --no_auto_pair --no_reboot
   ```

   Never `--force_medical_slot` or `--display_type medical`: slot 1 is the
   pump's. Then `sudo systemctl enable --now lookout`. Lookout creates its
   `storage` directory on its first start (`readonly.sh enable` needs it).
   With `--no_auto_pair` and no key it logs `Fleet mode: not connecting
   (waiting for a key)` every 30 s until the
   UI copies the fleet's key or you pair ([section 4](#4-pairing-a-sensor)).
8. **Access for the UI**, once per collector, with the UI's public key:

   ```sh
   sudo deploy/setup-g7rig-access.sh "$(cat ui-key.pub)"
   ssh -i <ui private key> g7rig@collector-a status      # from the UI device
   ```

   Then add the collector to the UI's configuration (see the UI project).
9. **`sudo deploy/harden.sh`**: logs in RAM, no unattended apt/man-db
   activity, boot partition read-only, the `fsck.repair=yes` check, 64 MB
   CMA, Wi-Fi power save off (step 2), and BlueZ's `TemporaryTimeout`
   (step 3: an active `TemporaryTimeout = 0` line in
   `/etc/bluetooth/main.conf` becomes the shipped `#TemporaryTimeout = 30`;
   it prints the value either way and does not restart Bluetooth)
   ([section 5](#5-safe-to-unplug-the-read-only-card) and
   [6](#6-memory-watchdogs-and-health)).
10. **`sudo deploy/readonly.sh enable --reboot`**: the read-only card
    ([section 5](#5-safe-to-unplug-the-read-only-card)). It installs
    `overlayroot` and `rsync` if missing, the persist units and the swap
    drop-in, and reboots.

What takes effect when:

| Change | Active |
|---|---|
| `install.sh` (units, g7-rig, watchdogs, Bluetooth fix) | at once (Lookout: after `systemctl restart lookout`) |
| `/etc/lookout.env` | at the next Lookout restart |
| `setup-g7rig-access.sh` | at once |
| `harden.sh`: journald, apt timers, boot partition read-only | at once |
| `harden.sh`: 64 MB CMA | next boot |
| `harden.sh`: Wi-Fi power save off | when a connection next reconnects, or the next boot |
| `harden.sh`: `TemporaryTimeout` back to the default | after `sudo systemctl restart bluetooth`, or the next boot |
| `readonly.sh enable` / `disable` | next boot |
| swap drop-in (`readonly.sh enable` / `units`) | next boot |
| `/etc/g7-central` | at once when `import-key` writes it; at every boot after |

**A standalone rig** (no fleet UI, pairs by itself) needs only steps 1 to 7
(and 9, 10 if it is unplugged without shutdown): leave `--no_auto_pair` and
`--no_reboot` out of `LOOKOUT_ARGS`, and set the code with
`~/src/Lookout/lookout.js id 1234`, which also clears the old key and
calibration. `--sensor_address AA:BB:CC:DD:EE:FF` pins such a rig to one
sensor.

## 3. Updating a collector

On a **writable** card: update the checkout, `sudo deploy/install.sh`,
`sudo systemctl restart lookout`.

On a **read-only** card everything written goes to RAM, so the update must
also be written onto the card:

```sh
rsync -rlt --exclude=node_modules --exclude=/storage --exclude='/storage.*' --exclude=.git Lookout/ pi@collector-a:src/Lookout/   # from your computer
ssh pi@collector-a
sudo ~/src/Lookout/deploy/update-readonly.sh
sudo systemctl restart lookout        # or reboot
```

`update-readonly.sh` runs `install.sh` and `readonly.sh units` on the
running system, stages Lookout's code (without `node_modules` and
`storage`), a linked xdrip-js checkout and every installed file in RAM, then
unlocks the card, copies them onto it, deletes the old swap file, the old
`g7-new-sensor` and the hand-installed `lab-netwatch` from the card itself (literal paths, never through the
overlay), drops the caches, relocks the card and checks byte for byte that
the card has what was staged. Lookout's storage, the env file and
`/etc/g7-central` are left to `g7-rig persist`. A reboot is needed only
for a swap change. Not covered: `node_modules` (to change dependencies:
`readonly.sh disable --reboot`, `npm install`, `install.sh`,
`readonly.sh enable --reboot`), the g7rig account, `harden.sh`'s changes
under `/etc` other than the Wi-Fi power-save drop-in (which it copies to the
card when the running system has it) and the `TemporaryTimeout` correction
(when the card's `/etc/bluetooth/main.conf` still has an active
`TemporaryTimeout = 0` and `harden.sh` has corrected the running system, it
applies the same one-line change to the card's own copy, in the unlocked
window, and checks it after relocking; the file is not mirrored as a whole),
and anything else outside its list; use the same
disable/enable round for those. `harden.sh`'s CMA edit does work on a
read-only card (the boot partition is not under the overlay; it takes
effect at the next boot).

## 4. Pairing a sensor

The UI's New sensor screen runs this on one collector:

```sh
ssh g7rig@collector-a pair 1234
```

Only the 4-digit code from the sensor package is needed. `pair` stops
Lookout, stores the code and a pair request, clears the old key, name,
`paired_at`, calibration (back to unity) and the old sensor's Bluetooth
bond, makes the env file a collector's (no pin), saves to the card and
starts Lookout again. It returns at once.

Lookout (with `--no_auto_pair` and the pair request) then connects to each
`DXCM` sensor it hears and runs the pairing with the code. The sensor that
accepts it is the right one: Lookout stores its key with that sensor's
address (`sensorKey`) and from then on connects only to that address.
The name (`DXCMxx`) is learned from that sensor's advertisement afterwards.
A sensor pairs at its next 5-minute reading; `status` shows `pairing.state`
`waiting`, then `paired`, or `failed` (`not heard` after 15 minutes,
`rejected: check the code`).

The key reaches the other collectors through the UI: `export-key` on the
collector that paired, `import-key` on each of the others; the UI's sync
repeats that for any collector that was offline. The record carries the
shared Bluetooth address (`central`, [section 1](#the-fleet-model)).

**`paired_at`** is when the key was paired (Lookout stores `pairedAt` when a
requested pairing succeeds; `import-key` copies it). The UI keeps its own
record of the current key with its `paired_at`; when a collector holds a
different key paired *after* that record (say a pairing that finished after
the UI gave up waiting), the UI adopts that key and shares it, instead of
overwriting it with the older one.

If you can, pair before the pump and the phone app connect to a fresh
sensor. Pairing a running sensor also works.

## 5. Safe to unplug: the read-only card

Collectors get moved around and some have no screen, so they must survive
losing power at any moment.

- **`harden.sh`**: logs in RAM (journald `Storage=volatile`, the
  `zz-` drop-in wins over earlier ones), no unattended package activity
  (a power cut mid-upgrade can break dpkg), boot partition read-only (to
  update the kernel: `sudo mount -o remount,rw /boot/firmware`, upgrade,
  reboot), automatic fsck at boot, 64 MB CMA, Wi-Fi power save off, BlueZ's
  `TemporaryTimeout` at its default. Lookout and g7-rig write their
  data crash-safely (temp file, fsync, rename, fsync the directory).
- **`readonly.sh enable`**: the whole card is mounted read-only under a RAM
  overlay (overlayroot, about 214 MB on a Pi Zero W); everything written
  while running goes to RAM and is gone after a power cut. The card itself
  is at `/media/root-ro`, the RAM layer at `/media/root-rw`.

**What `g7-rig persist` saves.** It unlocks the card, writes crash-safely
and relocks it (verified):

- Lookout's sensor items: `id` (code), `sensorKey`, `sensorName`,
  `pairRequest`, `keyRejected`, `sessionLengthSeconds`, `meterid`,
  `pairedAt`
- `/etc/lookout.env` and `/etc/g7-central`
- the Bluetooth bond of the current sensor (the stored key's address); the
  bonds of other `DXCM` sensors are removed from the card

The rest of Lookout's storage (reading history etc.) is removed from the
card: each boot starts clean, and Nightscout keeps the history. It runs
after `g7-rig pair` / `import-key`, whenever one of those files changes
(`g7-persist.path`), and at boot and hourly (`g7-persist.timer`).

**Status and software changes:** `sudo deploy/readonly.sh status`. For
changes `update-readonly.sh` does not cover:
`sudo deploy/readonly.sh disable --reboot`, change, then
`sudo deploy/readonly.sh enable --reboot`. One file on its own:
`sudo deploy/readonly.sh install SRC DST [MODE [OWNER:GROUP]]` puts it on
the running system and the card. To change a file on the card by hand:
`sudo mount -o remount,rw /media/root-ro`, change it under `/media/root-ro`,
`sudo mount -o remount,ro /media/root-ro`. Reading a file through `/` after
changing it on the card underneath is undefined (overlayfs) unless the
running system has its own copy, as `readonly.sh install` and
`update-readonly.sh` arrange; otherwise reboot before relying on it.

**Relocking and "the card is still writable".** A remount to read-only
right after writing can say "mount point is busy" for a while, so every
relock retries for up to 60 s. A file deleted on the card that the overlay
still has cached (it was opened through the overlay) stays "unlinked but in
use" on the card, and every remount to read-only then fails even though no
process has it open. `sync; echo 2 > /proc/sys/vm/drop_caches` releases it;
`g7-rig persist` and `update-readonly.sh` do that themselves after 5 failed
tries (`readonly.sh install` only retries).
By hand: [section 7](#the-card-will-not-relock).

## 6. Memory, watchdogs and health

### Memory on a read-only card (found 2026-11-15)

What went wrong, on both collectors (Raspberry Pi OS 13, read-only card,
RAM overlay of about 214 MB):

- **Swap file resize loop.** rpi-swap 1.2.4 defaults to `Mechanism=auto`
  (zram plus a swap file). The card still held a 426 MB `/var/swap` from
  before read-only mode. `rpi-resize-swap-file.service` tried to resize it
  about once a minute, forever: opening it for writing through the overlay
  copies it into the RAM overlay, which fills up, and it fails with
  `truncate: cannot open '/var/swap' for writing: No space left on device`
  (1,022 times in 23 hours on one Pi). Each try cost about 9 s of CPU on the
  single core and a spike of about 200 MB of RAM (shmem).
- **CMA.** `dtoverlay=vc4-kms-v3d` in `/boot/firmware/config.txt` reserves
  256 MB of the Pi's 437 MB as CMA (`CmaTotal: 262144 kB`). The kernel's own
  allocations cannot use it, so during those spikes the kernel ran out:
  18 oom-killer kills in a day on one Pi.
- **Deaf Bluetooth.** After one such burst the adapter delivered no
  advertisements at all for six hours (BlueZ still said `Discovering: yes`;
  `btmon` showed no "LE Advertising Report" in 12 s), so Lookout read
  nothing. `systemctl restart bluetooth` fixed it: the adapter kept the
  fleet address and heard 718 advertisements in 20 s.

What the scripts do about it:

- **No swap file.** `readonly.sh enable` and `readonly.sh units` (run by
  `update-readonly.sh`) write `/etc/rpi/swap.conf.d/90-g7-readonly.conf`
  when rpi-swap is installed. It said `Mechanism=zram` at first; since
  2026-11-19 it says `Mechanism=none` ([swap off](#swap-off)). The old swap
  file is deleted from the card itself, never through the overlay: by
  `readonly.sh enable` (`/var/swap`, while the card is still writable) and
  by `update-readonly.sh` (`/media/root-ro/var/swap`, in its unlocked
  window, checked after relocking). `readonly.sh status` shows the mechanism
  and whether the card still has a swap file. Takes effect at the next boot.
- **CMA: 64 MB.** `harden.sh` changes a line that is exactly
  `dtoverlay=vc4-kms-v3d` to `dtoverlay=vc4-kms-v3d,cma-64` (collectors use
  no HDMI). It leaves an overlay line with parameters alone, keeps the old
  file once as `/boot/firmware/config.txt.pre-harden`, and the boot
  partition read-only. Takes effect at the next boot.
- **The Bluetooth watchdog** ([below](#the-bluetooth-watchdog)).

Verified here: the watchdog decision and command sequence (unit tests with a
fake `exec`), the CMA edit on sample config files, `sh -n` of every script.
Checked on the devices before the change: the numbers above, `swap.conf(5)`
(Mechanism values, drop-ins in `/etc/rpi/swap.conf.d/`, zram removes any
existing file) and that the vc4-kms-v3d overlay accepts `cma-64`.
Verified on the devices (2026-11-15, two Pi Zero W collectors, Raspberry Pi OS 13): after
`update-readonly.sh`, `harden.sh` and a reboot, both show `CmaTotal: 65536 kB`, swap on
`/dev/zram0` only, no `/var/swap` on the card, no start of `rpi-resize-swap-file.service`
and no out-of-memory kill since boot, about 255 MB available, the card read-only, and the
watchdog timer running (it heard advertisements on every sample, so it has not had to act).
On the first device the card would not relock after the swap file was deleted until the
caches were dropped by hand; the scripts now do that, and the second device relocked by
itself. Not yet verified: readings after the change (the sensor was out of range of both
devices at the time), and the watchdog actually restarting Bluetooth on a deaf adapter.

### A collector that stalled (2026-11-19)

One collector was unresponsive for more than 31 hours, until it was
power-cycled. The fleet UI's SSH polling connected each time but got no
answer within 20 s. systemd's hardware watchdog (`RuntimeWatchdogSec=1min`;
not set by these scripts: `systemctl show -p RuntimeWatchdogUSec` shows
it) never fired, so the kernel and PID 1 were alive while the rest of
userspace was stalled. Its logs were in RAM, so the cause could not be
established at the time. Two candidates then: the SD card stopped answering
reads, or memory thrash (a zram swap as large as RAM had been enabled a few
days earlier, which lets a Pi grind instead of failing fast). Three
measures followed: `health` in `status`, the alive watchdog and swap off.

**Very probable cause, found five days later** ([below](#a-collector-that-stopped-answering-2026-11-24)):
the same collector had `TemporaryTimeout = 0` in `/etc/bluetooth/main.conf`,
so bluetoothd's device list grew without bound and `bluetoothctl show`,
which `status` ran without its own time limit, took longer than the UI
waited: the UI saw no answer, while the device itself was alive. This is
probable, not proven: that day's logs were in RAM and were lost at the
power cycle. It fits what was seen (SSH connected, no answer to `status`
in 20 s, no watchdog fired), and the setting was a leftover from early
experiments, so it was very probably already there.

### A collector that stopped answering (2026-11-24)

One collector (Pi Zero W, Raspberry Pi OS 13, BlueZ 5.82, read-only card)
showed as busy in the UI for 45 hours and took no reading of its own in
that time. Measured on the device:

- `/etc/bluetooth/main.conf` had an active `TemporaryTimeout = 0`, a
  leftover from early experiments. BlueZ's default is 30 s (the file ships
  it as the commented line `#TemporaryTimeout = 30`); with 0, bluetoothd
  never forgets a device it has seen while discovering.
- After 3.5 days bluetoothd held 1,795 device objects. `busctl tree
  org.bluez` took 68 s, `bluetoothctl show` more than 90 s, and bluetoothd
  used about 40% of the CPU while discovering. The other collector, with the
  default, held no device objects between discovery cycles and answered in
  under a second.
- `g7-rig status` runs `bluetoothctl show` and took 136 s; the UI gives it
  45 s, so it showed the collector as busy.
- The Bluetooth watchdog also runs `bluetoothctl show`. Its unit hit its
  start timeout on every run (`start operation timed out. Terminating.`)
  and never acted; it only covered "discovering but nothing heard", not "bluetoothd
  does not answer".
- After restoring the default and `systemctl restart bluetooth`:
  `bluetoothctl show` 0.8 s, `status` 16 s.

What changed:

- **`status` never waits on a helper:** every command it runs has a time
  limit (systemctl 10 s, `bluetoothctl show` 10 s, journalctl 15 s,
  vcgencmd 5 s). When `bluetoothctl show` does not answer, `status` still
  answers, with `bluetooth_powered: null`, `sensor.central: null` and the
  error line `bluetooth: no answer from bluetoothd in 10 s`; `health`
  has `bluetooth_ms`, how long it took ([below](#health-in-g7-rig-status)).
  With bluetoothd hung, `status` takes about 10 s more than usual; with
  every helper hung, at most about 25 s plus Node's start. A command killed
  at its limit now returns even when a child it started still holds its
  output open.
- **The Bluetooth watchdog restarts a bluetoothd that does not answer,**
  warns about a long device list, and has a time limit on every helper
  ([below](#the-bluetooth-watchdog)).
- **`harden.sh` puts the setting back** (an active `TemporaryTimeout = 0`
  becomes `#TemporaryTimeout = 30`), `update-readonly.sh` corrects the
  card's copy, and `readonly.sh status` shows the value.

The [2026-11-19 stall](#a-collector-that-stalled-2026-11-19) of the same
collector was very probably the same thing.

Verified here: the status and watchdog paths with a fake `exec` (a
`bluetoothctl` that never answers, a slow one, every helper hung), the
time-limited `exec` against real processes, the watchdog's decision as a
unit test, `harden.sh`'s and `update-readonly.sh`'s `main.conf` edits and
`readonly.sh status` on scratch files under sh and dash, `sh -n` of every
script. Not verified without a device: `busctl --list tree` output and
timing on a Pi, the watchdog under systemd (Nice=10, the 6 min start limit),
a real restart of a bluetoothd that stopped answering, and the card
correction on a read-only device.
Verified on the devices (2026-11-24, two Pi Zero W collectors): on the affected collector,
restoring the default and restarting Bluetooth took `bluetoothctl show` from more than 90 s
to 0.8 s and `g7-rig status` from 136 s to 16 s; bluetoothd's device list fell from 1,795
to 20, the UI saw the collector again, and it took a reading on its second cycle. After
deploying the changes above: `status` takes 4 s and reports `bluetooth_ms` (404 ms);
`harden.sh` and `readonly.sh status` report the default on both collectors. With bluetoothd
frozen (`kill -STOP`), `status` returned in 17 s with `bluetooth_powered: null` and the
error line; the watchdog, run by hand twice, logged "(1 of 2)" and then restarted
Bluetooth, which came back with the fleet address. Not verified: the watchdog doing this
from its timer (only by hand), the device-count warning on a real overgrown list, and
`harden.sh` correcting a file that still has the 0 (the device was fixed by hand first).

### The Bluetooth watchdog

`g7-bt-watchdog.timer` (installed and enabled by `install.sh`) runs
`g7-rig.js bt-watchdog` every 5 minutes at nice 10. It restarts
Bluetooth for either of two reasons:

- **Deaf adapter.** When `bluetooth.service` is active and the adapter is
  powered and discovering, it counts "LE Advertising Report" / "LE Extended
  Advertising Report" lines in 10 s of `btmon` (under `timeout`). After 3
  empty samples in a row it restarts. A failed `btmon` does not count as an
  empty sample.
- **bluetoothd does not answer.** `bluetoothctl show` gets 15 s. No answer
  in that time on 2 runs in a row (about 5 minutes apart) restarts. A
  `bluetoothctl` that fails at once (e.g. no controller) is not a missed
  answer, and any answer starts the count again.

A restart is `systemctl restart bluetooth` and then `g7-central-apply` (if
installed) for the fleet address. At most one restart an hour, for both
reasons together; its state is in `/run/g7-rig/btwatch.json` (cleared at
reboot).

When bluetoothd answers, it also counts the device objects bluetoothd holds
(`busctl --system --list tree org.bluez`, 5 s limit). Above 500, or when
the listing does not finish in 5 s, it logs one warning an hour; it does
not restart for that alone.

It logs nothing while all is well. Otherwise (one line per run):

```
bt-watchdog: discovering but no advertisements heard in 10 s (1 of 3)
bt-watchdog: adapter discovering but no advertisements heard in 3 samples of 10 s; restarting bluetooth
bt-watchdog: still no advertisements; not restarting again yet (last restart 12 min ago, at most one per hour)
bt-watchdog: bluetoothd did not answer in 15 s (1 of 2)
bt-watchdog: bluetoothd not answering: restarting bluetooth
bt-watchdog: bluetoothd still not answering; not restarting again yet (last restart 12 min ago, at most one per hour)
bt-watchdog: WARNING: bluetoothd is tracking 1795 devices: check TemporaryTimeout in /etc/bluetooth/main.conf
bt-watchdog: WARNING: bluetoothd could not list its devices in 5 s: check TemporaryTimeout in /etc/bluetooth/main.conf
```

Every helper it runs has a time limit (systemctl 10 s, `bluetoothctl show`
15 s, busctl 5 s, btmon 20 s, the restart 100 s, `g7-central-apply`
120 s). The longest path, a restart, adds up to 270 s; the unit's
`TimeoutStartSec` is 6 minutes. It ran at nice 19 with idle I/O before
2026-11-24; on a saturated single core that starved it, so it is now nice
10 with low best-effort I/O.

**Testing the no-answer path** (stops Bluetooth on that collector for up to
about 10 minutes: no readings from it meanwhile; watch
`journalctl -u g7-bt-watchdog.service -f` from a second SSH session):

```sh
sudo kill -STOP "$(systemctl show -p MainPID --value bluetooth)"   # freeze bluetoothd
time bluetoothctl show            # hangs: Ctrl-C it
sudo /opt/node/bin/node /usr/local/sbin/g7-rig.js status   # ~10 s; "bluetooth_powered":null, the error line
```

At the watchdog's next run: `bluetoothd did not answer in 15 s (1 of 2)`;
at the run after (about 5 minutes later): `bluetoothd not answering:
restarting bluetooth`, then `g7-central-apply`'s line (`Bluetooth address
already ...` or `set to ...`). `systemctl restart` sends SIGTERM and
SIGCONT, so the frozen bluetoothd exits normally. Then `bluetoothctl show`
answers again and the Controller line is the fleet address. To end the test
early: `sudo kill -CONT "$(systemctl show -p MainPID --value bluetooth)"`.
If a restart happened in the hour before, the watchdog says `still not
answering; not restarting again yet`: then resume it with `kill -CONT` or
`sudo systemctl restart bluetooth && sudo /usr/local/sbin/g7-central-apply`.

### The alive watchdog

`g7-alive.service` (script `/usr/local/sbin/g7-alive`, installed and
enabled by `install.sh`). Every 30 s it runs a program (`date`), reads one
4 KiB block straight from the card (`dd if=/dev/mmcblk0 ... iflag=direct`
under `timeout 60`, so the page cache cannot answer for it; a different
block in the first 16 MB each time), and only if both worked tells systemd
`WATCHDOG=1`. A read error is logged as one line, a read with no answer as
"no answer"; neither notifies. With no notification for 5 minutes
(`WatchdogSec=300`) systemd kills the service (result `watchdog`) and
`FailureAction=reboot-immediate` reboots at once, without a clean shutdown:
the card is read-only, so nothing can be corrupted, and the RAM overlay is
lost at any reboot. It runs at `Nice=-5`, is shielded from the OOM killer,
and does not depend on Lookout or Bluetooth. The card device is the disk
under `/media/root-ro` (else under `/`); if it cannot be found, or cannot be
read when the service starts, it logs that once and checks only that
programs start (so a wrong device cannot cause a reboot loop). A clean stop
(`systemctl stop`/`restart`, shutdown) is not a failure; any other end of
the service (`kill -9`, a crash) reboots too. If PID 1 itself stalls, the
hardware watchdog still reboots.

**Turning it off:** `sudo systemctl disable --now g7-alive.service`. On a
read-only card that lasts until the next boot; to keep it off, also delete
`/media/root-ro/etc/systemd/system/multi-user.target.wants/g7-alive.service`
with the card unlocked. `install.sh` (and so `update-readonly.sh`) enables
it again. If it ever reboots a healthy device, run
`sudo systemctl stop g7-alive` within 5 minutes of boot, then remove that
link.

**Testing it** (watch `journalctl -u g7-alive -f` from a second SSH session;
the journal is in RAM and gone after the reboot):

- Freeze it: `sudo kill -STOP "$(systemctl show -p MainPID --value g7-alive)"`.
  Nothing for 4.5 to 5 minutes, then `Watchdog timeout (limit 5min)!`,
  `Killing process ... with signal SIGKILL`, `Failed with result 'watchdog'`,
  and the Pi reboots at once (the SSH sessions just drop). Afterwards
  `uptime` is a few minutes and `g7-alive` is running again.
- Stop it: `sudo systemctl stop g7-alive`. The log shows `stopped` and
  `Deactivated successfully`; no reboot; `systemctl is-failed g7-alive` says
  `inactive`. `sudo systemctl start g7-alive` arms it again (so does a
  reboot).

### The network watchdog

A Pi Zero W collector twice dropped off Wi-Fi while powered and only came
back after a power cycle. `g7-netwatch.timer` (installed and enabled by
`install.sh`) runs `/usr/local/sbin/g7-netwatch` through
`g7-netwatch.service` 3 minutes after boot and then every minute, at nice
10. Each run pings the default gateway (`ping -c 2 -W 3`); the network is
OK if it answers. No default route counts as down. Each run that is not OK
counts as one minute down; its state is in `/run/g7-netwatch/` (cleared at
reboot).

It reboots (`systemctl reboot`, a normal clean reboot, after one log line
and `journalctl --sync`) in two cases:

- **10 minutes down after the network worked earlier this boot.** That is
  the case it was written for: the Wi-Fi fell over while the device was
  running.
- **60 minutes down when it has not worked at all since boot** (router
  off, wrong Wi-Fi password, out of range). A reboot does not fix these,
  and a collector keeps reading the sensor without a network (uploads catch
  up later), so it waits longer: a long router outage costs at most one
  reboot an hour instead of one every 13 minutes.

It logs nothing while the network is fine. When it is down (the gateway
here is an example):

```
network down: gateway 192.168.1.1 does not answer; rebooting if still down after 10 min
network down: no default route; no network yet since boot, rebooting if still down after 60 min
network still down after 5 min: gateway 192.168.1.1 does not answer
network back after 7 min down (gateway 192.168.1.1 answers)
network down for 10 min after working earlier this boot: rebooting
no network for 60 min since boot: rebooting
```

The first line (or the second) when it first sees the network down, one
"still down" line every 5 minutes, "back" when the gateway answers again,
and one "rebooting" line before it reboots. See them with
`journalctl -t g7-netwatch -b`. While the network is down you cannot reach
the device over it, and the journal is in RAM, so after its reboot these
lines are gone; to see it act, keep `journalctl -t g7-netwatch -f` open on a
local console, or look at the lines from an outage it recovered from.

**Checking it without cutting the network.** `--dry-run` does one check
but never reboots and never writes to the journal; it prints what it would
do instead, and keeps its state in a directory of its own. Pinging an
address that does not answer (192.0.2.1 is reserved for documentation and
never used) stands in for a dead gateway. No `sudo` needed:

```sh
D=/tmp/netwatch-test; rm -rf $D
G7_NETWATCH_STATE_DIR=$D /usr/local/sbin/g7-netwatch --dry-run
for i in 1 2 3 4 5 6 7 8 9 10; do
  G7_NETWATCH_STATE_DIR=$D G7_NETWATCH_GATEWAY=192.0.2.1 /usr/local/sbin/g7-netwatch --dry-run
done
G7_NETWATCH_STATE_DIR=$D /usr/local/sbin/g7-netwatch --dry-run
rm -rf $D
```

The first run prints `network OK: gateway <your gateway> answers (state in
/tmp/netwatch-test)`; the loop (about 4 s a run) prints
`network down: gateway 192.0.2.1 does not answer; rebooting if still down
after 10 min`, then `network still down after 5 min: ...` at the fifth run,
and at the tenth `network down for 10 min after working earlier this boot:
would reboot now (dry run: not rebooting)`; the last run prints
`network back after 10 min down (gateway <your gateway> answers)`. Leave
out the first run to see the never-up case (nothing at 10, the reboot
line at 60). The real watchdog's state is not touched. The other settings
can be changed the same way for a test: `G7_NETWATCH_REBOOT_MIN` (10),
`G7_NETWATCH_NEVER_UP_REBOOT_MIN` (60), `G7_NETWATCH_LOG_EVERY_MIN` (5).

**Turning it off:** `sudo systemctl disable --now g7-netwatch.timer`. On a
read-only card that lasts until the next boot; to keep it off, also delete
`/media/root-ro/etc/systemd/system/timers.target.wants/g7-netwatch.timer`
with the card unlocked. `install.sh` (and so `update-readonly.sh`) enables
it again.

Verified here: the script under sh and dash with stubbed `ip`, `ping`,
`logger`, `journalctl` and `systemctl` (silent when the gateway answers; no
reboot after 9 minutes, one at 10 after having been up; none at 10 and one
at 60 when never up; the recovery line and reset; no default route counts
as down; `--dry-run` never reboots), the install and card-mirror lines,
`sh -n` of every script. Not verified without a device: the timer and
service under systemd, `ping` and `ip` output on a Pi, a real reboot, and
the removal of `lab-netwatch`.
Verified on the devices (2026-11-21, two Pi Zero W collectors): the timer runs every minute on
both, with `up` set and `down` at 0, no log lines and no failed units; the old hand-installed
version was removed from the running system and the card of the device that had it, and the
card relocked. In `--dry-run` with an unreachable test gateway the script logged the outage,
the five-minute reminder and "would reboot now" at minute 10 after a working run, and with no
working run it did not ask for a reboot in the first 12 minutes. Not verified: a real outage
and the reboot itself (the predecessor's reboot was never observed either), and the
60-minute case beyond minute 12.

### Swap off

The rpi-swap drop-in says `Mechanism=none` (no zram, no swap file). About
255 MB is free in normal running, so swap buys little, and without it a
runaway process is killed by the OOM killer quickly instead of the device
grinding; the alive watchdog covers the rest. A device with the earlier
zram drop-in gets the new one from `update-readonly.sh` (it runs
`readonly.sh units`, which rewrites it, and copies it to the card). Takes
effect at the next boot.

### health in g7-rig status

```json
"health": {"load1": 0.93, "mem_total_kb": 437312, "mem_available_kb": 262292,
           "swap_total_kb": 0, "swap_used_kb": 0, "overlay_used_kb": 1640,
           "overlay_total_kb": 219136, "throttled": "0x0", "bluetooth_ms": 812}
```

`load1` from `/proc/loadavg`; memory and swap in kB from `/proc/meminfo`
(`swap_used_kb` = SwapTotal - SwapFree); `overlay_*` = kB used/total of the
RAM overlay at `/media/root-rw` (null when the card is not read-only);
`throttled` = what `vcgencmd get_throttled` prints (non-zero bits mean
under-voltage or throttling, now or since boot; null without vcgencmd);
`bluetooth_ms` = how long `bluetoothctl show` took, in ms (null when it did
not answer within its 10 s; then `bluetooth_powered` is null too and
`errors` has `bluetooth: no answer from bluetoothd in 10 s`). A healthy
collector answers in about a second; many seconds mean a struggling
bluetoothd ([2026-11-24](#a-collector-that-stopped-answering-2026-11-24)).
Any field that cannot be read is null; status never fails because of it.
The only extra cost is one `vcgencmd` run and a statfs. The UI shows and
logs it.

### Checking a device

```sh
sudo /opt/node/bin/node /usr/local/sbin/g7-rig.js status   # "health": {...}, swap 0, throttled "0x0"
grep -E "CmaTotal|Shmem" /proc/meminfo                     # CmaTotal: 65536 kB
sudo dmesg | grep -c "Out of memory"                       # 0 (this boot)
swapon --show; grep Swap /proc/meminfo                     # nothing; SwapTotal: 0 kB
sudo deploy/readonly.sh status    # "swap: off (Mechanism=none)", "swap in use: none", "card swap file: none"
journalctl -u rpi-resize-swap-file.service --since -10min  # no truncate / "No space left" lines
cat /etc/NetworkManager/conf.d/90-g7-wifi-powersave.conf # wifi.powersave = 2
systemctl status g7-alive                                  # active (running)
journalctl -u g7-alive -b         # "card check: one direct read from /dev/mmcblk0 every 30 s"
systemctl show g7-alive -p WatchdogTimestamp               # at most 30 s old
systemctl list-timers g7-bt-watchdog.timer g7-persist.timer
journalctl -u g7-bt-watchdog.service --since -1h           # quiet unless it misses, warns or restarts
grep -n TemporaryTimeout /etc/bluetooth/main.conf          # only the commented #TemporaryTimeout = 30
time bluetoothctl show >/dev/null                          # about a second
sudo deploy/readonly.sh status    # "bluetooth TemporaryTimeout: 30 s (BlueZ default)"
systemctl list-timers g7-netwatch.timer                    # next run within a minute
cat /run/g7-netwatch/down                                  # 0 (minutes down in a row)
journalctl -t g7-netwatch -b                               # nothing unless the network was down
systemctl list-unit-files 'lab-netwatch*'                  # 0 unit files listed (the old one is gone)
```

### Undoing each change

On a read-only card, files under `/media/root-ro` are changed with the card
unlocked ([section 5](#5-safe-to-unplug-the-read-only-card)).

- Swap: delete `/etc/rpi/swap.conf.d/90-g7-readonly.conf` (on a read-only
  card: `/media/root-ro/etc/rpi/swap.conf.d/90-g7-readonly.conf`) and
  reboot. rpi-swap then goes back to its default and creates a swap file
  again, which on a read-only card brings the resize loop back.
  `readonly.sh enable` / `units` (and so `update-readonly.sh`) write the
  drop-in again.
- Wi-Fi power save: delete
  `/etc/NetworkManager/conf.d/90-g7-wifi-powersave.conf` (on a read-only
  card also `/media/root-ro/etc/NetworkManager/conf.d/90-g7-wifi-powersave.conf`),
  `sudo nmcli general reload conf`, and reconnect or reboot. Connections then
  use NetworkManager's own default again. A connection set to `disable` by
  hand keeps it (`nmcli connection modify "<connection>"
  802-11-wireless.powersave default` to clear it). `harden.sh` writes the
  drop-in again if run, and `update-readonly.sh` copies it to the card when
  the running system has it.
- CMA: `sudo mount -o remount,rw /boot/firmware`, change the line back to
  `dtoverlay=vc4-kms-v3d` (or copy `config.txt.pre-harden` over
  `config.txt`), `sudo mount -o remount,ro /boot/firmware`, reboot.
  `harden.sh` changes it again if run.
- Bluetooth watchdog: `sudo systemctl disable --now g7-bt-watchdog.timer`;
  on a read-only card also delete
  `/media/root-ro/etc/systemd/system/timers.target.wants/g7-bt-watchdog.timer`.
  `install.sh` (and so `update-readonly.sh`) enables it again.
- Alive watchdog: [Turning it off](#the-alive-watchdog).
- Network watchdog: `sudo systemctl disable --now g7-netwatch.timer`; on a
  read-only card also delete
  `/media/root-ro/etc/systemd/system/timers.target.wants/g7-netwatch.timer`.
  `install.sh` (and so `update-readonly.sh`) enables it again.

Verified here: the health parsing and the status JSON (unit tests with real
`/proc` text and a fake `exec`), the alive script's rounds with stubbed
commands under sh and dash (good round notifies; failed exec, read error or
read with no answer does not; no device still notifies; READY=1, a clean
exit on SIGTERM), the swap drop-in rewrite and `readonly.sh status` output
on scratch files, `sh -n` of every script. Not verified without a device:
systemd's handling of the unit (notify, watchdog expiry, reboot-immediate,
clean stop), the device found on a real Pi, and direct reads from the card.
Verified on the devices (2026-11-19, two Pi Zero W collectors, Raspberry Pi OS 13, systemd 257):
`g7-alive` found the card as `/dev/mmcblk0` and its heartbeat reaches systemd (the unit's
watchdog timestamp advances every round); a normal `systemctl stop` did not reboot; with the
loop frozen (`kill -STOP`) the device rebooted itself about 4.6 minutes later and was back,
with Lookout running and the card read-only, about 7 minutes after the freeze. After
`update-readonly.sh` and a reboot both devices show `SwapTotal: 0 kB`, `g7-alive` active,
no failed units, and `health` in `g7-rig status` with real figures (about 255 MB available,
overlay 1-8 of 214 MB, `throttled` 0x0). Not verified: a real stall of the SD card or of
userspace (only the frozen loop was tested). It would not have caught the
2026-11-18 stall, whose very probable cause (a bluetoothd too slow to answer,
[2026-11-24](#a-collector-that-stopped-answering-2026-11-24)) left the device itself alive.

## 7. Troubleshooting

Logs are in RAM: `journalctl -b` covers this boot only, and a reboot
(including one by `g7-alive`) loses them. Save what you need first, e.g.
`journalctl -u lookout -b > /tmp/lookout.log` and copy it off.

### No readings

```sh
sudo /opt/node/bin/node /usr/local/sbin/g7-rig.js status
journalctl -u lookout -f | grep -E 'got glucose|uploaded SGV|0a0300|Error'
```

- `lookout_active` false: `systemctl status lookout`, `journalctl -u lookout -b`.
  Lookout rejects unknown options (`LOOKOUT_ARGS`).
- `sensor.key_fingerprint` null and `pairing.state` `idle`: the collector
  has no key and waits for one. The UI's sync copies it; or pair
  ([section 4](#4-pairing-a-sensor)).
- `pairing.state` `failed`, `rejected: check the code`: the sensor refused
  the key (another pairing on the watch slot replaced it, or a wrong code).
  Compare `key_fingerprint` and `paired_at` with the other collectors; the
  UI copies the current key, or pair again.
- `last_heard` old or null: the sensor is out of range, or Bluetooth hears
  nothing ([below](#nothing-heard-on-bluetooth)).
- `last_heard` recent but `last_reading` old: see the error lines;
  readings can stall after authentication when the signal is weak
  ([section 9](#9-known-limits-and-open-questions)).
- Readings in the log but no `uploaded SGV`: in fleet mode a reading
  another collector already sent is skipped, which is normal. Otherwise
  check `NIGHTSCOUT_HOST` / `API_SECRET` in `/etc/lookout.env`.
- `-v` in `LOOKOUT_ARGS` (then `sudo systemctl restart lookout`) adds
  the low-level Bluetooth traces.

### Busy or offline in the UI

The UI tells two cases apart:

- **busy**: `status` did not answer within the UI's timeout, but the
  collector's SSH port accepts connections. The UI keeps its last status,
  marked busy, and leaves it out of sync until it answers. A Pi Zero in the
  middle of a failing read can be slow: this is not a frozen device.
- **offline**: SSH fails, or times out and the SSH port does not answer.

**A slow bluetoothd** is the first thing to check when a collector stays
busy: `status` reports `bluetooth_powered: null` with the error line
`bluetooth: no answer from bluetoothd in 10 s`, or a large
`health.bluetooth_ms`. On the collector:

```sh
time bluetoothctl show                                  # about a second; tens of seconds = struggling
busctl --system tree org.bluez | grep -c /dev_          # devices bluetoothd holds (connected ones count a few times); near 0 between scans
grep TemporaryTimeout /etc/bluetooth/main.conf          # only the commented #TemporaryTimeout = 30
journalctl -u g7-bt-watchdog.service -b                 # "did not answer", "tracking N devices"
```

An active `TemporaryTimeout = 0` (or a large value) makes bluetoothd keep
every device it has seen. Fix: `sudo deploy/harden.sh` (puts an active 0
back to `#TemporaryTimeout = 30`), then `sudo systemctl restart bluetooth`
and `sudo /usr/local/sbin/g7-central-apply` (or reboot). On a read-only card
also run `sudo deploy/update-readonly.sh` so the card's copy is corrected
too, else the 0 comes back at the next boot. `sudo deploy/readonly.sh
status` shows the value. A restart alone helps only until the list has
grown again.

A timeout alone does not mean the device is frozen. Before power-cycling,
try a normal SSH login (`ssh pi@collector-a`, give it a minute) and look:
`uptime`, `systemctl --failed`, `free -m`, `df -h /media/root-rw`, the
`health` checks in [section 6](#checking-a-device). Test the UI's own path
from the UI device with `ssh -i <ui private key> g7rig@collector-a status`
(prints `rejected` if the command is not one of the allowed forms). A
device that is truly stalled is rebooted by `g7-alive` within about 5
minutes, unless the alive watchdog is off; power-cycle only if a normal
login also fails for longer than that.

### Nothing heard on Bluetooth

```sh
bluetoothctl show | grep -E 'Controller|Powered|Discovering'   # Controller = the fleet address
cat /etc/g7-central                                              # the shared address, if imported
grep . /sys/class/rfkill/rfkill*/type /sys/class/rfkill/rfkill*/soft
sudo timeout 12 btmon | grep -c "LE Advertising Report"          # 0 while discovering = deaf
journalctl -u g7-bt-watchdog.service -b
systemctl cat bluetooth | grep noplugin                          # --noplugin=gap
```

A deaf adapter: `sudo systemctl restart bluetooth`, then
`sudo /usr/local/sbin/g7-central-apply` (sets the fleet address again; it
says `Bluetooth address already ...` or `set to ...`). A controller address
other than the shared one: the sensor refuses this collector's key; run
`g7-central-apply` (`journalctl -u g7-central -b` shows the boot's attempt).
Soft-blocked: [section 2, step 3](#2-setting-up-a-collector).

### The card will not relock

`ERROR: the card (/media/root-ro) is still writable` from a script, or
`findmnt -no OPTIONS /media/root-ro` starting with `rw`:

```sh
sync; echo 2 | sudo tee /proc/sys/vm/drop_caches
sudo mount -o remount,ro /media/root-ro
findmnt -no OPTIONS /media/root-ro       # ro,...
```

The usual cause is a file deleted on the card that the overlay had cached
([section 5](#5-safe-to-unplug-the-read-only-card)). A writable card is
not dangerous at once, but a power cut while it is writable can corrupt it.

### It reboots repeatedly

Three things can reboot a collector on purpose: the alive watchdog, the
network watchdog and Lookout itself (without `--no_reboot`). The journal is
in RAM, so the reboot erases the reason; tell them apart by what came
before it, or keep `journalctl -f -u g7-alive -t g7-netwatch -u lookout`
open from a second session (a local console for the network watchdog,
since SSH drops with the network) until it happens again:

- **Alive watchdog** (`g7-alive`): the device was busy in the UI (SSH
  connects, no answer) for about 5 minutes, then rebooted at once, without
  a clean shutdown. `journalctl -u g7-alive -b`: card read errors or
  "no answer" lines point at the card. Stop it within 5 minutes of boot if
  it reboots a healthy device ([turning it off](#the-alive-watchdog)).
- **Network watchdog** (`g7-netwatch`): the device was offline in the UI
  (no SSH at all) for about 10 minutes, or for an hour if the network never
  came up after boot, then rebooted cleanly. Its last line is
  `... : rebooting`. `journalctl -t g7-netwatch -b` after it comes back shows
  any outage of this boot. Reboots once an hour mean the network never
  comes up: check the router, the Wi-Fi password and the signal, or turn it
  off ([turning it off](#the-network-watchdog)).
- **Lookout**: `grep -o -- '--no_reboot' /etc/lookout.env`: without it
  Lookout reboots after repeated failed reads (`Too many read failures ...
  rebooting rig` in its log), while the device stays reachable.
Not on purpose:

- `vcgencmd get_throttled` not `0x0`: under-voltage; use a better supply
  or cable.
- `sudo dmesg | grep -i "out of memory"` and `health`: memory; check that
  swap is off and CMA is 64 MB ([section 6](#checking-a-device)).

## 8. Testing another Lookout or xdrip-js build on a collector

To try someone else's build (for example upstream Lookout or xdrip-js
without this fork's fleet changes) on a read-only collector without
touching the card. Everything below lives in RAM (`/run` and the RAM
overlay), so a reboot or a power cut at any point brings the fleet setup
back. A version of this was done on a device on 2026-11-15 (an upstream test
build ran from a second checkout with a copy of the storage, paired a sensor,
and its key was then moved into the fleet storage and copied to the other
collector). The exact commands below differ in details from what was typed
that day and have not been run as written; check each step's output.

**Before you start.** The build must not be able to use the medical slot
(slot 1, the pump's): check how it chooses the G7 display slot and its
default, and set the watch slot explicitly. Lookout rejects options it does
not know, so give it only the ones it has (a build without `--no_reboot`
reboots the rig after repeated failed reads, which also ends the test). A
pairing on the watch slot replaces the key there: the other collectors stop
reading until they get the new key.

1. **Stop the UI's key sync**, on the UI device:
   `sudo systemctl stop dexcom-ui` (this stops the whole UI; it has no
   separate switch). *Why:* the UI would see a different key on this
   collector and `import-key` the fleet key over it, which restarts Lookout
   and removes the new sensor's bond in the middle of your test.
2. **Stop saving to the card**, on the collector:
   `sudo systemctl stop g7-persist.path g7-persist.timer`. *Why:*
   `g7-rig persist` saves the storage of whatever directory
   `lookout.service` runs in; it would write the test's storage onto the
   card and drop other sensors' bonds from it. They start again at the next
   boot.
3. **Copy the build** to a second directory, e.g. `~/test/Lookout` (and
   `~/test/xdrip-js`), *without* `node_modules`: the RAM overlay is about
   214 MB and Lookout's dependencies are far larger. Use the fleet
   checkout's dependencies instead: for a Lookout-only change a link
   `ln -s ~/src/Lookout/node_modules ~/test/Lookout/node_modules`; for an
   xdrip-js build, `~/test/Lookout/node_modules/xdrip-js` linked to
   `~/test/xdrip-js` and `NODE_PATH` (step 5) for the rest. Keep an eye on
   `df -h /media/root-rw`.
4. **Copy the storage**, with Lookout stopped so the copy is consistent:

   ```sh
   sudo systemctl stop lookout
   cp -a ~/src/Lookout/storage ~/test/Lookout/storage
   sudo install -m 600 /etc/lookout.env /run/lookout-test.env
   sudoedit /run/lookout-test.env           # LOOKOUT_ARGS for the test build (watch slot)
   ```

   *Why:* the test starts from the same code and key, and the fleet storage
   stays as it was, ready to go back to.
5. **Point the unit at the test build** with a runtime-only drop-in
   (`/run` is gone at the next boot, and nothing in `/etc` or on the card
   changes):

   ```sh
   sudo mkdir -p /run/systemd/system/lookout.service.d
   sudo tee /run/systemd/system/lookout.service.d/zz-test.conf >/dev/null <<'EOF'
   [Service]
   WorkingDirectory=/home/pi/test/Lookout
   ExecStart=
   ExecStart=/home/pi/test/Lookout/Lookout $LOOKOUT_ARGS
   Environment=NODE_PATH=/home/pi/src/Lookout/node_modules
   EnvironmentFile=/run/lookout-test.env
   EOF
   sudo systemctl daemon-reload
   systemctl show lookout -p WorkingDirectory -p ExecStart    # the test build
   sudo systemctl start lookout
   journalctl -u lookout -f
   ```

   The second `EnvironmentFile=` is read after `/etc/lookout.env`, so its
   `LOOKOUT_ARGS` wins; `NODE_PATH` is only a fallback after the test
   build's own `node_modules`.
6. **Test.** To pair, give the build the code its own way (for Lookout:
   `~/src/Lookout/lookout.js id 1234`, which talks to the running Lookout).
   The key it gets is bound to this collector's Bluetooth address, which is
   the fleet's shared address, so the other collectors can use it too.
7. **Keep the new key** (skip this to discard the test: go to step 8).
   Stop Lookout, then copy the key into the fleet storage with node-persist,
   as the Lookout user (so the files keep their owner):

   ```sh
   sudo systemctl stop lookout
   cd ~/src/Lookout && /opt/node/bin/node -e '
   const persist = require("node-persist");
   const open = async (dir) => {
     const s = persist.create({ dir, forgiveParseErrors: true, expiredInterval: false });
     await s.init();
     return s;
   };
   (async () => {
     const [testDir, fleetDir] = process.argv.slice(1);
     const test = await open(testDir);
     const fleet = await open(fleetDir);
     const k = await test.getItem("sensorKey");
     if (!k || !k.key || !k.address) throw new Error("no sensorKey {key, address} in " + testDir);
     await fleet.setItem("sensorKey", { key: k.key, address: k.address });
     await fleet.setItem("pairedAt", (await test.getItem("pairedAt")) || Date.now());
     const id = await test.getItem("id");
     if (id) await fleet.setItem("id", id);
     const name = await test.getItem("sensorName");
     if (name) await fleet.setItem("sensorName", name); else await fleet.removeItem("sensorName");
     await fleet.removeItem("pairRequest");
     await fleet.removeItem("keyRejected");
     console.log("moved the key for " + k.address);
   })().catch((e) => { console.error(e.message); process.exit(1); });
   ' ~/test/Lookout/storage ~/src/Lookout/storage
   ```

   *Why not `import-key`:* it removes the Bluetooth bond of the key's
   sensor, which the test pairing just made. *Why `pairedAt`:* the UI
   adopts a key paired after its own record and shares it; without a newer
   `paired_at` it would overwrite this key with the old one.
   This assumes the build stores `sensorKey` as `{key, address}` with
   node-persist 2, as this fork does; check that the script printed the
   address.
8. **Restore the unit**, before saving: `g7-rig persist` saves the storage
   of the directory the unit runs in, which must be the fleet's again.

   ```sh
   sudo systemctl stop lookout
   sudo rm /run/systemd/system/lookout.service.d/zz-test.conf /run/lookout-test.env
   sudo systemctl daemon-reload
   systemctl show lookout -p WorkingDirectory              # ~/src/Lookout again
   ```

9. **Save to the card and start again** (after step 7):

   ```sh
   sudo /opt/node/bin/node /usr/local/sbin/g7-rig.js persist   # {"ok":true,"readOnly":true,"changed":N}
   sudo systemctl start lookout g7-persist.path g7-persist.timer
   sudo /opt/node/bin/node /usr/local/sbin/g7-rig.js status    # new key_fingerprint, paired_at, "paired"
   ```

   This writes the key items and the new sensor's bond to the card (and
   removes other sensors' bonds from it). Without step 7, just start
   `lookout`, `g7-persist.path` and `g7-persist.timer` (or reboot).
10. **Copy the key to the other collectors**: start the UI again
    (`sudo systemctl start dexcom-ui` on the UI device); it adopts the newer
    pairing and copies it with `export-key` / `import-key` (removing their
    old bonds there is what they need). By hand, from the UI device:
    `ssh g7rig@collector-a export-key | ssh g7rig@collector-b import-key`.
    Then remove `~/test` (or reboot: it is in RAM).

## 9. Known limits and open questions

- **Readings can stall after authentication** when the signal is weak.
- **Two collectors in range at once** (same key, same Bluetooth address) is
  not characterised: which one the sensor talks to, and whether they
  disturb each other.
- **The cause of the 2026-11-18 stall is probable, not proven**
  ([section 6](#a-collector-that-stalled-2026-11-19)): very probably the
  unbounded BlueZ device list of [2026-11-24](#a-collector-that-stopped-answering-2026-11-24),
  but that day's logs were lost. The alive watchdog is a safety net, not a fix.
- **Untested** for the fleet tools: G5 and G6 transmitters, and Debian 10
  (buster) based rigs. Only Pi Zero W collectors on Raspberry Pi OS 13 have
  run them.
- **This fork is needed.** The fleet relies on changes that are not
  upstream yet:
  - xdrip-js (`g7-fixes`): the `allowPairing` option (authenticate with the
    saved key only, never re-pair: what `--no_auto_pair` uses), the
    `pairingBlocked` event when that stops a re-pair, re-authentication
    within a connection (fresh challenge, same key), the advertised name in
    `sawTransmitter` events, the display type in place of the alternate
    Bluetooth channel, and the G7 pairing and transport fixes.
  - Lookout (`g7-fixes`): `--no_auto_pair` (fleet mode), storing the name
    and `pairedAt`, Nightscout de-duplication, `--no_reboot`,
    `--display_type`, and `g7-rig` with these deploy scripts.

  The intention is to move onto upstream Lookout and xdrip-js once their G7
  branches are merged, keeping only what the fleet still needs.
- `package-lock.json` pins one commit of xdrip-js's `g7-fixes` branch; later
  changes to that branch reach a collector only after the lock file is
  updated (or with a linked checkout,
  [section 2, step 5](#2-setting-up-a-collector)).
