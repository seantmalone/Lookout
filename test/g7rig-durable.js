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
