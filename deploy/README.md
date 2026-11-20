# Lookout on a Raspberry Pi with a Dexcom G7

Tested with a Pi Zero W (single core), Raspberry Pi OS with BlueZ 5.82, and
Node 22. Lookout reads the G7 on the **watch** display slot (3), so the
pump (slot 1, for example an Omnipod 5) and the phone app (slot 2) keep their
own connections.

## Install

```sh
cd ~/src/Lookout && npm install
sudo deploy/install.sh          # units, Bluetooth fix, g7-rig, Bluetooth and alive watchdogs
sudoedit /etc/lookout.env       # Nightscout host and secret
sudo systemctl enable --now lookout
lookout id <code>
```

`<code>` is the 4-digit pairing code from the sensor package.

## New sensor

Only the code is needed. Lookout tries each `DXCM` sensor it hears, keeps the
one that accepts the code, and from then on connects only to that sensor's
address. It pairs at the sensor's next 5-minute reading.

- **Fleet collector**: pair it from the fleet UI, which runs
  `g7-rig pair <code>` (see below).
- **Standalone rig**: run Lookout's own `lookout id <code>`. It stores the
  code and clears the old key and calibration.

To pin a rig to one sensor even before pairing, add
`--sensor_address <mac>` to `LOOKOUT_ARGS`.

If you can, pair Lookout before the pump and the phone app connect to a fresh
sensor. Pairing a running sensor also works.

## Why the system changes are needed

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

Pairing details live in xdrip-js:

- P-256 maths through OpenSSL
- proof checks deferred until after each reply
- write-without-response fragments
- the Authentication subscription made before ExtraData

## Fleet (g7-rig)

Several collectors can share one sensor: one of them pairs, and the fleet UI
copies the resulting key to the others. `install.sh` installs the collector
side, `/usr/local/sbin/g7-rig.js` (its logic in `/usr/local/lib/g7rig`) and
the forced-command wrapper `/usr/local/sbin/g7-rig-remote`.

```sh
sudo deploy/setup-g7rig-access.sh "$(cat ui-key.pub)"   # once per collector
ssh g7rig@<collector> status                            # from the UI device
```

The setup script creates the user `g7rig`, whose key may only run
`sudo g7-rig-remote`. The wrapper allows exactly `status`, `scan DXCMxx`,
`pair NNNN`, `export-key` and `import-key`, and logs and rejects anything
else (exit 2).

- `status` prints JSON: the sensor, last reading, last heard, the pairing
  state, recent errors and `health` (load, memory, swap, RAM overlay,
  throttling: see "A collector that stalled" below). It shows only a
  fingerprint of the key (the first 12 hex characters of its SHA-256),
  never the key.
- `pair NNNN` stores the code, clears the old key, name, calibration and
  Bluetooth bond, removes any `--sensor_address` pin, and asks Lookout
  (which runs with `--no_auto_pair`) to pair with the sensor that accepts the
  code. It returns at once; the sensor's name is learned when it pairs.
- `export-key` prints `{code, name, address, key}` (`name` may be null). This
  is the only command that outputs the key. `import-key` reads that record on
  stdin, installs it and restarts Lookout; the key's address is the only
  sensor Lookout then connects to.
- `pair` and `import-key` refuse (exit 3) if `LOOKOUT_ARGS` selects the
  medical slot (`--display_type medical`, `--force_medical_slot`,
  `--alternate`).

## Safe to unplug

Collectors get moved around and some have no screen, so they must survive
losing power at any moment.

1. `sudo deploy/harden.sh`: logs in RAM, no unattended apt/man-db activity
   (a power cut mid-upgrade can break dpkg), boot partition read-only,
   automatic fsck at boot, 64 MB CMA instead of 256 MB (see below). Lookout and g7-rig already write their data
   crash-safely (temp file, fsync, rename, fsync the directory).
2. `sudo deploy/readonly.sh enable --reboot`: the whole SD card becomes
   read-only (overlayroot); everything written while running goes to RAM.
   What must survive is copied onto the card by `g7-rig persist`, which
   unlocks the card, writes crash-safely and relocks it (verified):
   - Lookout's sensor items (code, key, name, pairing state, session length)
   - `/etc/lookout.env`
   - the current sensor's Bluetooth bond (the stored key's address) (old sensors' bonds are dropped)

   It runs after `g7-rig pair` / `import-key`, whenever one of those files
   changes (`g7-persist.path`), and hourly (`g7-persist.timer`). The rest of
   Lookout's storage (reading history etc.) is scratch: each boot starts
   clean, and Nightscout keeps the history.

   `sudo deploy/readonly.sh status` shows the state. To update software:
   `sudo deploy/readonly.sh disable --reboot`, update, then
   `sudo deploy/readonly.sh enable --reboot`.

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

What the scripts do now:

- **Swap: no swap file.** `readonly.sh enable` and `readonly.sh units` (run by
  `update-readonly.sh`) write `/etc/rpi/swap.conf.d/90-g7-readonly.conf`
  when rpi-swap is installed. It said `Mechanism=zram` at first (no swap
  file, zram only); since 2026-11-19 it says `Mechanism=none`, no swap at all
  (see "A collector that stalled" below). The old swap file is deleted from the card
  itself, never through the overlay: by `readonly.sh enable` (`/var/swap`,
  while the card is still writable) and by `update-readonly.sh`
  (`/media/root-ro/var/swap`, in its unlocked window, checked after
  relocking). If a deleted file was cached by the overlay, the
  card stays "unlinked but in use" and every relock fails with "mount point
  is busy" ("the card is still writable"); `sync; echo 2 >
  /proc/sys/vm/drop_caches` releases it, which `update-readonly.sh` and
  `g7-rig persist` now do themselves. `update-readonly.sh` also copies the drop-in to the card.
  `readonly.sh status` shows the mechanism and whether the card still has a
  swap file. Takes effect at the next boot.
- **CMA: 64 MB.** `harden.sh` changes a line that is exactly
  `dtoverlay=vc4-kms-v3d` to `dtoverlay=vc4-kms-v3d,cma-64` (the collectors
  use no HDMI; the display is an SPI TFT). It leaves an overlay line with
  parameters alone, keeps the old file once as
  `/boot/firmware/config.txt.pre-harden`, and the boot partition read-only.
  Takes effect at the next boot.
- **Bluetooth watchdog.** `g7-bt-watchdog.timer` (installed and enabled by
  `install.sh`, copied to the card by `update-readonly.sh`) runs
  `g7-rig.js bt-watchdog` every 5 minutes at nice 19. When
  `bluetooth.service` is active and the adapter is powered and discovering,
  it counts "LE Advertising Report" / "LE Extended Advertising Report" lines
  in 10 s of `btmon` (under `timeout`). After 3 empty samples in a row it
  logs one line, runs `systemctl restart bluetooth` and then
  `g7-central-apply` (if installed) for the fleet address. At most one
  restart an hour; its state is in `/run/g7-rig/btwatch.json` (cleared at
  reboot). A failed `btmon` does not count as an empty sample.

Applying it to a collector that is already read-only: copy the checkout to
the Pi, then `sudo deploy/update-readonly.sh`, `sudo deploy/harden.sh`,
`sudo reboot`. The watchdog runs without a reboot; swap and CMA change at
the reboot.

Checking a device (after the reboot):

```sh
journalctl -u rpi-resize-swap-file.service --since -10min   # no truncate / "No space left" lines
grep -E "CmaTotal|Shmem" /proc/meminfo                       # CmaTotal: 65536 kB
sudo dmesg | grep -c "Out of memory"                         # 0 (this boot)
swapon --show; sudo deploy/readonly.sh status                # no swap (was: zram only), no card swap file
systemctl list-timers g7-bt-watchdog.timer
journalctl -u g7-bt-watchdog.service --since -1h             # quiet unless it misses or restarts
```

The watchdog logs nothing while advertisements are heard, a line per empty
sample (`... (1 of 3)`), and on acting: `bt-watchdog: adapter discovering
but no advertisements heard in 3 samples of 10 s; restarting bluetooth`.

Undoing each change (on a read-only card, files under `/media/root-ro` are
changed with the card unlocked: `sudo mount -o remount,rw /media/root-ro`,
change, `sudo mount -o remount,ro /media/root-ro`):

- Swap: delete `/etc/rpi/swap.conf.d/90-g7-readonly.conf` (on a read-only
  card: `/media/root-ro/etc/rpi/swap.conf.d/90-g7-readonly.conf`) and
  reboot. rpi-swap then goes back to its default and creates a swap file
  again, which on a read-only card brings the resize loop back.
  `readonly.sh enable` / `units` (and so `update-readonly.sh`) write the
  drop-in again.
- CMA: `sudo mount -o remount,rw /boot/firmware`, change the line back to
  `dtoverlay=vc4-kms-v3d` (or copy `config.txt.pre-harden` over
  `config.txt`), `sudo mount -o remount,ro /boot/firmware`, reboot.
  `harden.sh` changes it again if run.
- Watchdog: `sudo systemctl disable --now g7-bt-watchdog.timer`; on a
  read-only card also delete
  `/media/root-ro/etc/systemd/system/timers.target.wants/g7-bt-watchdog.timer`.
  `install.sh` (and so `update-readonly.sh`) enables it again.
- The alive watchdog: see "A collector that stalled" below.

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

What happened: one collector was unresponsive for more than 31 hours, until
it was power-cycled. The fleet UI's SSH polling connected each time but got
no answer within 20 s. systemd's hardware watchdog (`RuntimeWatchdogSec=1min`)
never fired, so the kernel and PID 1 were alive while the rest of userspace
was stalled. Its logs were in RAM, so **the cause is unknown**. Two
candidates: the SD card stopped answering reads, or memory thrash (a zram
swap as large as RAM had been enabled a few days earlier, which lets a Pi
grind instead of failing fast).

Three measures:

- **`health` in `g7-rig status`**, for the fleet UI to show and record:

  ```json
  "health": {"load1": 0.93, "mem_total_kb": 437312, "mem_available_kb": 262292,
             "swap_total_kb": 0, "swap_used_kb": 0, "overlay_used_kb": 1640,
             "overlay_total_kb": 219136, "throttled": "0x0"}
  ```

  `load1` from `/proc/loadavg`; memory and swap in kB from `/proc/meminfo`
  (`swap_used_kb` = SwapTotal - SwapFree); `overlay_*` = kB used/total of the
  RAM overlay at `/media/root-rw` (null when the card is not read-only);
  `throttled` = what `vcgencmd get_throttled` prints (non-zero bits mean
  under-voltage or throttling, now or since boot; null without vcgencmd).
  Any field that cannot be read is null; status never fails because of it.
  The only extra cost is one `vcgencmd` run and a statfs.
- **The alive watchdog** (`g7-alive.service`, script
  `/usr/local/sbin/g7-alive`, installed and enabled by `install.sh`, copied
  to the card by `update-readonly.sh`). Every 30 s it runs a program
  (`date`), reads one 4 KiB block straight from the card
  (`dd if=/dev/mmcblk0 ... iflag=direct` under `timeout 60`, so the page
  cache cannot answer for it; a different block in the first 16 MB each
  time), and only if both worked tells systemd `WATCHDOG=1`. A read error
  is logged as one line, a read with no answer as "no answer"; neither
  notifies. With no notification for 5 minutes (`WatchdogSec=300`) systemd
  kills the service (result `watchdog`) and `FailureAction=reboot-immediate`
  reboots at once, without a clean shutdown: the card is read-only, so
  nothing can be corrupted, and the RAM overlay is lost at any reboot. It
  runs at `Nice=-5`, is shielded from the OOM killer, and does not depend on
  Lookout or Bluetooth. The card device is the disk under `/media/root-ro`
  (else under `/`); if it cannot be found, or cannot be read when the
  service starts, it logs that once and checks only that programs start (so
  a wrong device cannot cause a reboot loop). A clean stop
  (`systemctl stop`/`restart`, shutdown) is not a failure; any other end of
  the service (`kill -9`, a crash) reboots too. If PID 1 itself stalls, the
  hardware watchdog still reboots.
  - Turn it off: `sudo systemctl disable --now g7-alive.service`. On a
    read-only card that lasts until the next boot; to keep it off, also
    delete `/media/root-ro/etc/systemd/system/multi-user.target.wants/g7-alive.service`
    with the card unlocked. `install.sh` (and so `update-readonly.sh`)
    enables it again. If it ever reboots a healthy device, run
    `sudo systemctl stop g7-alive` within 5 minutes of boot, then remove
    that link.
- **Swap off.** The rpi-swap drop-in now says `Mechanism=none` (no zram, no
  swap file). About 255 MB is free in normal running, so swap buys little,
  and without it a runaway process is killed by the OOM killer quickly
  instead of the device grinding; the alive watchdog covers the rest. A
  device with the earlier zram drop-in gets the new one from
  `update-readonly.sh` (it runs `readonly.sh units`, which rewrites it, and
  copies it to the card). Takes effect at the next boot.

Applying it to a read-only collector: copy the checkout to the Pi, then
`sudo deploy/update-readonly.sh` (health and the alive watchdog work at
once; the watchdog is restarted by `install.sh`), then `sudo reboot` (swap
off).

Checking a device:

```sh
sudo "$(command -v node)" /usr/local/sbin/g7-rig.js status   # "health": {...}, swap 0, throttled "0x0"
systemctl status g7-alive                                    # active (running)
journalctl -u g7-alive -b         # "card check: one direct read from /dev/mmcblk0 every 30 s"
systemctl show g7-alive -p WatchdogTimestamp                 # at most 30 s old
swapon --show; grep Swap /proc/meminfo                       # nothing; SwapTotal: 0 kB
sudo deploy/readonly.sh status    # "swap: off (Mechanism=none)", "swap in use: none"
```

Testing the alive watchdog (watch `journalctl -u g7-alive -f` from a second
SSH session; the journal is in RAM and gone after the reboot):

- Freeze it: `sudo kill -STOP "$(systemctl show -p MainPID --value g7-alive)"`.
  Nothing for 4.5 to 5 minutes, then `Watchdog timeout (limit 5min)!`,
  `Killing process ... with signal SIGKILL`, `Failed with result 'watchdog'`,
  and the Pi reboots at once (the SSH sessions just drop). Afterwards
  `uptime` is a few minutes and `g7-alive` is running again.
- Stop it: `sudo systemctl stop g7-alive`. The log shows `stopped` and
  `Deactivated successfully`; no reboot; `systemctl is-failed g7-alive` says
  `inactive`. `sudo systemctl start g7-alive` arms it again (so does a
  reboot).

Verified here: the health parsing and the status JSON (unit tests with real
`/proc` text and a fake `exec`), the alive script's rounds with stubbed
commands under sh and dash (good round notifies; failed exec, read error or
read with no answer does not; no device still notifies; READY=1, a clean
exit on SIGTERM), the swap drop-in rewrite and `readonly.sh status` output
on scratch files, `sh -n` of every script. Not verified without a device:
systemd's handling of the unit (notify, watchdog expiry, reboot-immediate,
clean stop), the device found on a real Pi, and direct reads from the card.
Verified on the devices: <to be filled in after deployment>

## Watching it

```sh
journalctl -u lookout -f | grep -E 'got glucose|uploaded SGV|0a0300|Error'
```

Start Lookout with `-v` in `LOOKOUT_ARGS` to add the low-level Bluetooth traces.
