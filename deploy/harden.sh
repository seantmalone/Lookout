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
#  6. Wi-Fi power save off: with it on, Pi Zero W collectors lost Wi-Fi under
#     load. A NetworkManager drop-in (/etc/NetworkManager/conf.d/
#     90-g7-wifi-powersave.conf, wifi.powersave = 2, i.e. disable) sets the
#     default for every Wi-Fi connection, present and future, that does not
#     set power save itself. Only when NetworkManager's conf.d exists.
#     NetworkManager is not restarted (that would cut an SSH session over
#     Wi-Fi): its configuration is reloaded, and existing connections pick
#     the default up when they next reconnect or after a reboot. On a
#     read-only card the file lands in RAM only: deploy/update-readonly.sh
#     copies it onto the card.
#  7. BlueZ forgets devices again: an active `TemporaryTimeout = 0` line in
#     /etc/bluetooth/main.conf (left from experiments) becomes the shipped
#     default line `#TemporaryTimeout = 30`. With 0, bluetoothd never forgets
#     a device it saw while discovering: one collector held 1,795 after 3.5
#     days, `bluetoothctl show` took more than 90 s and `g7-rig status` hung.
#     Any other value is reported and left alone. Bluetooth is not
#     restarted: `sudo systemctl restart bluetooth` (or a reboot) applies it.
#     On a read-only card deploy/update-readonly.sh corrects the card's copy.
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

# 6. Wi-Fi power save off (NetworkManager default for every Wi-Fi connection)
wifi_powersave_off() {
  d=/etc/NetworkManager/conf.d
  f=$d/90-g7-wifi-powersave.conf
  [ -d "$d" ] || { echo "Wi-Fi power save: $d not found (no NetworkManager); left unchanged"; return 0; }
  cat > "$f.tmp" <<'NM' || return 1
# Wi-Fi power save off: with it on, collectors lost Wi-Fi under load
# (deploy/harden.sh). The default for every Wi-Fi connection that does not set
# 802-11-wireless.powersave itself. 2 = disable. Delete this file to go back
# to NetworkManager's default.
[connection]
wifi.powersave = 2
NM
  chmod 644 "$f.tmp" || return 1
  if cmp -s "$f.tmp" "$f"; then
    rm -f "$f.tmp"
    echo "Wi-Fi power save: already off by default ($f)"
  else
    mv -f "$f.tmp" "$f" || return 1
    echo "Wi-Fi power save: off by default ($f)"
  fi
  command -v nmcli >/dev/null 2>&1 || { echo "Wi-Fi power save: nmcli not found; active after the next NetworkManager start (a reboot)"; return 0; }
  # no restart: that would cut an SSH session over Wi-Fi
  if nmcli general reload conf >/dev/null 2>&1; then
    echo "Wi-Fi power save: NetworkManager configuration reloaded; existing connections pick it up when they next reconnect or after a reboot"
  else
    echo "Wi-Fi power save: could not reload NetworkManager's configuration; active after a reboot" >&2
  fi
  # the active Wi-Fi connection's own setting (default = the drop-in above)
  uuid=$(nmcli -t -f TYPE,UUID connection show --active 2>/dev/null | sed -n 's/^802-11-wireless://p' | head -n 1)
  [ -n "$uuid" ] || { echo "Wi-Fi power save: no active Wi-Fi connection"; return 0; }
  cur=$(nmcli -g 802-11-wireless.powersave connection show uuid "$uuid" 2>/dev/null) || cur=""
  case "$cur" in
    disable) echo "Wi-Fi power save: active connection: disable (off)" ;;
    default) echo "Wi-Fi power save: active connection: default (off with this drop-in once it reconnects)" ;;
    enable)  echo "Wi-Fi power save: active connection sets enable itself (on); to turn it off: nmcli connection modify uuid $uuid 802-11-wireless.powersave disable" >&2 ;;
    "")      echo "Wi-Fi power save: could not read the active connection's setting" ;;
    *)       echo "Wi-Fi power save: active connection: $cur" ;;
  esac
}
if [ "$(findmnt -no FSTYPE / 2>/dev/null)" = overlay ]; then
  echo "Wi-Fi power save: the card is read-only; this change is in RAM until deploy/update-readonly.sh copies it onto the card"
fi
wifi_powersave_off || echo "Wi-Fi power save: could not write the NetworkManager drop-in" >&2

# 7. BlueZ TemporaryTimeout: an active 0 back to the shipped default line
# (any spacing; a commented line is not active)
TT_SED='s/^[[:space:]]*TemporaryTimeout[[:space:]]*=[[:space:]]*0[[:space:]]*$/#TemporaryTimeout = 30/'
bt_temporary_timeout() {
  f=/etc/bluetooth/main.conf
  [ -f "$f" ] || { echo "Bluetooth: $f not found; left unchanged"; return 0; }
  v=$(sed -n 's/^[[:space:]]*TemporaryTimeout[[:space:]]*=[[:space:]]*\([^[:space:]]*\)[[:space:]]*$/\1/p' "$f" | tail -n 1)
  case "$v" in
    "") echo "Bluetooth: TemporaryTimeout: not set in $f (BlueZ default: 30 s)" ;;
    0)
      # same mode and owner (cp -p), then an atomic replace
      cp -p "$f" "$f.g7tmp" || return 1
      sed "$TT_SED" "$f" > "$f.g7tmp" || { rm -f "$f.g7tmp"; return 1; }
      mv -f "$f.g7tmp" "$f" || return 1
      if grep -q '^[[:space:]]*TemporaryTimeout[[:space:]]*=[[:space:]]*0[[:space:]]*$' "$f"; then
        echo "Bluetooth: could not change TemporaryTimeout = 0 in $f" >&2
        return 1
      fi
      echo "Bluetooth: TemporaryTimeout = 0 in $f (bluetoothd never forgets a device) replaced with the shipped default line '#TemporaryTimeout = 30' (30 s); takes effect after 'sudo systemctl restart bluetooth' or a reboot"
      if [ "$(findmnt -no FSTYPE / 2>/dev/null)" = overlay ]; then
        echo "Bluetooth: the card is read-only; this change to $f is in RAM until deploy/update-readonly.sh corrects the card's copy"
      fi
      ;;
    *) echo "Bluetooth: TemporaryTimeout = $v in $f (not the default 30 s); left unchanged" ;;
  esac
}
bt_temporary_timeout || echo "Bluetooth: could not check TemporaryTimeout in /etc/bluetooth/main.conf" >&2
