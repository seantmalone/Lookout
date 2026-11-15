#!/bin/sh
# Make a collector safe to unplug without a clean shutdown (run as root):
#   sudo deploy/harden.sh
#
# What it does (idempotent):
#  1. Logs live in RAM (journald Storage=volatile): no constant SD-card writes.
#     Logs from before a reboot are gone; use `journalctl -b` for this boot.
#  2. No unattended package activity (apt-daily, apt-daily-upgrade, man-db and
#     unattended-upgrades): a power cut in the middle of an upgrade can leave
#     dpkg broken. Update by hand when the device is on your desk.
#  3. The boot partition (FAT, the most fragile filesystem on the card) is
#     mounted read-only. To update the kernel or firmware:
#       sudo mount -o remount,rw /boot/firmware && sudo apt full-upgrade
#     and reboot (it comes back read-only).
#  4. Checks that the root filesystem is repaired automatically at boot
#     (fsck.repair=yes on the kernel command line).
#  5. Less memory reserved for graphics: dtoverlay=vc4-kms-v3d becomes
#     dtoverlay=vc4-kms-v3d,cma-64 in /boot/firmware/config.txt. The default
#     reserves 256 MB of a Pi Zero's ~437 MB as CMA, which the kernel's own
#     allocations cannot use; with spikes of RAM use (read-only card) the
#     kernel ran out and killed processes. Collectors use no HDMI. Only that
#     exact line is changed (an overlay with parameters is left alone); the
#     old file is kept once as config.txt.pre-harden. Active after a reboot.
#
# Lookout and g7-rig already write their data crash-safely (temp file,
# fsync, rename, fsync the directory), so after a power cut every item holds
# its old or its new value; the UI's sync restores a collector's key if one is
# ever lost.
set -eu
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }

# run "$@" with the boot partition writable, then make it read-only again
# if it was (as deploy/readonly.sh does)
with_boot_rw() {
  was_ro=no
  if findmnt -no OPTIONS /boot/firmware | tr ',' '\n' | grep -qx ro; then
    was_ro=yes
    mount -o remount,rw /boot/firmware
  fi
  rc=0
  "$@" || rc=$?
  sync
  if [ "$was_ro" = yes ]; then mount -o remount,ro /boot/firmware; fi
  return $rc
}

# exactly "dtoverlay=vc4-kms-v3d" -> "dtoverlay=vc4-kms-v3d,cma-64"
CMA_SED='s/^dtoverlay=vc4-kms-v3d$/dtoverlay=vc4-kms-v3d,cma-64/'
cma64_config() {
  # (called from an `if`, where set -e does not apply: check each step)
  [ -e /boot/firmware/config.txt.pre-harden ] || cp /boot/firmware/config.txt /boot/firmware/config.txt.pre-harden || return 1
  sed -i "$CMA_SED" /boot/firmware/config.txt || return 1
}

# 1. logs in RAM
install -d -m 755 /etc/systemd/journald.conf.d
# "zz-" so it wins over earlier drop-ins (e.g. a lab Storage=persistent)
cat > /etc/systemd/journald.conf.d/zz-unplug-safe.conf <<'EOF'
# Logs in RAM: collectors are unplugged without a clean shutdown (deploy/harden.sh)
[Journal]
Storage=volatile
RuntimeMaxUse=32M
EOF
systemctl restart systemd-journald
echo "journald: logs in RAM"

# 2. no unattended package activity
for t in apt-daily.timer apt-daily-upgrade.timer man-db.timer; do
  if systemctl list-unit-files "$t" >/dev/null 2>&1 && systemctl cat "$t" >/dev/null 2>&1; then
    systemctl disable --now "$t" >/dev/null 2>&1 || true
  fi
done
if systemctl cat unattended-upgrades.service >/dev/null 2>&1; then
  systemctl disable --now unattended-upgrades.service >/dev/null 2>&1 || true
fi
echo "apt: unattended updates off"

# 3. boot partition read-only
if findmnt -no OPTIONS /boot/firmware 2>/dev/null | tr ',' '\n' | grep -qx ro; then
  echo "/boot/firmware: already read-only"
elif grep -Eq '^[^#][^[:space:]]*[[:space:]]+/boot/firmware[[:space:]]+vfat[[:space:]]' /etc/fstab; then
  cp /etc/fstab /etc/fstab.pre-harden
  sed -i -E '/^[^#][^[:space:]]*[[:space:]]+\/boot\/firmware[[:space:]]+vfat[[:space:]]/ s/^([^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+vfat[[:space:]]+)([^[:space:]]+)/\1\2,ro/' /etc/fstab
  if findmnt --verify --tab-file /etc/fstab >/dev/null 2>&1 \
     && grep -Eq '[[:space:]]/boot/firmware[[:space:]]+vfat[[:space:]]+[^[:space:]]*,ro[[:space:]]' /etc/fstab; then
    systemctl daemon-reload
    sync
    mount -o remount,ro /boot/firmware
    echo "/boot/firmware: read-only (old fstab in /etc/fstab.pre-harden)"
  else
    cp /etc/fstab.pre-harden /etc/fstab
    echo "/boot/firmware: fstab edit did not verify; left unchanged" >&2
  fi
else
  echo "/boot/firmware: no vfat entry in /etc/fstab; left unchanged" >&2
fi

# 4. automatic fsck repair at boot
if grep -qw 'fsck.repair=yes' /proc/cmdline; then
  echo "root fs: repaired automatically at boot"
else
  echo "warning: fsck.repair=yes is not on the kernel command line (/boot/firmware/cmdline.txt)" >&2
fi

# 5. 64 MB CMA instead of 256 MB (vc4-kms-v3d overlay)
if [ ! -f /boot/firmware/config.txt ]; then
  echo "config.txt: /boot/firmware/config.txt not found; CMA left unchanged" >&2
elif grep -qx 'dtoverlay=vc4-kms-v3d' /boot/firmware/config.txt; then
  if with_boot_rw cma64_config && grep -qx 'dtoverlay=vc4-kms-v3d,cma-64' /boot/firmware/config.txt; then
    echo "config.txt: dtoverlay=vc4-kms-v3d,cma-64 (64 MB CMA instead of 256 MB): takes effect at the next boot (old file in /boot/firmware/config.txt.pre-harden)"
  else
    echo "config.txt: could not set dtoverlay=vc4-kms-v3d,cma-64" >&2
  fi
elif grep -qx 'dtoverlay=vc4-kms-v3d,cma-64' /boot/firmware/config.txt; then
  echo "config.txt: already dtoverlay=vc4-kms-v3d,cma-64 (64 MB CMA)"
elif grep -q '^dtoverlay=vc4-kms-v3d' /boot/firmware/config.txt; then
  echo "config.txt: vc4-kms-v3d overlay has its own parameters; CMA left unchanged"
else
  echo "config.txt: no vc4-kms-v3d overlay; CMA left unchanged"
fi
