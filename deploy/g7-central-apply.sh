#!/bin/sh
# Give the Bluetooth adapter the fleet's shared address from /etc/g7-central.
# The G7 ties its watch-slot key to the Bluetooth address of the collector
# that paired, so every collector sharing the key presents that address.
# Run by g7-central.service at boot (after bluetooth, before lookout).
set -eu
FILE=${G7_CENTRAL_FILE:-/etc/g7-central}
[ -f "$FILE" ] || exit 0
mac=$(grep -v '^#' "$FILE" | grep -m1 -E '^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$' | tr 'a-f' 'A-F' || true)
[ -n "$mac" ] || { echo "no valid address in $FILE" >&2; exit 0; }
current() { bluetoothctl show 2>/dev/null | sed -n 's/^Controller \([0-9A-F:]*\).*/\1/p' | head -1; }
i=0
while [ -z "$(current)" ] && [ $i -lt 30 ]; do sleep 1; i=$((i + 1)); done
if [ "$(current)" = "$mac" ]; then echo "Bluetooth address already $mac"; exit 0; fi
btmgmt --index 0 power off >/dev/null
btmgmt --index 0 public-addr "$mac"
systemctl restart bluetooth
i=0
while [ -z "$(current)" ] && [ $i -lt 30 ]; do sleep 1; i=$((i + 1)); done
btmgmt --index 0 power on >/dev/null 2>&1 || true
[ "$(current)" = "$mac" ] && echo "Bluetooth address set to $mac" || { echo "could not set the address to $mac" >&2; exit 1; }
