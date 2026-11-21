#!/bin/sh
# Update a collector whose SD card is read-only (deploy/readonly.sh enable).
# Copy this checkout to the Pi first (e.g. rsync to ~/src/Lookout), then:
#   sudo deploy/update-readonly.sh
# It installs everything on the running system (install.sh), then unlocks the
# card, mirrors Lookout's code and the installed files onto it, and relocks it
# (verified). Lookout's storage and the env file are left to g7-rig persist.
# harden.sh's Wi-Fi power-save drop-in (/etc/NetworkManager/conf.d/
# 90-g7-wifi-powersave.conf) is mirrored too, when it is there.
# With rpi-swap set to no swap (readonly.sh units rewrites the drop-in, also
# over the earlier zram-only one), it also deletes the old swap file from the
# card itself (/media/root-ro/var/swap), never through the overlay. The swap
# change takes effect at the next reboot. Files the repo no longer has
# (/usr/local/sbin/g7-new-sensor) and the hand-installed lab-netwatch that
# g7-netwatch replaced are removed from the card the same way.
# Lookout keeps running its old code until `systemctl restart lookout` or a
# reboot.
set -eu
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
SRC=$(dirname "$HERE")
L=/media/root-ro
[ "$(findmnt -no FSTYPE /)" = overlay ] || { echo "the card is not read-only: use deploy/install.sh" >&2; exit 1; }
command -v rsync >/dev/null 2>&1 || { echo "rsync is not installed (readonly.sh enable installs it; on this card: readonly.sh disable --reboot, apt-get install rsync, enable --reboot)" >&2; exit 1; }

sh "$HERE/install.sh"
sh "$HERE/readonly.sh" units

# Release cached dentries/inodes. A file deleted on the card that the overlay
# still has cached (it was opened through the overlay) stays "unlinked but in
# use" on the card, and the kernel then refuses every remount to read-only
# ("mount point is busy") even though no process has it open.
drop_caches() {
  sync
  echo 2 > /proc/sys/vm/drop_caches 2>/dev/null || true
}

relock() {
  i=0
  while [ $i -lt 60 ]; do              # "busy" right after many writes can last a while
    [ $i -eq 5 ] && drop_caches        # once: a deleted file the overlay cached
    sync
    mount -o remount,ro "$L" 2>/dev/null || true
    [ "$(findmnt -no OPTIONS "$L" | cut -d, -f1)" = ro ] && return 0
    i=$((i + 1)); sleep 1
  done
  echo "ERROR: the card ($L) is still writable" >&2
  return 1
}

# Stage everything in RAM first: reading through the overlay after changing
# the card underneath it is undefined (overlayfs), so the card is only
# written from this staged copy.
STAGE=$(mktemp -d /run/g7-update.XXXXXX)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/src" "$STAGE/root" "$STAGE/xdrip"
rsync -rlt --exclude=node_modules --exclude=/storage/ --exclude='/storage.*' --exclude=.git "$SRC/" "$STAGE/src/"
# xdrip-js, when Lookout uses a sibling checkout (node_modules/xdrip-js -> ../../xdrip-js)
XDRIP=""
if [ -L "$SRC/node_modules/xdrip-js" ]; then
  XDRIP=$(readlink -f "$SRC/node_modules/xdrip-js")
  [ -f "$XDRIP/package.json" ] && [ -d "$XDRIP/lib" ] || XDRIP=""
fi
[ -n "$XDRIP" ] && rsync -rlt --exclude=node_modules --exclude=.git "$XDRIP/" "$STAGE/xdrip/"
PATHS="/usr/local/sbin/g7-rig.js /usr/local/sbin/g7-rig-remote
  /usr/local/sbin/g7-central-apply /usr/local/lib/g7rig
  /etc/systemd/system/lookout.service /etc/systemd/system/lookout.service.d
  /etc/systemd/system/bluetooth.service.d /etc/systemd/system/g7-central.service
  /etc/systemd/system/g7-persist.service /etc/systemd/system/g7-persist.path
  /etc/systemd/system/g7-persist.timer /etc/systemd/system/systemd-remount-fs.service.d
  /etc/systemd/system/g7-bt-watchdog.service /etc/systemd/system/g7-bt-watchdog.timer
  /usr/local/sbin/g7-alive /etc/systemd/system/g7-alive.service
  /usr/local/sbin/g7-netwatch /etc/systemd/system/g7-netwatch.service
  /etc/systemd/system/g7-netwatch.timer
  /etc/rpi/swap.conf.d/90-g7-readonly.conf
  /etc/NetworkManager/conf.d/90-g7-wifi-powersave.conf
  /etc/systemd/system/multi-user.target.wants/lookout.service
  /etc/systemd/system/multi-user.target.wants/g7-central.service
  /etc/systemd/system/multi-user.target.wants/g7-persist.path
  /etc/systemd/system/timers.target.wants/g7-persist.timer
  /etc/systemd/system/timers.target.wants/g7-bt-watchdog.timer
  /etc/systemd/system/timers.target.wants/g7-netwatch.timer
  /etc/systemd/system/multi-user.target.wants/g7-alive.service"
for p in $PATHS; do
  if [ -e "$p" ] || [ -L "$p" ]; then cp -a --parents "$p" "$STAGE/root/"; fi
done

# The old swap file on the card: rpi-swap now uses no swap (the drop-in
# above). Decided before unlocking; literal paths only.
RM_SWAP=no
if [ -f /etc/rpi/swap.conf.d/90-g7-readonly.conf ] && [ -f /media/root-ro/var/swap ] && [ ! -L /media/root-ro/var/swap ]; then
  RM_SWAP=yes
fi

# g7-new-sensor, dropped from the repo: install.sh removed it from the running
# system; take it off the card too. Decided before unlocking; literal path.
RM_OLD=no
if [ -e /media/root-ro/usr/local/sbin/g7-new-sensor ] || [ -L /media/root-ro/usr/local/sbin/g7-new-sensor ]; then
  RM_OLD=yes
fi

# lab-netwatch, the hand-installed version of g7-netwatch: install.sh disabled
# and removed it on the running system; take it off the card too. Decided
# before unlocking; literal paths.
LAB_NETWATCH="/media/root-ro/usr/local/sbin/lab-netwatch
  /media/root-ro/etc/systemd/system/lab-netwatch.service
  /media/root-ro/etc/systemd/system/lab-netwatch.timer
  /media/root-ro/etc/systemd/system/timers.target.wants/lab-netwatch.timer"
RM_LAB=no
for p in $LAB_NETWATCH; do
  if [ -e "$p" ] || [ -L "$p" ]; then RM_LAB=yes; fi
done

mount -o remount,rw "$L"
trap 'relock; rm -rf "$STAGE"' EXIT
rsync -rlt "$STAGE/src/" "$L$SRC/"
[ -n "$XDRIP" ] && rsync -rlt "$STAGE/xdrip/" "$L$XDRIP/"
for p in $PATHS; do
  if [ -e "$STAGE/root$p" ] || [ -L "$STAGE/root$p" ]; then
    rm -rf "$L$p"
    mkdir -p "$(dirname "$L$p")"
    cp -a "$STAGE/root$p" "$L$p"
  fi
done
if [ "$RM_SWAP" = yes ]; then
  rm -f /media/root-ro/var/swap
  drop_caches                          # else the cached swap file blocks the relock
fi
if [ "$RM_OLD" = yes ]; then
  rm -f /media/root-ro/usr/local/sbin/g7-new-sensor
  drop_caches                          # a cached deleted file blocks the relock
fi
if [ "$RM_LAB" = yes ]; then
  rm -f /media/root-ro/usr/local/sbin/lab-netwatch
  rm -f /media/root-ro/etc/systemd/system/lab-netwatch.service
  rm -f /media/root-ro/etc/systemd/system/lab-netwatch.timer
  rm -f /media/root-ro/etc/systemd/system/timers.target.wants/lab-netwatch.timer
  drop_caches                          # a cached deleted file blocks the relock
fi
trap - EXIT
relock
# check: every staged file is on the card, byte for byte
bad=0
diff -rq "$STAGE/src" "$L$SRC" -x node_modules -x storage -x 'storage.*' -x .git >/dev/null 2>&1 || { echo "card differs: $SRC" >&2; bad=1; }
if [ -n "$XDRIP" ]; then
  diff -rq "$STAGE/xdrip" "$L$XDRIP" -x node_modules -x .git >/dev/null 2>&1 || { echo "card differs: $XDRIP" >&2; bad=1; }
fi
for p in $PATHS; do
  if [ -e "$STAGE/root$p" ] && ! diff -rq "$STAGE/root$p" "$L$p" >/dev/null 2>&1; then
    echo "card differs: $p" >&2; bad=1
  fi
done
if [ "$RM_SWAP" = yes ]; then
  if [ -e /media/root-ro/var/swap ]; then
    echo "card still has its swap file: /media/root-ro/var/swap" >&2; bad=1
  else
    echo "removed the old swap file from the card (/var/swap); no swap from the next reboot"
  fi
fi
if [ "$RM_OLD" = yes ]; then
  if [ -e /media/root-ro/usr/local/sbin/g7-new-sensor ] || [ -L /media/root-ro/usr/local/sbin/g7-new-sensor ]; then
    echo "card still has /usr/local/sbin/g7-new-sensor" >&2; bad=1
  else
    echo "removed the old g7-new-sensor from the card"
  fi
fi
if [ "$RM_LAB" = yes ]; then
  left=no
  for p in $LAB_NETWATCH; do
    if [ -e "$p" ] || [ -L "$p" ]; then echo "card still has $p" >&2; left=yes; bad=1; fi
  done
  [ $left = yes ] || echo "removed the old lab-netwatch from the card"
fi
rm -rf "$STAGE"
[ $bad = 0 ] || exit 1
echo "updated the running system and the card (verified)"
