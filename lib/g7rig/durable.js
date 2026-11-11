// Crash-safe writes for a node-persist store.
//
// Collectors get unplugged without warning. node-persist rewrites each item's
// file in place, so a power cut mid-write leaves a truncated file, which reads
// back as missing (with forgiveParseErrors) - e.g. the sensor key. Here each
// write goes to a temp file that is fsynced, renamed over the old file, and
// the directory fsynced: after a power cut an item holds either its old or
// its new value, never a fragment.
//
// Used by Lookout (index.js) and by g7-rig, which both open the same store.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TMP_SUFFIX = '.tmp-write';

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

const fsyncDir = (dir) => {
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch (e) {
    // not supported everywhere (e.g. some test filesystems): the rename is still atomic
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
};

const writeAtomic = (file, data) => {
  const tmp = `${file}${TMP_SUFFIX}`;
  const fd = fs.openSync(tmp, 'w', 0o664);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* already gone */ }
    throw e;
  }
  fsyncDir(path.dirname(file));
};

const removeStaleTemps = (dir) => {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return;
  }
  names.filter((n) => n.endsWith(TMP_SUFFIX)).forEach((n) => {
    try { fs.unlinkSync(path.join(dir, n)); } catch (e) { /* ignore */ }
  });
};

const makeDurable = (store) => {
  // node-persist's module-level API (require('node-persist').init(...), as
  // Lookout uses it) keeps the real store in .defaultInstance
  const s = store.defaultInstance || store;
  removeStaleTemps(s.options.dir);

  const output = (key) => ({
    key,
    value: s.data[key] && s.data[key].value,
    ttl: s.data[key] && s.data[key].ttl,
  });

  s.persistKeySync = function persistKeySync(key) {
    const file = path.join(s.options.dir, md5(key));
    try {
      writeAtomic(file, s.stringify(output(key)));
      if (s.changes[key] && s.changes[key].onSuccess) s.changes[key].onSuccess();
    } catch (err) {
      if (s.changes[key] && s.changes[key].onError) s.changes[key].onError(err);
      throw err;
    }
    delete s.changes[key];
  };

  s.persistKey = function persistKey(key, callback) {
    const cb = typeof callback === 'function' ? callback : () => {};
    const out = output(key);
    return new Promise((resolve, reject) => {
      try {
        s.persistKeySync(key);
      } catch (err) {
        cb(err);
        reject(err);
        return;
      }
      cb(null, out);
      resolve(out);
    });
  };
  return store;
};

module.exports = {
  makeDurable, writeAtomic, fsyncDir, TMP_SUFFIX,
};
