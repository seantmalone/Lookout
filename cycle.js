// Collection timing, derived from the sensor's reading interval.
//
// A real G7 reads every 300 s. For lab testing against a simulator running a
// shorter cycle, set LOOKOUT_CYCLE_SECONDS (minimum 30). The ratios reproduce
// Lookout's original constants exactly at 300 s:
//   worker timeout 6.5 min, reboot after 11 min, gap 6 min, gap margin 1 min.
const DEFAULT_SECONDS = 300;
const MIN_SECONDS = 30;

const cycleTiming = (secondsSetting) => {
  let seconds = Number(secondsSetting);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    seconds = DEFAULT_SECONDS;
  }
  seconds = Math.max(seconds, MIN_SECONDS);
  const cycleMs = seconds * 1000;
  return {
    cycleMs,
    workerTimeoutMs: Math.round(cycleMs * 1.3),
    rebootAfterMs: Math.round(cycleMs * 2.2),
    gapMs: Math.round(cycleMs * 1.2),
    gapMarginMs: Math.round(cycleMs * 0.2),
  };
};

module.exports = { cycleTiming, timing: cycleTiming(process.env.LOOKOUT_CYCLE_SECONDS) };
