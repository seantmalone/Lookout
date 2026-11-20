#!/bin/sh
# g7-alive: reboot a collector whose userspace or SD card has stalled.
# Installed as /usr/local/sbin/g7-alive by deploy/install.sh and run by
# g7-alive.service (Type=notify, WatchdogSec=300, FailureAction=reboot-immediate).
#
#   g7-alive          the loop (what the service runs)
#   g7-alive --once   one round on its own (for tests): exit 0 if it notified
#
# Each round, every 30 s:
#  1. run an external program (date): if starting programs stalls, so does
#     this loop
#  2. read one 4 KiB block straight from the card (dd iflag=direct: the page
#     cache cannot answer for it), under timeout(1) so an error (logged, one
#     line) is told apart from no answer at all
#  3. only if both worked: systemd-notify WATCHDOG=1
# With no notification for 5 minutes, systemd kills the service; it then
# failed (result "watchdog") and FailureAction reboots at once.
#
# Seen once: a collector unresponsive for 31 hours (SSH connected, nothing
# answered) while the kernel and PID 1 kept the hardware watchdog fed. Cause
# unknown (the logs were in RAM): the card not answering reads, or memory
# thrash.
#
# The card device is the whole disk under /media/root-ro (read-only card),
# else under /. If it cannot be found, or cannot be read at start (so a wrong
# device can never cause a reboot loop), only the exec check runs.
#
# This must never exit by itself: any exit other than a clean stop counts as
# a failure and reboots. Hence no `set -e` / `set -u`.
# G7_ALIVE_DEVICE overrides the device (tests).

INTERVAL=30
READ_TIMEOUT=60
BLOCKS=4096          # read within the card's first 16 MB
DEV=""
BLOCK=0

log() { echo "$*"; }

# The card's whole-disk block device (e.g. /dev/mmcblk0), or nothing.
card_device() {
  if [ -n "$G7_ALIVE_DEVICE" ]; then echo "$G7_ALIVE_DEVICE"; return 0; fi
  src=$(findmnt -n -o SOURCE /media/root-ro 2>/dev/null)
  [ -n "$src" ] || src=$(findmnt -n -o SOURCE / 2>/dev/null)
  case $src in /dev/*) ;; *) return 1 ;; esac
  [ -b "$src" ] || return 1
  disk=$(lsblk -n -d -o PKNAME "$src" 2>/dev/null)
  if [ -n "$disk" ] && [ -b "/dev/$disk" ]; then echo "/dev/$disk"; else echo "$src"; fi
}

setup() {
  DEV=$(card_device) || DEV=""
  if [ -n "$DEV" ]; then
    log "card check: one direct read from $DEV every ${INTERVAL} s"
  else
    log "card check off: could not determine the SD card's block device; checking exec only"
  fi
}

# One block from the card, bypassing the page cache; a different block each time.
read_card() {
  BLOCK=$(( (BLOCK + 997) % BLOCKS ))
  err=$(timeout "$READ_TIMEOUT" dd if="$DEV" of=/dev/null bs=4096 count=1 skip="$BLOCK" iflag=direct status=none 2>&1)
  rc=$?
  [ "$rc" -eq 0 ] && return 0
  if [ "$rc" -eq 124 ]; then
    log "card read: no answer from $DEV in ${READ_TIMEOUT} s (block $BLOCK); not notifying"
  else
    set -f; set -- $err; set +f          # one line
    log "card read ERROR on $DEV (block $BLOCK, exit $rc): $*; not notifying"
  fi
  return 1
}

round() {
  if ! date +%s >/dev/null 2>&1; then
    log "exec check failed (date); not notifying"
    return 1
  fi
  if [ -n "$DEV" ]; then read_card || return 1; fi
  systemd-notify WATCHDOG=1 || { log "systemd-notify WATCHDOG=1 failed"; return 1; }
}

case ${1:-} in
  --once) setup; round; exit $? ;;
  "") ;;
  *) echo "usage: g7-alive [--once]" >&2; exit 2 ;;
esac

trap 'log "stopped"; exit 0' TERM INT
setup
if [ -n "$DEV" ] && ! read_card; then
  log "card check off: $DEV could not be read at start; checking exec only"
  DEV=""
fi
systemd-notify --ready
while :; do
  round
  sleep "$INTERVAL"
done
