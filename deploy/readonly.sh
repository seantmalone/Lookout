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
# Mechanism=zram (compressed RAM only, no swap file). The default (auto =
# zram+file) keeps trying to resize /var/swap, which on a read-only card
# copies the file into the RAM overlay until that is full. enable removes the
# old swap file from the still-writable card; on a card that is already
# read-only, update-readonly.sh removes it from the card itself.
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

# rpi-swap: compressed RAM (zram) only, no swap file
swap_zram_only() {
  [ -f /etc/rpi/swap.conf ] || { echo "swap: rpi-swap not installed; left unchanged"; return 0; }
  install -d -m 755 /etc/rpi/swap.conf.d
  cat > /etc/rpi/swap.conf.d/90-g7-readonly.conf.tmp <<'SWAP'
# Read-only SD card (deploy/readonly.sh): swap in compressed RAM (zram) only.
# With the default (Mechanism=auto, i.e. zram+file) rpi-resize-swap-file
# tried to resize /var/swap about once a minute; on the read-only card each
# try copied the file into the RAM overlay until it was full ("No space left
# on device"), cost ~9 s of CPU and ~200 MB of RAM, and led to kernel
# out-of-memory kills. With zram no swap file is used. Delete this file (on
# the card too) to go back to the default.
[Main]
Mechanism=zram
SWAP
  chmod 644 /etc/rpi/swap.conf.d/90-g7-readonly.conf.tmp
  mv -f /etc/rpi/swap.conf.d/90-g7-readonly.conf.tmp /etc/rpi/swap.conf.d/90-g7-readonly.conf
  echo "swap: zram only (/etc/rpi/swap.conf.d/90-g7-readonly.conf), from the next boot"
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
    swap_zram_only
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
    if [ -f /etc/rpi/swap.conf.d/90-g7-readonly.conf ]; then echo "swap: zram only"
    elif [ -f /etc/rpi/swap.conf ]; then echo "swap: rpi-swap default (no zram-only drop-in)"
    else echo "swap: rpi-swap not installed"; fi
    if overlay_active; then
      if [ -e /media/root-ro/var/swap ]; then echo "card swap file: present"; else echo "card swap file: none"; fi
    elif [ -e /var/swap ]; then echo "card swap file: present"; else echo "card swap file: none"; fi
    ;;
  enable)
    mem=$(awk '/MemTotal/{print $2; exit}' /proc/meminfo)
    [ "$mem" -gt 262144 ] || { echo "at least 512 MB RAM needed" >&2; exit 1; }
    install_units
    skip_remount_fs_when_readonly
    swap_zram_only
    remove_swapfile_writable_card
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
