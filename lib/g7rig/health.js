// The `health` object of `g7-rig status`: load, memory, swap, the RAM
// overlay's use, the firmware's throttling flags and how long bluetoothd
// took to answer. A contract with the fleet UI: these names and units (kB,
// ms) only, and null for anything that cannot be read. Pure parsing;
// g7-rig.js reads /proc, statfs's the overlay, runs `vcgencmd get_throttled`
// and times `bluetoothctl show`. Only node built-ins here: this file is
// installed to /usr/local/lib/g7rig.

// The RAM overlay of a read-only card (overlayroot=tmpfs).
const OVERLAY_MOUNT = '/media/root-rw';

const count = (n) => (Number.isFinite(n) && n >= 0 ? n : null);

// /proc/loadavg: "0.93 0.71 0.55 1/123 4567"
const load1 = (text) => {
  const m = /^\s*(\d+(?:\.\d+)?)\s/.exec(String(text || ''));
  return m ? Number(m[1]) : null;
};

const meminfoFields = (text) => {
  const fields = {};
  String(text || '').split('\n').forEach((line) => {
    const m = /^([A-Za-z0-9_()]+):\s+(\d+)(?:\s+kB)?\s*$/.exec(line.trim());
    if (m) fields[m[1]] = Number(m[2]);
  });
  return fields;
};

// /proc/meminfo -> kB
const memory = (text) => {
  const f = meminfoFields(text);
  const get = (k) => (k in f ? count(f[k]) : null);
  const swapTotal = get('SwapTotal');
  const swapFree = get('SwapFree');
  return {
    mem_total_kb: get('MemTotal'),
    mem_available_kb: get('MemAvailable'),
    swap_total_kb: swapTotal,
    swap_used_kb: swapTotal !== null && swapFree !== null ? count(swapTotal - swapFree) : null,
  };
};

// `vcgencmd get_throttled` prints "throttled=0x0"
const throttled = (text) => {
  const m = /throttled=(0x[0-9a-fA-F]+)/.exec(String(text || ''));
  return m ? m[1] : null;
};

// Is `target` a mount point in /proc/mounts? (an unmounted directory would
// statfs as the root filesystem)
const isMounted = (mountsText, target) => String(mountsText || '').split('\n')
  .some((line) => line.split(' ')[1] === target);

// fs.statfsSync result -> kB used/total (used as df counts it: blocks - bfree)
const overlay = (st) => {
  const none = { overlay_used_kb: null, overlay_total_kb: null };
  if (!st) return none;
  const bsize = Number(st.bsize);
  const blocks = Number(st.blocks);
  const bfree = Number(st.bfree);
  const valid = [bsize, blocks, bfree].every((n) => Number.isFinite(n) && n >= 0);
  if (!valid || bfree > blocks) return none;
  return {
    overlay_used_kb: Math.round(((blocks - bfree) * bsize) / 1024),
    overlay_total_kb: Math.round((blocks * bsize) / 1024),
  };
};

// How long `bluetoothctl show` took, in whole ms; null when it did not finish
// (killed at its time limit). Slow answers mean a struggling bluetoothd (e.g.
// thousands of remembered devices with TemporaryTimeout = 0).
const bluetoothMs = (ms) => (typeof ms === 'number' && count(ms) !== null ? Math.round(ms) : null);

const build = ({
  loadavgText, meminfoText, overlayStatfs, throttledText, bluetoothMs: btMs,
} = {}) => ({
  load1: load1(loadavgText),
  ...memory(meminfoText),
  ...overlay(overlayStatfs),
  throttled: throttled(throttledText),
  bluetooth_ms: bluetoothMs(btMs),
});

module.exports = {
  OVERLAY_MOUNT, build, load1, memory, throttled, isMounted, overlay,
};
