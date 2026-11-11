/* global describe it beforeEach afterEach */

require('should');
const fs = require('fs');
const os = require('os');
const path = require('path');
const persist = require('node-persist');

const { makeDurable, TMP_SUFFIX } = require('../lib/g7rig/durable');

// Collectors get unplugged without warning. node-persist rewrites each item in
// place, so a power cut mid-write leaves a truncated file (read back as
// missing: e.g. the sensor key). makeDurable writes a temp file, fsyncs it,
// renames it over the old one and fsyncs the directory.
describe('durable node-persist writes', () => {
  let dir;
  let store;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-'));
    store = persist.create({ dir: path.join(dir, 'storage'), forgiveParseErrors: true });
    await store.init();
    makeDurable(store);
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('stores and reads back items', async () => {
    await store.setItem('sensorKey', { key: 'k', address: 'a' });
    const again = persist.create({ dir: path.join(dir, 'storage'), forgiveParseErrors: true });
    await again.init();
    (await again.getItem('sensorKey')).should.eql({ key: 'k', address: 'a' });
  });

  it('leaves no temp files in the storage directory', async () => {
    await store.setItem('a', 1);
    store.setItemSync('b', 2);
    fs.readdirSync(path.join(dir, 'storage')).filter((f) => f.endsWith(TMP_SUFFIX)).should.eql([]);
  });

  it('keeps the old value intact if the write is interrupted before the rename', async () => {
    await store.setItem('sensorKey', 'old');
    const file = fs.readdirSync(path.join(dir, 'storage'))[0];
    const realRename = fs.renameSync;
    fs.renameSync = () => { throw new Error('power cut'); };
    try {
      await store.setItem('sensorKey', 'new').catch(() => {});
    } finally {
      fs.renameSync = realRename;
    }
    JSON.parse(fs.readFileSync(path.join(dir, 'storage', file), 'utf8')).value.should.equal('old');
  });

  it('cleans up temp files left by an earlier power cut', async () => {
    fs.writeFileSync(path.join(dir, 'storage', `abc${TMP_SUFFIX}`), '{"key":"x","val');
    makeDurable(store);
    fs.readdirSync(path.join(dir, 'storage')).filter((f) => f.endsWith(TMP_SUFFIX)).should.eql([]);
  });
});

describe('durable writes through the module-level node-persist API (as Lookout uses it)', () => {
  it('patches the default instance', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-mod-'));
    const fresh = path.join(dir, 'storage');
    // a separate copy of the module, so the shared default instance is untouched
    delete require.cache[require.resolve('node-persist')];
    const mod = require('node-persist'); // eslint-disable-line global-require
    await mod.init({ dir: fresh, forgiveParseErrors: true });
    makeDurable(mod).should.be.ok();
    const realRename = fs.renameSync;
    let renames = 0;
    fs.renameSync = (...a) => { renames += 1; return realRename(...a); };
    try {
      await mod.setItem('sensorKey', { key: 'k' });
    } finally {
      fs.renameSync = realRename;
    }
    renames.should.equal(1); // written via temp file + rename
    fs.readdirSync(fresh).filter((f) => f.endsWith(TMP_SUFFIX)).should.eql([]);
    JSON.parse(fs.readFileSync(path.join(fresh, fs.readdirSync(fresh)[0]), 'utf8')).value.should.eql({ key: 'k' });
    fs.rmSync(dir, { recursive: true, force: true });
    delete require.cache[require.resolve('node-persist')];
  });
});
