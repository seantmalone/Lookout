#!/bin/sh
# Read-only SD card for a collector, so it can be unplugged at any time.
#   sudo deploy/readonly.sh status
#   sudo deploy/readonly.sh enable  [--reboot]
#   sudo deploy/readonly.sh disable [--reboot]    (e.g. to update software)
#   sudo deploy/readonly.sh install SRC DST [MODE [OWNER:GROUP]]
#        install one file into the running system AND onto the read-only card
#        (unlocks the card, always relocks it, verified)
#
# Enabled: the card is mounted read-only under a RAM overlay (overlayroot);
# everything written while running (logs, reading history, ...) lives in RAM
# and is gone after a power cut. What must survive - Lookout's sensor items
# (code, key, name, pairing state), /etc/lookout.env, /etc/g7-central (the
# shared Bluetooth address) and the current sensor's
# Bluetooth bond - is copied onto the card by `g7-rig persist`, which unlocks
# the card, writes those files crash-safely and locks it again. It runs:
#  - from g7-rig pair / import-key, right after they change something
#  - from g7-persist.path when Lookout stores a new key or the env changes
#  - from g7-persist.timer at boot and hourly (backstop)
# Software updates: `readonly.sh disable --reboot`, update, `enable --reboot`.
#
# Swap (enable and units): with rpi-swap installed, a drop-in sets
# Mechanism=none: no swap at all, neither zram nor a file. The default (auto =
# zram+file) keeps trying to resize /var/swap, which on a read-only card
# copies the file into the RAM overlay until that is full; zram as large as
# RAM lets a Pi grind for hours instead of killing a runaway process. enable
# removes the old swap file from the still-writable card; on a card that is
# already read-only, update-readonly.sh removes it from the card itself.
set -eu
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
CMDLINE=/boot/firmware/cmdline.txt
ACTION=${1:-status}
REBOOT=${2:-}

overlay_active() { [ "$(findmnt -no FSTYPE /)" = overlay ]; }
overlay_configured() { grep -qw 'overlayroot=tmpfs' "$CMDLINE"; }

# run "$@" with the boot partition writable, then make it read-only again
with_boot_rw() {
  was_ro=no
  if findmnt -no OPTIONS /boot/firmware | tr ',' '\n' | grep -qx ro; then
    was_ro=yes
    mount -o remount,rw /boot/firmware
  fi
  rc=0
  "$@" || rc=$?
  sync
  [ "$was_ro" = yes ] && mount -o remount,ro /boot/firmware
  return $rc
}

install_units() {
  dir=$(systemctl show lookout -p WorkingDirectory --value)
  [ -n "$dir" ] && [ -d "$dir/storage" ] || { echo "Lookout storage not found (is lookout.service installed?)" >&2; exit 1; }
  node_bin=$(dirname "$(readlink -f /opt/node/bin/node 2>/dev/null || command -v node)")
  sed "s#@NODE_BIN@#$node_bin#" "$HERE/systemd/g7-persist.service" > /etc/systemd/system/g7-persist.service
  install -m 644 "$HERE/systemd/g7-persist.timer" /etc/systemd/system/g7-persist.timer
  {
    echo "[Unit]"
    echo "Description=Save sensor data to the read-only SD card when it changes"
    echo
    echo "[Path]"
    for key in id sensorKey sensorName pairRequest keyRejected sessionLengthSeconds meterid pairedAt; do
      echo "PathChanged=$dir/storage/$(printf %s "$key" | md5sum | cut -d' ' -f1)"
    done
    echo "PathChanged=/etc/lookout.env"
    echo "PathChanged=/etc/g7-central"
    echo "Unit=g7-persist.service"
    echo
    echo "[Install]"
    echo "WantedBy=multi-user.target"
  } > /etc/systemd/system/g7-persist.path
  systemctl daemon-reload
  systemctl enable --now g7-persist.path g7-persist.timer >/dev/null
}

# overlayroot rewrites / in fstab as an overlay mount, which
# systemd-remount-fs then fails to remount (harmless, but a failed unit)
skip_remount_fs_when_readonly() {
  install -d /etc/systemd/system/systemd-remount-fs.service.d
  cat > /etc/systemd/system/systemd-remount-fs.service.d/overlayroot.conf <<'UNIT'
[Unit]
# read-only card (overlayroot): / is already mounted as it should be
ConditionKernelCommandLine=!overlayroot=tmpfs
UNIT
}

# rpi-swap: no swap. Rewritten every time, so a device with the earlier
# zram-only drop-in gets this one (update-readonly.sh runs `units`).
swap_off() {
  [ -f /etc/rpi/swap.conf ] || { echo "swap: rpi-swap not installed; left unchanged"; return 0; }
  install -d -m 755 /etc/rpi/swap.conf.d
  cat > /etc/rpi/swap.conf.d/90-g7-readonly.conf.tmp <<'SWAP'
# Read-only SD card (deploy/readonly.sh): no swap at all.
# - No swap file: with the default (Mechanism=auto, i.e. zram+file)
#   rpi-resize-swap-file tried to resize /var/swap about once a minute; on the
#   read-only card each try copied the file into the RAM overlay until it was
#   full ("No space left on device") and led to out-of-memory kills.
# - No zram either: about 255 MB is free in normal running, so swap buys
#   little, and without it a runaway process is killed quickly instead of the
#   device grinding. (A collector was once unresponsive for 31 hours, a few
#   days after zram as large as RAM was enabled; the cause was very probably
#   not swap but bluetoothd's unbounded device list, see deploy/README.md.)
#   g7-alive.service reboots a device that stalls anyway.
# Delete this file (on the card too) to go back to the default.
[Main]
Mechanism=none
SWAP
  chmod 644 /etc/rpi/swap.conf.d/90-g7-readonly.conf.tmp
  mv -f /etc/rpi/swap.conf.d/90-g7-readonly.conf.tmp /etc/rpi/swap.conf.d/90-g7-readonly.conf
  echo "swap: off (/etc/rpi/swap.conf.d/90-g7-readonly.conf, Mechanism=none), from the next boot"
}

# What is configured, and what is in use now (until the next boot that may
# still be the old zram)
swap_status() {
  if [ -f /etc/rpi/swap.conf.d/90-g7-readonly.conf ]; then
    mech=$(sed -n 's/^Mechanism=//p' /etc/rpi/swap.conf.d/90-g7-readonly.conf | tail -n 1)
    if [ "$mech" = none ]; then echo "swap: off (Mechanism=none)"
    else echo "swap: Mechanism=$mech (old drop-in: run deploy/update-readonly.sh)"; fi
  elif [ -f /etc/rpi/swap.conf ]; then echo "swap: rpi-swap default (no g7 drop-in)"
  else echo "swap: rpi-swap not installed"; fi
  inuse=$(awk 'NR > 1 { printf "%s%s", sep, $1; sep = " " }' /proc/swaps 2>/dev/null || true)
  echo "swap in use: ${inuse:-none}"
}

# BlueZ's TemporaryTimeout (harden.sh step 7) as main.conf sets it, and the
# card's copy when it differs. bluetoothd reads it when it starts.
tt_value() {
  sed -n 's/^[[:space:]]*TemporaryTimeout[[:space:]]*=[[:space:]]*\([^[:space:]]*\)[[:space:]]*$/\1/p' "$1" 2>/dev/null | tail -n 1
}
tt_describe() {
  case "$1" in
    "") echo "30 s (BlueZ default)" ;;
    0) echo "0 (devices are never forgotten: run deploy/harden.sh)" ;;
    *) echo "$1 s" ;;
  esac
}
bt_temporary_timeout_status() {
  f=/etc/bluetooth/main.conf
  [ -f "$f" ] || { echo "bluetooth TemporaryTimeout: no $f"; return 0; }
  v=$(tt_value "$f")
  echo "bluetooth TemporaryTimeout: $(tt_describe "$v")"
  # changed since bluetoothd started? (GNU stat and date; skipped elsewhere)
  started=$(systemctl show bluetooth -p ExecMainStartTimestamp --value 2>/dev/null || true)
  if [ -n "$started" ]; then
    s=$(date -d "$started" +%s 2>/dev/null || true)
    m=$(stat -c %Y "$f" 2>/dev/null || true)
    if [ -n "$s" ] && [ -n "$m" ] && [ "$m" -gt "$s" ]; then
      echo "bluetooth: main.conf changed after bluetoothd started: sudo systemctl restart bluetooth (or reboot) to apply it"
    fi
  fi
  if overlay_active && [ -f /media/root-ro/etc/bluetooth/main.conf ]; then
    c=$(tt_value /media/root-ro/etc/bluetooth/main.conf)
    if [ "$c" != "$v" ]; then
      if [ "$c" = 0 ]; then echo "card's main.conf: TemporaryTimeout 0 (run deploy/update-readonly.sh)"
      else echo "card's main.conf: TemporaryTimeout $(tt_describe "$c")"; fi
    fi
  fi
}

# The old swap file, while the card is still writable (before the overlay).
# Never through the overlay: opening it there copies all of it into RAM.
remove_swapfile_writable_card() {
  [ -f /etc/rpi/swap.conf.d/90-g7-readonly.conf ] || return 0
  overlay_active && { echo "swap: card is read-only; deploy/update-readonly.sh removes the card's swap file"; return 0; }
  [ -f /var/swap ] && [ ! -L /var/swap ] || return 0
  if grep -q '^/var/swap[[:space:]]' /proc/swaps; then
    swapoff /var/swap || { echo "swap: /var/swap is in use and could not be turned off; left in place" >&2; return 0; }
  fi
  rm -f /var/swap
  echo "swap: removed /var/swap from the card"
}

set_cmdline() {
  if [ "$1" = on ]; then
    overlay_configured || sed -i "1 s/^/overlayroot=tmpfs /" "$CMDLINE"
  else
    sed -i "1 s/overlayroot=tmpfs //g" "$CMDLINE"
  fi
}

LOWER=/media/root-ro

relock() {
  i=0
  while [ $i -lt 60 ]; do              # "busy" right after many writes can last a while
    sync
    mount -o remount,ro "$LOWER" 2>/dev/null || true
    [ "$(findmnt -no OPTIONS "$LOWER" | cut -d, -f1)" = ro ] && return 0
    i=$((i + 1))
    sleep 1
  done
  echo "ERROR: the card ($LOWER) is still writable" >&2
  return 1
}

install_file() {
  src=$1; dst=$2; mode=${3:-644}; owner=${4:-root:root}
  [ -f "$src" ] || { echo "no such file: $src" >&2; exit 1; }
  tmp=$(mktemp)
  cp "$src" "$tmp"                      # src may be the same path as dst
  install -D -m "$mode" -o "${owner%%:*}" -g "${owner##*:}" "$tmp" "$dst"
  if overlay_active; then
    trap 'relock' EXIT
    mount -o remount,rw "$LOWER"
    install -D -m "$mode" -o "${owner%%:*}" -g "${owner##*:}" "$tmp" "$LOWER$dst"
    trap - EXIT
    relock
    cmp "$dst" "$LOWER$dst" >/dev/null && echo "installed $dst (running system and card)"
  else
    echo "installed $dst"
  fi
  rm -f "$tmp"
}

case "$ACTION" in
  units)
    # (re)install the persist units, the remount-fs drop-in and the swap
    # drop-in on the running system (update-readonly.sh copies them to the card)
    install_units
    skip_remount_fs_when_readonly
    swap_off
    exit 0
    ;;
  install)
    [ $# -ge 3 ] || { echo "usage: $0 install SRC DST [MODE [OWNER:GROUP]]" >&2; exit 2; }
    install_file "$2" "$3" "${4:-644}" "${5:-root:root}"
    exit 0
    ;;
  status)
    if overlay_active; then echo "card: read-only (RAM overlay active)"; else echo "card: writable"; fi
    if overlay_configured; then echo "next boot: read-only"; else echo "next boot: writable"; fi
    echo "boot partition: $(findmnt -no OPTIONS /boot/firmware | cut -d, -f1)"
    echo "g7-persist: path $(systemctl is-enabled g7-persist.path 2>/dev/null || echo missing), timer $(systemctl is-enabled g7-persist.timer 2>/dev/null || echo missing)"
    swap_status
    if overlay_active; then
      if [ -e /media/root-ro/var/swap ]; then echo "card swap file: present"; else echo "card swap file: none"; fi
    elif [ -e /var/swap ]; then echo "card swap file: present"; else echo "card swap file: none"; fi
    bt_temporary_timeout_status
    ;;
  enable)
    mem=$(awk '/MemTotal/{print $2; exit}' /proc/meminfo)
    [ "$mem" -gt 262144 ] || { echo "at least 512 MB RAM needed" >&2; exit 1; }
    install_units
    skip_remount_fs_when_readonly
    swap_off
    remove_swapfile_writable_card
    # update-readonly.sh needs rsync, which cannot be installed once the card is read-only
    if ! command -v rsync >/dev/null 2>&1; then
      env DEBIAN_FRONTEND=noninteractive apt-get install -y -q rsync
    fi
    if ! dpkg -s overlayroot >/dev/null 2>&1; then
      # the package regenerates the initramfs images on the boot partition
      with_boot_rw env DEBIAN_FRONTEND=noninteractive apt-get install -y -q overlayroot
    fi
    [ -f /boot/firmware/initramfs ] || [ -f /boot/firmware/initramfs7 ] || { echo "no initramfs on the boot partition" >&2; exit 1; }
    grep -q '^auto_initramfs=1' /boot/firmware/config.txt || { echo "auto_initramfs=1 missing from config.txt" >&2; exit 1; }
    with_boot_rw set_cmdline on
    overlay_configured || { echo "could not edit $CMDLINE" >&2; exit 1; }
    echo "read-only card configured: active after the next reboot"
    ;;
  disable)
    with_boot_rw set_cmdline off
    if overlay_configured; then echo "could not edit $CMDLINE" >&2; exit 1; fi
    echo "writable card configured: active after the next reboot"
    ;;
  *)
    echo "usage: $0 status | enable [--reboot] | disable [--reboot] | install SRC DST [MODE [OWNER:GROUP]]" >&2; exit 2;;
esac

if [ "$REBOOT" = --reboot ] && [ "$ACTION" != status ]; then
  systemctl reboot
fi
