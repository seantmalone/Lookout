// The G7 ties its watch-slot key to the Bluetooth address of the central that
// paired. Collectors sharing a key therefore also share that address: it is
// kept in /etc/g7-central and applied to the adapter (btmgmt public-addr) at
// boot and by `g7-rig import-key`. Only node built-ins here.

const MAC_RE = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/i;
const FILE = '/etc/g7-central';

const parse = (text) => {
  const line = String(text || '').split('\n').map((l) => l.trim())
    .find((l) => l && !l.startsWith('#'));
  return line && MAC_RE.test(line) ? line.toUpperCase() : null;
};

const format = (mac) => {
  if (!MAC_RE.test(mac || '')) throw new Error('bad central address');
  return '# Bluetooth address the sensor knows (shared by every collector; g7-rig)\n'
    + `${mac.toUpperCase()}\n`;
};

// "Controller B8:27:EB:3F:E8:DD (public)" from `bluetoothctl show`
const adapterAddress = (showOutput) => {
  const m = /^Controller\s+([0-9A-F]{2}(?::[0-9A-F]{2}){5})/im.exec(String(showOutput || ''));
  return m ? m[1].toUpperCase() : null;
};

module.exports = {
  parse, format, adapterAddress, MAC_RE, FILE,
};
