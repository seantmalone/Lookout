// Fleet mode (--no_auto_pair): several collectors share one sensor key, which
// the UI device hands out with g7-rig. A collector only runs a J-PAKE pairing
// when g7-rig pair asked for it (storage pairRequest); otherwise it would give
// the sensor's slot a new key and lock every other collector out.

const hasKey = (sensorKey) => Boolean(sensorKey && sensorKey.key);

const workerPlan = ({ noAutoPair, sensorKey, pairRequest }) => {
  if (!noAutoPair) return { start: true, allowPairing: true, reason: 'automatic pairing' };
  if (hasKey(sensorKey)) return { start: true, allowPairing: false, reason: 'saved key' };
  if (pairRequest) return { start: true, allowPairing: true, reason: 'pairing requested' };
  return { start: false, allowPairing: false, reason: 'waiting for a key' };
};

// Storage changes for a 'sensorKey' message from the worker.
// pairRequest present: this key comes from a pairing g7-rig asked for, so record
// when it was paired (the UI adopts a key paired after its own record).
const onSensorKey = ({
  data, noAutoPair, pairRequest = null, now = Date.now(),
}) => {
  if (hasKey(data)) {
    const set = { sensorKey: data };
    if (pairRequest) set.pairedAt = now;
    return { set, remove: ['pairRequest', 'keyRejected'] };
  }
  // An empty key means authentication failed. In a fleet keep the shared key:
  // the UI decides what to do (copy a newer key, or ask for a new pairing).
  if (noAutoPair) return { set: {}, remove: [] };
  return { set: { sensorKey: data }, remove: [] };
};

const onPairingBlocked = ({ now }) => ({ set: { keyRejected: { at: now } }, remove: [] });

// "Last heard": store a sighting at most once a minute (each is a durable
// SD-card write; the UI shows it in minutes).
const SEEN_MIN_INTERVAL_MS = 60000;
const shouldStoreSeen = (prev, next, minIntervalMs = SEEN_MIN_INTERVAL_MS) => {
  if (!prev) return true;
  if (prev.address !== next.address) return true;
  return (next.time - prev.time) >= minIntervalMs;
};

module.exports = {
  workerPlan, onSensorKey, onPairingBlocked, shouldStoreSeen, SEEN_MIN_INTERVAL_MS,
};
