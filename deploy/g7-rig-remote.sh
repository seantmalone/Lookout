#!/bin/sh
# Forced command for the g7rig SSH account (installed as
# /usr/local/sbin/g7-rig-remote, run through sudo from authorized_keys):
#   restrict,command="sudo /usr/local/sbin/g7-rig-remote" <UI public key>
# Allows exactly these SSH_ORIGINAL_COMMANDs and nothing else:
#   status | export-key | import-key | scan DXCMxx | pair NNNN DXCMxx
# g7-rig.js checks the same rules again (lib/g7rig/validate.js).
set -eu
# Byte-wise bracket ranges: in other locales [A-Za-z] can match more.
LC_ALL=C
export LC_ALL
NODE=${G7RIG_NODE:-/opt/node/bin/node}   # override for tests; sudo resets the env
CMD=${SSH_ORIGINAL_COMMAND:-}
case "$CMD" in
  status|export-key|import-key) ;;
  "scan DXCM"[A-Za-z0-9][A-Za-z0-9]) ;;
  "pair "[0-9][0-9][0-9][0-9]" DXCM"[A-Za-z0-9][A-Za-z0-9]) ;;
  *) logger -t g7-rig-remote "rejected: $CMD" || true; echo "rejected" >&2; exit 2;;
esac
# $CMD is unquoted on purpose: it is one of the forms above, split into words.
# shellcheck disable=SC2086
exec "$NODE" /usr/local/sbin/g7-rig.js $CMD
