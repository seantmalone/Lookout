// Bluetooth watchdog for `g7-rig bt-watchdog` (run by g7-bt-watchdog.timer).
// Two failures, each restarting bluetooth.service (at most once per
// MIN_RESTART_INTERVAL_MS, shared):
// - Deaf: seen on a Pi Zero W after a burst of kernel out-of-memory kills.
//   BlueZ kept saying "Discovering: yes" but the adapter delivered no
//   advertisements at all, for hours. Each run samples btmon for a few
//   seconds; after MISSES_TO_ACT empty samples in a row while discovering,
//   restart.
// - Unresponsive: bluetoothd does not answer `bluetoothctl show` within its
//   time limit (seen with TemporaryTimeout = 0 in /etc/bluetooth/main.conf:
//   1,795 remembered devices, `bluetoothctl show` > 90 s). After
//   NO_ANSWER_TO_ACT such runs in a row, restart.
// Separately, when bluetoothd answers, a count of the devices it holds above
// DEVICES_WARN is worth one warning an hour (no restart for that alone).
// Only node built-ins here: this file is installed to /usr/local/lib/g7rig.

const MISSES_TO_ACT = 3;
const NO_ANSWER_TO_ACT = 2;
const MIN_RESTART_INTERVAL_MS = 60 * 60 * 1000;
const SAMPLE_SECONDS = 10;
const DEVICES_WARN = 500;
const WARN_INTERVAL_MS = 60 * 60 * 1000;

const CLEAN = {
  misses: 0, noAnswer: 0, lastRestart: null, lastWarning: null,
};

const validCount = (n) => (Number.isInteger(n) && n >= 0 ? n : 0);
const validTime = (t) => (Number.isFinite(t) ? t : null);

// The state file's text (or null) -> {misses, noAnswer, lastRestart, lastWarning}
const parseState = (text) => {
  try {
    const s = JSON.parse(text);
    if (!s || typeof s !== 'object' || Array.isArray(s)) return { ...CLEAN };
    return {
      misses: validCount(s.misses),
      noAnswer: validCount(s.noAnswer),
      lastRestart: validTime(s.lastRestart),
      lastWarning: validTime(s.lastWarning),
    };
  } catch (e) {
    return { ...CLEAN };
  }
};

// Has at least `interval` passed since `last`? (a negative gap means the
// clock went back: do not stay locked out)
const due = (last, now, interval) => {
  const since = last === null ? Infinity : now - last;
  return !(since >= 0 && since < interval);
};

// answered: false when `bluetoothctl show` got no answer in its time limit
//   (missing = true, as before this rule)
// discovering: bluetooth.service active, adapter powered and Discovering: yes
// adverts: advertising reports in this sample, or null if no sample was taken
// misses, noAnswer, lastRestart: the previous state; now: ms since the epoch
// -> {act, reason, state: {misses, noAnswer, lastRestart}}
const decide = ({
  answered = true, discovering, adverts, misses, noAnswer, lastRestart, now,
}) => {
  const prev = {
    misses: validCount(misses), noAnswer: validCount(noAnswer), lastRestart: validTime(lastRestart),
  };
  if (answered === false) {
    // nothing known about discovery this time: its count stays as it was
    const n = prev.noAnswer + 1;
    if (n < NO_ANSWER_TO_ACT) return { act: false, reason: 'no-answer', state: { ...prev, noAnswer: n } };
    if (!due(prev.lastRestart, now, MIN_RESTART_INTERVAL_MS)) {
      return { act: false, reason: 'no-answer-rate-limited', state: { ...prev, noAnswer: n } };
    }
    return { act: true, reason: 'unresponsive', state: { misses: 0, noAnswer: 0, lastRestart: now } };
  }
  const base = { ...prev, noAnswer: 0 };
  if (!discovering) return { act: false, reason: 'not-discovering', state: { ...base, misses: 0 } };
  if (adverts === null || adverts === undefined) return { act: false, reason: 'no-sample', state: base };
  if (adverts > 0) return { act: false, reason: 'heard', state: { ...base, misses: 0 } };
  const n = base.misses + 1;
  if (n < MISSES_TO_ACT) return { act: false, reason: 'miss', state: { ...base, misses: n } };
  if (!due(base.lastRestart, now, MIN_RESTART_INTERVAL_MS)) {
    return { act: false, reason: 'rate-limited', state: { ...base, misses: n } };
  }
  return { act: true, reason: 'deaf', state: { misses: 0, noAnswer: 0, lastRestart: now } };
};

// devices: device objects bluetoothd holds; Infinity when it could not even
// list them in time; null when unknown (not asked, or the listing failed)
// -> {warn, state: {lastWarning}}
const deviceWarning = ({ devices, lastWarning, now }) => {
  const last = validTime(lastWarning);
  const many = typeof devices === 'number' && devices > DEVICES_WARN;
  if (!many || !due(last, now, WARN_INTERVAL_MS)) {
    return { warn: false, state: { lastWarning: last } };
  }
  return { warn: true, state: { lastWarning: now } };
};

// `busctl --list tree org.bluez` (or the tree drawing): one path per object;
// a device is .../dev_AA_BB_CC_DD_EE_FF, its services and characteristics
// are below it
const countDevices = (text) => String(text || '').split('\n')
  .filter((l) => /\/dev(_[0-9A-Fa-f]{2}){6}\s*$/.test(l)).length;

// btmon prints one "LE Advertising Report" / "LE Extended Advertising Report"
// line per HCI event carrying advertisements.
const countAdverts = (text) => String(text || '').split('\n')
  .filter((l) => /LE (Extended )?Advertising Report/.test(l)).length;

// `bluetoothctl show`
const adapterState = (show) => ({
  powered: /^\s*Powered:\s*yes\s*$/m.test(String(show || '')),
  discovering: /^\s*Discovering:\s*yes\s*$/m.test(String(show || '')),
});

module.exports = {
  decide,
  deviceWarning,
  parseState,
  countAdverts,
  countDevices,
  adapterState,
  MISSES_TO_ACT,
  NO_ANSWER_TO_ACT,
  MIN_RESTART_INTERVAL_MS,
  SAMPLE_SECONDS,
  DEVICES_WARN,
};
