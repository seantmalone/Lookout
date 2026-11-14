# Lookout on a Raspberry Pi with a Dexcom G7

Tested with a Pi Zero W (single core), Raspberry Pi OS with BlueZ 5.82, and
Node 22. Lookout reads the G7 on the **watch** display slot (3), so the
pump (slot 1, for example an Omnipod 5) and the phone app (slot 2) keep their
own connections.

## Install

```sh
cd ~/src/Lookout && npm install
sudo deploy/install.sh          # units, Bluetooth fix, g7-rig
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
  state and recent errors. It shows only a fingerprint of the key (the
  first 12 hex characters of its SHA-256), never the key.
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
   automatic fsck at boot. Lookout and g7-rig already write their data
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

## Watching it

```sh
journalctl -u lookout -f | grep -E 'got glucose|uploaded SGV|0a0300|Error'
```

Start Lookout with `-v` in `LOOKOUT_ARGS` to add the low-level Bluetooth traces.
