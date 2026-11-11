#!/bin/sh
# Give the fleet UI locked-down access to this collector (idempotent).
#   sudo deploy/setup-g7rig-access.sh "$(cat /var/lib/dexcom-ui/id_ed25519.pub)"
#
# Creates the system user g7rig, whose only SSH key may run nothing but
#   sudo /usr/local/sbin/g7-rig-remote
# (which allows status, scan, pair, export-key and import-key; see
# g7-rig-remote.sh). Installs g7-rig.js, its lib and the wrapper as root:root.
set -eu
[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
PUBKEY=${1:-}
[ -n "$PUBKEY" ] || { echo "usage: $0 'ssh-ed25519 AAAA... comment'" >&2; exit 2; }
HERE=$(cd "$(dirname "$0")" && pwd)
LIB=$(cd "$HERE/../lib/g7rig" && pwd)

# One public key on one line, nothing that could add options or a command.
case "$PUBKEY" in
  *'
'*|*'"'*|*'\'*) echo "public key must be one line without quotes" >&2; exit 2;;
  ssh-ed25519\ *|ssh-rsa\ *|ecdsa-sha2-*\ *|sk-ssh-ed25519@openssh.com\ *|sk-ecdsa-sha2-*\ *) ;;
  *) echo "not an OpenSSH public key" >&2; exit 2;;
esac
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
printf '%s\n' "$PUBKEY" > "$TMP/key.pub"
ssh-keygen -l -f "$TMP/key.pub" >/dev/null || { echo "ssh-keygen cannot read that public key" >&2; exit 2; }

# g7-rig itself (also installed by install.sh)
install -d -o root -g root -m 755 /usr/local/lib/g7rig
install -o root -g root -m 644 "$LIB"/*.js /usr/local/lib/g7rig/
install -o root -g root -m 755 "$HERE/g7-rig.js" /usr/local/sbin/g7-rig.js
install -o root -g root -m 755 "$HERE/g7-rig-remote.sh" /usr/local/sbin/g7-rig-remote

# The account: no password ("*", not "!", which sshd may treat as locked)
if ! id g7rig >/dev/null 2>&1; then
  useradd --system --create-home --shell /bin/sh g7rig
fi
usermod -p '*' g7rig
HOME_DIR=$(getent passwd g7rig | cut -d: -f6)
[ -n "$HOME_DIR" ] && [ -d "$HOME_DIR" ] || { echo "g7rig has no home directory" >&2; exit 1; }

install -d -o g7rig -g g7rig -m 700 "$HOME_DIR/.ssh"
printf 'restrict,command="sudo /usr/local/sbin/g7-rig-remote" %s\n' "$PUBKEY" > "$TMP/authorized_keys"
install -o g7rig -g g7rig -m 600 "$TMP/authorized_keys" "$HOME_DIR/.ssh/authorized_keys"

# sudo resets the environment; the wrapper needs the command sshd was asked for.
printf '%s\n' \
  'Defaults:g7rig env_keep += "SSH_ORIGINAL_COMMAND"' \
  'g7rig ALL=(root) NOPASSWD: /usr/local/sbin/g7-rig-remote' > "$TMP/sudoers"
visudo -cf "$TMP/sudoers" >/dev/null || { echo "sudoers check failed; not installed" >&2; exit 1; }
install -o root -g root -m 440 "$TMP/sudoers" /etc/sudoers.d/g7rig

echo "g7rig access set up: ssh g7rig@$(hostname) status"
