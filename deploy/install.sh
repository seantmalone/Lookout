#!/bin/sh
# Install/refresh the Lookout systemd units for a Dexcom G7 rig.
#   sudo deploy/install.sh [--enable]
# Does not overwrite an existing /etc/lookout.env.
set -eu
[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
DIR=$(cd "$HERE/.." && pwd)
USER_NAME=${SUDO_USER:-$(stat -c %U "$DIR")}
NODE=$(sudo -u "$USER_NAME" sh -c 'command -v node' || true)
[ -n "$NODE" ] || { [ -x /opt/node/bin/node ] && NODE=/opt/node/bin/node; }
[ -n "$NODE" ] || { echo "node not found" >&2; exit 1; }
NODE_BIN=$(dirname "$NODE")
# g7-rig-remote (the UI's forced command) runs /opt/node/bin/node: sudo resets PATH
[ -x /opt/node/bin/node ] || echo "warning: /opt/node/bin/node not found: g7-rig over SSH will not work (deploy/README.md, Node)" >&2

sed -e "s#@USER@#$USER_NAME#g" -e "s#@DIR@#$DIR#g" -e "s#@NODE_BIN@#$NODE_BIN#g" \
  "$HERE/systemd/lookout.service" > /etc/systemd/system/lookout.service
install -d /etc/systemd/system/lookout.service.d /etc/systemd/system/bluetooth.service.d
install -m 644 "$HERE/systemd/lookout.service.d/priority.conf" /etc/systemd/system/lookout.service.d/priority.conf
# Bluetooth is restarted only when needed (a restart kills a sensor read or
# pairing in progress): note whether the drop-in is new or changed
BT_DROPIN=/etc/systemd/system/bluetooth.service.d/g7.conf
if cmp -s "$HERE/systemd/bluetooth.service.d/g7.conf" "$BT_DROPIN"; then BT_DROPIN_CHANGED=0; else BT_DROPIN_CHANGED=1; fi
install -m 644 "$HERE/systemd/bluetooth.service.d/g7.conf" "$BT_DROPIN"
if [ ! -e /etc/lookout.env ]; then
  install -m 600 "$HERE/lookout.env.example" /etc/lookout.env
  echo "created /etc/lookout.env from the example: edit it before starting"
fi
# g7-rig (fleet UI interface); access for the UI: deploy/setup-g7rig-access.sh
install -d -o root -g root -m 755 /usr/local/lib/g7rig
install -o root -g root -m 644 "$DIR"/lib/g7rig/*.js /usr/local/lib/g7rig/
install -o root -g root -m 755 "$HERE/g7-rig.js" /usr/local/sbin/g7-rig.js
install -o root -g root -m 755 "$HERE/g7-rig-remote.sh" /usr/local/sbin/g7-rig-remote
# removed from the repo (g7-rig pair replaced it); on a read-only card
# update-readonly.sh also deletes it from the card
rm -f /usr/local/sbin/g7-new-sensor
# shared Bluetooth address (/etc/g7-central, written by g7-rig import-key)
install -o root -g root -m 755 "$HERE/g7-central-apply.sh" /usr/local/sbin/g7-central-apply
install -m 644 "$HERE/systemd/g7-central.service" /etc/systemd/system/g7-central.service
# Bluetooth watchdog: restarts bluetooth when discovering hears nothing
sed "s#@NODE_BIN@#$NODE_BIN#g" "$HERE/systemd/g7-bt-watchdog.service" > /etc/systemd/system/g7-bt-watchdog.service
install -m 644 "$HERE/systemd/g7-bt-watchdog.timer" /etc/systemd/system/g7-bt-watchdog.timer
# responsiveness watchdog: reboots when userspace or the SD card stalls
install -o root -g root -m 755 "$HERE/g7-alive.sh" /usr/local/sbin/g7-alive
install -m 644 "$HERE/systemd/g7-alive.service" /etc/systemd/system/g7-alive.service
# network watchdog: reboots when the network has been down too long
install -o root -g root -m 755 "$HERE/g7-netwatch.sh" /usr/local/sbin/g7-netwatch
install -m 644 "$HERE/systemd/g7-netwatch.service" /etc/systemd/system/g7-netwatch.service
install -m 644 "$HERE/systemd/g7-netwatch.timer" /etc/systemd/system/g7-netwatch.timer
# lab-netwatch: an earlier version of g7-netwatch, installed by hand on some
# collectors; on a read-only card update-readonly.sh also deletes it from the card
systemctl disable --now lab-netwatch.timer >/dev/null 2>&1 || true
rm -f /usr/local/sbin/lab-netwatch /etc/systemd/system/lab-netwatch.service /etc/systemd/system/lab-netwatch.timer /etc/systemd/system/timers.target.wants/lab-netwatch.timer
systemctl daemon-reload
systemctl enable g7-central.service >/dev/null 2>&1 || true
systemctl enable --now g7-bt-watchdog.timer >/dev/null
systemctl enable g7-alive.service >/dev/null 2>&1
systemctl enable --now g7-netwatch.timer >/dev/null
# a restart is a clean stop (not a failure) and runs the new script
systemctl restart g7-alive.service
# bt-restart-decision: begin (BT_DROPIN_CHANGED in, BT_REASON out; PROC_ROOT for tests)
BT_REASON=
if [ "$BT_DROPIN_CHANGED" = 1 ]; then
  BT_REASON="drop-in changed"
else
  BT_PID=$(systemctl show -p MainPID --value bluetooth 2>/dev/null || true)
  case "$BT_PID" in
    ''|0|*[!0-9]*) ;;  # not running or unknown: only a changed drop-in restarts
    *) if [ -r "${PROC_ROOT:-/proc}/$BT_PID/cmdline" ] \
         && ! tr '\0' '\n' < "${PROC_ROOT:-/proc}/$BT_PID/cmdline" | grep -qx -- '--noplugin=gap'; then
         BT_REASON="bluetoothd running without --noplugin=gap"
       fi ;;
  esac
fi
# bt-restart-decision: end
if [ -n "$BT_REASON" ]; then
  systemctl restart bluetooth
  BT_STATE="restarted ($BT_REASON)"
else
  BT_STATE="unchanged, not restarted"
fi
if [ "${1:-}" = "--enable" ]; then systemctl enable --now lookout; fi
echo "installed: lookout.service (+priority), bluetooth --noplugin=gap, g7-rig, g7-bt-watchdog.timer, g7-alive.service, g7-netwatch.timer; bluetooth: $BT_STATE"
