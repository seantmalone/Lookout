#!/bin/sh
# Update a collector whose SD card is read-only (deploy/readonly.sh enable).
# Copy this checkout to the Pi first (e.g. rsync to ~/src/Lookout), then:
#   sudo deploy/update-readonly.sh
# It installs everything on the running system (install.sh), then unlocks the
# card, mirrors Lookout's code and the installed files onto it, and relocks it
# (verified). Lookout's storage and the env file are left to g7-rig persist.
set -eu
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
SRC=$(dirname "$HERE")
L=/media/root-ro
[ "$(findmnt -no FSTYPE /)" = overlay ] || { echo "the card is not read-only: use deploy/install.sh" >&2; exit 1; }

sh "$HERE/install.sh"
sh "$HERE/readonly.sh" units

relock() {
  i=0
  while [ $i -lt 10 ]; do
    sync
    mount -o remount,ro "$L" 2>/dev/null || true
    [ "$(findmnt -no OPTIONS "$L" | cut -d, -f1)" = ro ] && return 0
    i=$((i + 1)); sleep 1
  done
  echo "ERROR: the card ($L) is still writable" >&2
  return 1
}

mount -o remount,rw "$L"
trap relock EXIT
# Lookout's code (not node_modules, not its data)
rsync -rlt --exclude=node_modules --exclude=/storage/ --exclude='/storage.*' --exclude=.git "$SRC/" "$L$SRC/"
# the files install.sh and readonly.sh manage, exactly as on the running system
for p in /usr/local/sbin/g7-rig.js /usr/local/sbin/g7-rig-remote /usr/local/sbin/g7-new-sensor \
         /usr/local/sbin/g7-central-apply /usr/local/lib/g7rig \
         /etc/systemd/system/lookout.service /etc/systemd/system/lookout.service.d \
         /etc/systemd/system/bluetooth.service.d /etc/systemd/system/g7-central.service \
         /etc/systemd/system/g7-persist.service /etc/systemd/system/g7-persist.path \
         /etc/systemd/system/g7-persist.timer /etc/systemd/system/systemd-remount-fs.service.d \
         /etc/systemd/system/multi-user.target.wants/lookout.service \
         /etc/systemd/system/multi-user.target.wants/g7-central.service \
         /etc/systemd/system/multi-user.target.wants/g7-persist.path \
         /etc/systemd/system/timers.target.wants/g7-persist.timer; do
  if [ -e "$p" ] || [ -L "$p" ]; then
    rm -rf "$L$p"
    cp -a --parents "$p" "$L/"
  fi
done
trap - EXIT
relock
echo "updated the running system and the card"
