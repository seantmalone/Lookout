// Parse `bluetoothctl --timeout N scan le` plus `bluetoothctl devices` into
// { heard, rssi, address } for exactly one sensor name, the same way
// deploy/g7-new-sensor.sh does: a device counts only if it has exactly that
// name AND advertised during this scan ([NEW]/[CHG] lines). BlueZ reports no
// RSSI for an already-bonded device in `info`, so the scan lines are used.
// Only node built-ins here: this file is installed to /usr/local/lib/g7rig.

// bluetoothctl colours its output and redraws its prompt.
const clean = (text) => String(text || '')
  .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '') // eslint-disable-line no-control-regex
  .split(/\r?\n|\r/);

const MAC = '([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})';
const DEVICE_RE = new RegExp(`^Device ${MAC} (.+)$`);
const EVENT_RE = new RegExp(`\\[(NEW|CHG)\\] Device ${MAC}(?: (.*))?$`);
const RSSI_RE = /^RSSI: (?:0x[0-9a-f]+ \()?(-?\d+)\)?/i;

const parseScan = (scanText, devicesText, name) => {
  const named = new Set();
  clean(devicesText).forEach((line) => {
    const m = DEVICE_RE.exec(line.trim());
    if (m && m[2].trim() === name) named.add(m[1].toUpperCase());
  });

  const seen = new Map(); // mac -> latest rssi (or null)
  clean(scanText).forEach((line) => {
    const m = EVENT_RE.exec(line.trim());
    if (!m) return;
    const mac = m[2].toUpperCase();
    const rest = (m[3] || '').trim();
    if (m[1] === 'NEW' && rest === name) named.add(mac);
    const r = RSSI_RE.exec(rest);
    if (r) seen.set(mac, Number(r[1]));
    else if (!seen.has(mac)) seen.set(mac, null);
  });

  const heard = [...named].filter((mac) => seen.has(mac));
  if (heard.length > 1) throw new Error(`two devices named ${name}; refusing`);
  if (heard.length === 0) return { heard: false, rssi: null, address: null };
  return { heard: true, rssi: seen.get(heard[0]), address: heard[0] };
};

module.exports = { parseScan };
