// The key record moved between collectors by `g7-rig export-key` and
// `g7-rig import-key`: { code, name, address, key }. Only node built-ins
// here: this file is installed to /usr/local/lib/g7rig.

const { readArgs, ADDRESS_RE } = require('./env');
const { NAME_RE, CODE_RE } = require('./validate');

const KEY_RE = /^[0-9a-f]{32}$/i;

const exportRecord = ({ storage, envText }) => {
  const s = storage || {};
  const sensorKey = s.sensorKey || null;
  if (!sensorKey || typeof sensorKey.key !== 'string' || !sensorKey.key) {
    throw new Error('no key stored');
  }
  return {
    code: s.id || null,
    name: s.sensorName || null,
    address: sensorKey.address || readArgs(envText).sensorAddress || null,
    key: sensorKey.key,
  };
};

// Error messages name the field, never the value (it may be the key).
const validateImport = (obj) => {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('bad record');
  const check = (field, re) => {
    if (typeof obj[field] !== 'string' || !re.test(obj[field])) throw new Error(`bad ${field}`);
  };
  check('code', CODE_RE);
  check('name', NAME_RE);
  check('address', ADDRESS_RE);
  check('key', KEY_RE);
  return {
    code: obj.code, name: obj.name, address: obj.address, key: obj.key,
  };
};

module.exports = { exportRecord, validateImport };
