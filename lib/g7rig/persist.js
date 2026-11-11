// Read-only collectors: the SD card ("lower" layer, /media/root-ro under
// overlayroot) is never written in normal running; every write goes to RAM.
// This computes and applies the few changes that must survive a power cut:
//  - Lookout's sensor items (code, key, name, pairing state, session length)
//  - /etc/lookout.env (pinned address, flags), /etc/g7-central (shared BT address)
//  - the BlueZ bond of the current sensor (so an old bond can't come back
//    after a re-pair), dropping bonds of other DXCM sensors
// Everything else in Lookout's storage (reading history etc.) is scratch: it
// is removed from the card so every boot starts clean.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { writeAtomic, fsyncDir } = require('./durable');

const PERSIST_KEYS = ['id', 'sensorKey', 'sensorName', 'pairRequest', 'keyRejected',
  'sessionLengthSeconds', 'meterid', 'pairedAt'];
const MAC_RE = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/i;

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const at = (root, p) => path.join(root, p);
const readOrNull = (f) => {
  try {
    return fs.readFileSync(f);
  } catch (e) {
    return null;
  }
};
const listDir = (d) => {
  try {
    return fs.readdirSync(d, { withFileTypes: true });
  } catch (e) {
    return [];
  }
};
const filesUnder = (dir, rel = '') => listDir(path.join(dir, rel)).flatMap((e) => (e.isDirectory()
  ? filesUnder(dir, path.join(rel, e.name))
  : [path.join(rel, e.name)]));

// a file the card should hold exactly as in RAM (or not at all)
const mirrorFile = (ops, upperRoot, lowerRoot, p) => {
  const up = readOrNull(at(upperRoot, p));
  const low = readOrNull(at(lowerRoot, p));
  if (up === null && low !== null) ops.push({ op: 'delete', path: p });
  if (up !== null && (low === null || !up.equals(low))) ops.push({ op: 'write', path: p });
};

const planSync = ({
  upperRoot, lowerRoot, storageDir, envPath, btDir, sensorAddress, extraFiles = [],
}) => {
  const ops = [];
  const keep = new Set(PERSIST_KEYS.map(md5));

  // Lookout storage: sensor items mirrored, everything else removed from the card
  PERSIST_KEYS.forEach((k) => mirrorFile(ops, upperRoot, lowerRoot, path.join(storageDir, md5(k))));
  listDir(at(lowerRoot, storageDir)).filter((e) => e.isFile() && !keep.has(e.name))
    .forEach((e) => ops.push({ op: 'delete', path: path.join(storageDir, e.name) }));

  mirrorFile(ops, upperRoot, lowerRoot, envPath);
  extraFiles.forEach((f) => mirrorFile(ops, upperRoot, lowerRoot, f)); // e.g. /etc/g7-central

  // BlueZ: the current sensor's bond mirrored; other DXCM bonds removed from the card
  const addr = sensorAddress && MAC_RE.test(sensorAddress) ? sensorAddress.toUpperCase() : null;
  const adapters = new Set([...listDir(at(upperRoot, btDir)), ...listDir(at(lowerRoot, btDir))]
    .filter((e) => e.isDirectory() && MAC_RE.test(e.name)).map((e) => e.name));
  adapters.forEach((adapter) => {
    if (addr) {
      const rel = path.join(btDir, adapter, addr);
      const files = new Set([...filesUnder(at(upperRoot, rel)), ...filesUnder(at(lowerRoot, rel))]);
      [...files].sort().forEach((f) => mirrorFile(ops, upperRoot, lowerRoot, path.join(rel, f)));
      if (!fs.existsSync(at(upperRoot, rel)) && fs.existsSync(at(lowerRoot, rel))) {
        ops.push({ op: 'rmdir', path: rel });
      }
    }
    listDir(at(lowerRoot, path.join(btDir, adapter)))
      .filter((e) => e.isDirectory() && MAC_RE.test(e.name) && e.name.toUpperCase() !== addr)
      .forEach((e) => {
        const info = readOrNull(at(lowerRoot, path.join(btDir, adapter, e.name, 'info')));
        if (info && /^Name=DXCM/m.test(info.toString())) {
          ops.push({ op: 'rmdir', path: path.join(btDir, adapter, e.name) });
        }
      });
  });

  // a file under a directory that is removed anyway needs no separate step
  const dirs = ops.filter((o) => o.op === 'rmdir').map((o) => o.path + path.sep);
  return ops.filter((o) => o.op === 'rmdir' || !dirs.some((d) => o.path.startsWith(d)));
};

// Apply a plan to the card (which the caller has made writable).
const applySync = (ops, { lowerRoot, upperRoot = '/' }) => {
  const touched = new Set();
  // Read every source first: reading through the overlay after the card
  // underneath has changed is undefined (overlayfs).
  const staged = new Map(ops.filter((o) => o.op === 'write').map((o) => {
    const src = at(upperRoot, o.path);
    return [o.path, { data: fs.readFileSync(src), st: fs.statSync(src) }];
  }));
  ops.forEach((o) => {
    const dst = at(lowerRoot, o.path);
    if (o.op === 'write') {
      const { data, st } = staged.get(o.path);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      writeAtomic(dst, data);
      fs.chmodSync(dst, st.mode & 0o7777); // eslint-disable-line no-bitwise
      try {
        fs.chownSync(dst, st.uid, st.gid);
      } catch (e) {
        // not root (tests): ownership stays as it is
      }
    } else if (o.op === 'delete') {
      fs.rmSync(dst, { force: true });
    } else if (o.op === 'rmdir') {
      fs.rmSync(dst, { recursive: true, force: true });
    }
    touched.add(path.dirname(dst));
  });
  touched.forEach(fsyncDir);
  return ops.length;
};

module.exports = { PERSIST_KEYS, planSync, applySync };
