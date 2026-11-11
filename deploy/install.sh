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

sed -e "s#@USER@#$USER_NAME#g" -e "s#@DIR@#$DIR#g" -e "s#@NODE_BIN@#$NODE_BIN#g" \
  "$HERE/systemd/lookout.service" > /etc/systemd/system/lookout.service
install -d /etc/systemd/system/lookout.service.d /etc/systemd/system/bluetooth.service.d
install -m 644 "$HERE/systemd/lookout.service.d/priority.conf" /etc/systemd/system/lookout.service.d/priority.conf
install -m 644 "$HERE/systemd/bluetooth.service.d/g7.conf" /etc/systemd/system/bluetooth.service.d/g7.conf
if [ ! -e /etc/lookout.env ]; then
  install -m 600 "$HERE/lookout.env.example" /etc/lookout.env
  echo "created /etc/lookout.env from the example: edit it before starting"
fi
install -m 755 "$HERE/g7-new-sensor.sh" /usr/local/sbin/g7-new-sensor
# g7-rig (fleet UI interface); access for the UI: deploy/setup-g7rig-access.sh
install -d -o root -g root -m 755 /usr/local/lib/g7rig
install -o root -g root -m 644 "$DIR"/lib/g7rig/*.js /usr/local/lib/g7rig/
install -o root -g root -m 755 "$HERE/g7-rig.js" /usr/local/sbin/g7-rig.js
install -o root -g root -m 755 "$HERE/g7-rig-remote.sh" /usr/local/sbin/g7-rig-remote
# shared Bluetooth address (/etc/g7-central, written by g7-rig import-key)
install -o root -g root -m 755 "$HERE/g7-central-apply.sh" /usr/local/sbin/g7-central-apply
install -m 644 "$HERE/systemd/g7-central.service" /etc/systemd/system/g7-central.service
systemctl daemon-reload
systemctl enable g7-central.service >/dev/null 2>&1 || true
systemctl restart bluetooth
if [ "${1:-}" = "--enable" ]; then systemctl enable --now lookout; fi
echo "installed: lookout.service (+priority), bluetooth --noplugin=gap, g7-new-sensor, g7-rig"
