#!/bin/sh
# g7-netwatch: reboot a collector whose network has fallen over.
# Installed as /usr/local/sbin/g7-netwatch by deploy/install.sh and run once a
# minute by g7-netwatch.timer (through g7-netwatch.service, Type=oneshot).
# One check per run; the timer is the loop.
#
#   g7-netwatch            one check (what the service runs)
#   g7-netwatch --dry-run  the same check, but never reboots and never logs to
#                          the journal: it prints what it would do instead.
#                          Its state is kept apart from the real one
#                          (/run/g7-netwatch-dry-run) unless
#                          G7_NETWATCH_STATE_DIR says otherwise.
#
# Seen twice on a Pi Zero W: the collector dropped off Wi-Fi while powered and
# only came back after a power cycle. Collectors are headless, run from a
# read-only card (a reboot is safe) and keep reading the sensor without a
# network (uploads catch up later), so a needless reboot costs readings.
#
# "Network OK" = the default gateway answers a ping (2 pings, 3 s wait).
# No default route is not OK. Each run that is not OK counts as one minute.
#  - The network has worked since boot and then is down for 10 minutes in a
#    row: reboot (the Wi-Fi fell over while running).
#  - It has not worked since boot (router off, wrong Wi-Fi password, out of
#    range): reboot only after 60 minutes, so a long router outage costs at
#    most one reboot an hour.
# Logs (logger -t g7-netwatch): one line when the network is first seen down,
# one every 5 minutes while down, one when it comes back (and for how long it
# was down), one before rebooting. Nothing while the network is fine.
#
# State in /run/g7-netwatch (gone at reboot): "up" exists once the network has
# worked since boot; "down" holds the minutes down in a row.
#
# The environment can override (tests, checking on a device):
#   G7_NETWATCH_STATE_DIR            state directory
#   G7_NETWATCH_GATEWAY              the address to ping instead of the gateway
#   G7_NETWATCH_REBOOT_MIN           minutes down before a reboot, after having been up (10)
#   G7_NETWATCH_NEVER_UP_REBOOT_MIN  the same when never up since boot (60)
#   G7_NETWATCH_LOG_EVERY_MIN        minutes between "still down" lines (5)
#
# To turn it off: sudo systemctl disable --now g7-netwatch.timer
# (on a read-only card also delete the timer's link under
# /media/root-ro/etc/systemd/system/timers.target.wants/: deploy/README.md).

REBOOT_MIN=${G7_NETWATCH_REBOOT_MIN:-10}
NEVER_UP_REBOOT_MIN=${G7_NETWATCH_NEVER_UP_REBOOT_MIN:-60}
LOG_EVERY_MIN=${G7_NETWATCH_LOG_EVERY_MIN:-5}
PING_COUNT=2
PING_WAIT=3
TAG=g7-netwatch

DRY_RUN=no
case ${1:-} in
  --dry-run) DRY_RUN=yes ;;
  "") ;;
  *) echo "usage: g7-netwatch [--dry-run]" >&2; exit 2 ;;
esac
[ $# -le 1 ] || { echo "usage: g7-netwatch [--dry-run]" >&2; exit 2; }

if [ "$DRY_RUN" = yes ]; then
  STATE_DIR=${G7_NETWATCH_STATE_DIR:-/run/g7-netwatch-dry-run}
else
  STATE_DIR=${G7_NETWATCH_STATE_DIR:-/run/g7-netwatch}
fi

log() {
  if [ "$DRY_RUN" = yes ]; then
    echo "$*"
  else
    logger -t "$TAG" "$*"
  fi
}

# The gateway of the first default route ("default via ADDR ..."), or nothing.
gateway() {
  if [ -n "${G7_NETWATCH_GATEWAY:-}" ]; then echo "$G7_NETWATCH_GATEWAY"; return; fi
  set -f
  # shellcheck disable=SC2046
  set -- $(ip route show default 2>/dev/null)
  set +f
  while [ $# -gt 1 ]; do
    if [ "$1" = via ]; then echo "$2"; return; fi
    shift
  done
}

mkdir -p "$STATE_DIR" || { echo "g7-netwatch: cannot create $STATE_DIR" >&2; exit 1; }

DOWN=0
if [ -f "$STATE_DIR/down" ]; then
  read -r DOWN < "$STATE_DIR/down" || DOWN=0
fi
case $DOWN in ''|*[!0-9]*) DOWN=0 ;; esac

GW=$(gateway)
if [ -n "$GW" ] && ping -c "$PING_COUNT" -W "$PING_WAIT" "$GW" >/dev/null 2>&1; then
  if [ "$DOWN" -gt 0 ]; then
    log "network back after $DOWN min down (gateway $GW answers)"
  elif [ "$DRY_RUN" = yes ]; then
    echo "network OK: gateway $GW answers (state in $STATE_DIR)"
  fi
  : > "$STATE_DIR/up"
  echo 0 > "$STATE_DIR/down"
  exit 0
fi

DOWN=$((DOWN + 1))
echo "$DOWN" > "$STATE_DIR/down"
if [ -n "$GW" ]; then WHY="gateway $GW does not answer"; else WHY="no default route"; fi

if [ -f "$STATE_DIR/up" ]; then
  LIMIT=$REBOOT_MIN
  REASON="network down for $DOWN min after working earlier this boot"
  PLAN="rebooting if still down after $LIMIT min"
else
  LIMIT=$NEVER_UP_REBOOT_MIN
  REASON="no network for $DOWN min since boot"
  PLAN="no network yet since boot, rebooting if still down after $LIMIT min"
fi

if [ "$DOWN" -ge "$LIMIT" ]; then
  if [ "$DRY_RUN" = yes ]; then
    echo "$REASON: would reboot now (dry run: not rebooting)"
    exit 0
  fi
  log "$REASON: rebooting"
  journalctl --sync >/dev/null 2>&1
  systemctl reboot || { log "systemctl reboot failed"; exit 1; }
  exit 0
fi

if [ "$DOWN" -eq 1 ]; then
  log "network down: $WHY; $PLAN"
elif [ "$LOG_EVERY_MIN" -gt 0 ] && [ $((DOWN % LOG_EVERY_MIN)) -eq 0 ]; then
  log "network still down after $DOWN min: $WHY"
fi
exit 0
