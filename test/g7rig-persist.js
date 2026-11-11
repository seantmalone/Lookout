/* global describe it beforeEach afterEach */

const should = require('should');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { PERSIST_KEYS, planSync, applySync } = require('../lib/g7rig/persist');

// Read-only collectors: the SD card (the "lower" layer) is never written in
// normal running; everything goes to RAM (the overlay). `g7-rig persist`
// copies the few things that must survive a power cut onto the card.

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const STORAGE = '/home/pi/Lookout/storage';
const ENV = '/etc/lookout.env';
const BT = '/var/lib/bluetooth';
const ADAPTER = 'B8:27:EB:00:00:01';
const ADDR = 'AA:BB:CC:DD:EE:01';
const OLD = 'AA:BB:CC:DD:EE:99';

describe('g7-rig persist (read-only card)', () => {
  let tmp;
  let upper;
  let lower;

  const put = (root, p, content) => {
    const f = path.join(root, p);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
  };
  const item = (key, value) => JSON.stringify({ key, value });
  const read = (root, p) => (fs.existsSync(path.join(root, p))
    ? fs.readFileSync(path.join(root, p), 'utf8') : null);
  const plan = () => planSync({
    upperRoot: upper,
    lowerRoot: lower,
    storageDir: STORAGE,
    envPath: ENV,
    btDir: BT,
    sensorAddress: ADDR,
  });
  const sync = () => applySync(plan(), { lowerRoot: lower, upperRoot: upper });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-'));
    upper = path.join(tmp, 'upper');
    lower = path.join(tmp, 'lower');
    // the card as it was when read-only mode was switched on
    put(lower, `${STORAGE}/${md5('id')}`, item('id', '1234'));
    put(lower, `${STORAGE}/${md5('sensorKey')}`, item('sensorKey', { key: 'old' }));
    put(lower, `${STORAGE}/${md5('glucoseHist')}`, item('glucoseHist', [1, 2, 3]));
    put(lower, ENV, 'LOOKOUT_ARGS=--sensor_address AA:BB:CC:DD:EE:99\n');
    put(lower, `${BT}/${ADAPTER}/${OLD}/info`, '[General]\nName=DXCMzz\n[LongTermKey]\nKey=OLD\n');
    put(lower, `${BT}/${ADAPTER}/11:22:33:44:55:66/info`, '[General]\nName=Headphones\n');
    // the running system (RAM view): a new sensor was paired
    put(upper, `${STORAGE}/${md5('id')}`, item('id', '5678'));
    put(upper, `${STORAGE}/${md5('sensorKey')}`, item('sensorKey', { key: 'new' }));
    put(upper, `${STORAGE}/${md5('sensorName')}`, item('sensorName', 'DXCMab'));
    put(upper, `${STORAGE}/${md5('glucoseHist')}`, item('glucoseHist', [1, 2, 3, 4]));
    put(upper, ENV, 'LOOKOUT_ARGS=--sensor_address AA:BB:CC:DD:EE:01 --no_auto_pair\n');
    put(upper, `${BT}/${ADAPTER}/${ADDR}/info`, '[General]\nName=DXCMab\n[LongTermKey]\nKey=NEW\n');
    put(upper, `${BT}/${ADAPTER}/${ADDR}/attributes`, '[0x0001]\n');
    put(upper, `${BT}/${ADAPTER}/11:22:33:44:55:66/info`, '[General]\nName=Headphones\n');
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('persists exactly the sensor items, not the reading history', () => {
    PERSIST_KEYS.should.containDeep(['id', 'sensorKey', 'sensorName', 'pairRequest', 'keyRejected', 'pairedAt']);
    PERSIST_KEYS.should.not.containEql('glucoseHist');
  });

  it('copies changed sensor items and the env file to the card', () => {
    sync();
    read(lower, `${STORAGE}/${md5('id')}`).should.equal(item('id', '5678'));
    read(lower, `${STORAGE}/${md5('sensorKey')}`).should.equal(item('sensorKey', { key: 'new' }));
    read(lower, `${STORAGE}/${md5('sensorName')}`).should.equal(item('sensorName', 'DXCMab'));
    read(lower, ENV).should.containEql('--no_auto_pair');
  });

  it('removes scratch data from the card so every boot starts clean', () => {
    sync();
    should.not.exist(read(lower, `${STORAGE}/${md5('glucoseHist')}`));
  });

  it('removes an item from the card when it was removed in RAM', () => {
    put(lower, `${STORAGE}/${md5('pairRequest')}`, item('pairRequest', { code: '1234' }));
    sync();
    should.not.exist(read(lower, `${STORAGE}/${md5('pairRequest')}`));
  });

  it("mirrors the current sensor's Bluetooth bond and drops old sensors' bonds", () => {
    sync();
    read(lower, `${BT}/${ADAPTER}/${ADDR}/info`).should.containEql('Key=NEW');
    read(lower, `${BT}/${ADAPTER}/${ADDR}/attributes`).should.equal('[0x0001]\n');
    fs.existsSync(path.join(lower, BT, ADAPTER, OLD)).should.equal(false);
    // other devices are left alone
    read(lower, `${BT}/${ADAPTER}/11:22:33:44:55:66/info`).should.containEql('Headphones');
  });

  it('removes the bond from the card when it was removed in RAM', () => {
    put(lower, `${BT}/${ADAPTER}/${ADDR}/info`, '[General]\nName=DXCMab\n');
    fs.rmSync(path.join(upper, BT, ADAPTER, ADDR), { recursive: true });
    sync();
    fs.existsSync(path.join(lower, BT, ADAPTER, ADDR)).should.equal(false);
  });

  it('plans nothing once the card matches (no write at all)', () => {
    sync();
    plan().should.eql([]);
  });

  it('keeps file modes and never leaves temp files', () => {
    fs.chmodSync(path.join(upper, ENV), 0o600);
    sync();
    const mode = fs.statSync(path.join(lower, ENV)).mode & 0o777; // eslint-disable-line no-bitwise
    mode.should.equal(0o600);
    const all = [];
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
      if (e.isDirectory()) walk(path.join(d, e.name)); else all.push(e.name);
    });
    walk(lower);
    all.filter((n) => n.includes('.tmp')).should.eql([]);
  });
});
