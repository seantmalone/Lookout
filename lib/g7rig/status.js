// Build `g7-rig status` from Lookout's storage. The sensor key itself must
// never appear in the result: only its fingerprint. Only node built-ins
// here: this file is installed to /usr/local/lib/g7rig.

const crypto = require('crypto');

const { readArgs } = require('./env');

const PAIRING_TIMEOUT_MS = 15 * 60 * 1000;
const ERROR_RE = /0a0300|Mismatch|failed reads|Error:/;

const fingerprint = (keyHex) => crypto.createHash('sha256').update(String(keyHex)).digest('hex').slice(0, 12);

const iso = (t) => {
  if (t === null || t === undefined || t === '') return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const str = (v) => (typeof v === 'string' && v !== '' ? v : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const hasKey = (sensorKey) => Boolean(sensorKey && typeof sensorKey.key === 'string' && sensorKey.key);

// Lookout's setEvent stores { date: ms, notes }; older items may be a bare ms.
const eventTime = (ev) => {
  if (ev === null || ev === undefined) return null;
  if (typeof ev === 'object') return iso(ev.date);
  return iso(ev);
};

const KEYLIKE_RE = /[0-9a-f]{32}/gi;

// Log lines go into status: strip the key, and anything shaped like one.
const redact = (line, sensorKey) => {
  let out = line.replace(KEYLIKE_RE, '[redacted]');
  if (hasKey(sensorKey)) {
    [sensorKey.key, sensorKey.key.toLowerCase(), sensorKey.key.toUpperCase()].forEach((k) => {
      out = out.split(k).join('[redacted]');
    });
  }
  return out;
};

const lastOf = (arr) => (Array.isArray(arr) && arr.length > 0 ? arr[arr.length - 1] : null);

const pairing = ({ sensorKey, pairRequest, keyRejected }, now) => {
  const requestAt = pairRequest ? iso(pairRequest.at) : null;
  // A fresh key from `g7-rig pair` / `import-key` always clears keyRejected,
  // so one that is present means the key Lookout holds (if any) was refused.
  if (keyRejected) {
    return { state: 'failed', since: iso(keyRejected.at), error: 'rejected: check the code' };
  }
  if (hasKey(sensorKey)) return { state: 'paired', since: requestAt, error: null };
  if (pairRequest) {
    const age = now - Number(pairRequest.at);
    if (age < PAIRING_TIMEOUT_MS) return { state: 'waiting', since: requestAt, error: null };
    return { state: 'failed', since: requestAt, error: 'not heard' };
  }
  return { state: 'idle', since: null, error: null };
};

const build = ({
  storage, envText, lookoutActive, btPowered, now, host, uptimeS, version, errors,
}) => {
  const s = storage || {};
  const env = readArgs(envText);
  const nowMs = Number(now);
  const sensorKey = s.sensorKey || null;
  const last = lastOf(s.glucoseHist);
  const seen = s.sensorSeen || null;

  return {
    host: host || null,
    version: version || null,
    uptime_s: num(uptimeS) === null ? null : Math.floor(uptimeS),
    lookout_active: Boolean(lookoutActive),
    bluetooth_powered: Boolean(btPowered),
    sensor: {
      code: str(s.id),
      name: str(s.sensorName),
      address: (sensorKey && str(sensorKey.address)) || env.sensorAddress || null,
      key_fingerprint: hasKey(sensorKey) ? fingerprint(sensorKey.key) : null,
      // The sensor's own session start (on each reading) wins over the
      // start Lookout recorded itself.
      session_start: (last && iso(last.sessionStartDate)) || eventTime(s.sensorStart),
      // the length the sensor reported (stored by Lookout)
      session_length_s: num(s.sessionLengthSeconds),
      // when this key was paired (Lookout records it; import-key copies it)
      paired_at: s.pairedAt ? iso(s.pairedAt) : null,
    },
    last_reading: last ? {
      time: iso(last.readDateMills),
      glucose: num(last.glucose),
      trend: num(last.trend),
    } : null,
    last_heard: seen ? { time: iso(seen.time), rssi: num(seen.rssi) } : null,
    pairing: pairing(s, nowMs),
    errors: Array.isArray(errors) ? errors.map((e) => redact(String(e), sensorKey)) : [],
  };
};

// Last `max` distinct journal lines that look like errors, oldest first.
const recentErrors = (journalText, max = 5) => {
  const lines = String(journalText || '').split('\n').filter((l) => ERROR_RE.test(l));
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < max; i -= 1) {
    const line = redact(lines[i].trim());
    if (line && !out.includes(line)) out.unshift(line);
  }
  return out;
};

module.exports = {
  build, fingerprint, recentErrors, PAIRING_TIMEOUT_MS,
};
