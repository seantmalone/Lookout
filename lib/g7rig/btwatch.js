// Bluetooth watchdog for `g7-rig bt-watchdog` (run by g7-bt-watchdog.timer).
// Seen on a Pi Zero W after a burst of kernel out-of-memory kills: BlueZ kept
// saying "Discovering: yes" but the adapter delivered no advertisements at
// all, for hours, until bluetooth.service was restarted. Each run samples
// btmon for a few seconds; after MISSES_TO_ACT empty samples in a row while
// discovering, the command restarts Bluetooth (at most once per
// MIN_RESTART_INTERVAL_MS). Only node built-ins here: this file is installed
// to /usr/local/lib/g7rig.

const MISSES_TO_ACT = 3;
const MIN_RESTART_INTERVAL_MS = 60 * 60 * 1000;
const SAMPLE_SECONDS = 10;

const CLEAN = { misses: 0, lastRestart: null };

const validMisses = (n) => (Number.isInteger(n) && n >= 0 ? n : 0);
const validTime = (t) => (Number.isFinite(t) ? t : null);

// The state file's text (or null) -> {misses, lastRestart}
const parseState = (text) => {
  try {
    const s = JSON.parse(text);
    if (!s || typeof s !== 'object' || Array.isArray(s)) return { ...CLEAN };
    return { misses: validMisses(s.misses), lastRestart: validTime(s.lastRestart) };
  } catch (e) {
    return { ...CLEAN };
  }
};

// discovering: bluetooth.service active, adapter powered and Discovering: yes
// adverts: advertising reports in this sample, or null if no sample was taken
// misses, lastRestart: the previous state; now: ms since the epoch
// -> {act, reason, state: {misses, lastRestart}}
const decide = ({
  discovering, adverts, misses, lastRestart, now,
}) => {
  const prev = { misses: validMisses(misses), lastRestart: validTime(lastRestart) };
  if (!discovering) return { act: false, reason: 'not-discovering', state: { ...prev, misses: 0 } };
  if (adverts === null || adverts === undefined) return { act: false, reason: 'no-sample', state: prev };
  if (adverts > 0) return { act: false, reason: 'heard', state: { ...prev, misses: 0 } };
  const n = prev.misses + 1;
  if (n < MISSES_TO_ACT) return { act: false, reason: 'miss', state: { ...prev, misses: n } };
  const since = prev.lastRestart === null ? Infinity : now - prev.lastRestart;
  // a negative `since` means the clock went back: do not stay locked out
  if (since >= 0 && since < MIN_RESTART_INTERVAL_MS) {
    return { act: false, reason: 'rate-limited', state: { ...prev, misses: n } };
  }
  return { act: true, reason: 'deaf', state: { misses: 0, lastRestart: now } };
};

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
  parseState,
  countAdverts,
  adapterState,
  MISSES_TO_ACT,
  MIN_RESTART_INTERVAL_MS,
  SAMPLE_SECONDS,
};
