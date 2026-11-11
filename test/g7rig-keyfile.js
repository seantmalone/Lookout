/* global describe it */

const should = require('should');

const keyfile = require('../lib/g7rig/keyfile');

const KEY = '00112233445566778899aabbccddeeff';
const ENV = 'LOOKOUT_ARGS=--display_type watch --sensor_address 01:23:45:67:89:AB\n';

const record = () => ({
  code: '1234', name: 'DXCMab', address: 'AA:BB:CC:DD:EE:FF', key: KEY,
});

describe('g7-rig keyfile.exportRecord', () => {
  it('exports code, name, address and key from storage', () => {
    keyfile.exportRecord({
      storage: { id: '1234', sensorName: 'DXCMab', sensorKey: { key: KEY, address: 'AA:BB:CC:DD:EE:FF' } },
      envText: ENV,
    }).should.eql(record());
  });

  it('falls back to the pinned env address', () => {
    keyfile.exportRecord({
      storage: { id: '1234', sensorName: 'DXCMab', sensorKey: { key: KEY } },
      envText: ENV,
    }).address.should.equal('01:23:45:67:89:AB');
  });

  it('refuses when there is no key', () => {
    should.throws(() => keyfile.exportRecord({ storage: { id: '1234' }, envText: ENV }), /no key/);
    should.throws(() => keyfile.exportRecord({ storage: { sensorKey: { key: '' } }, envText: ENV }), /no key/);
  });

  it('round-trips through validateImport', () => {
    const exported = keyfile.exportRecord({
      storage: { id: '1234', sensorName: 'DXCMab', sensorKey: { key: KEY, address: 'AA:BB:CC:DD:EE:FF' } },
      envText: ENV,
    });
    keyfile.validateImport(JSON.parse(JSON.stringify(exported))).should.eql(record());
  });
});

describe('g7-rig keyfile.validateImport', () => {
  it('accepts a good record', () => {
    keyfile.validateImport(record()).should.eql(record());
  });

  it('accepts an upper-case key and lower-case address', () => {
    keyfile.validateImport({ ...record(), key: KEY.toUpperCase(), address: 'aa:bb:cc:dd:ee:ff' })
      .should.eql({ ...record(), key: KEY.toUpperCase(), address: 'aa:bb:cc:dd:ee:ff' });
  });

  it('keeps only the four fields', () => {
    keyfile.validateImport({ ...record(), extra: 'x' }).should.eql(record());
  });

  const bad = {
    code: ['123', '12345', 'abcd', 1234, '', null, '1234\n'],
    name: ['DXCM', 'DXCMabc', 'dxcmab', 'DXCMa!', '', null, 'DXCMab\n'],
    address: ['01:23:45:67:89', 'GG:23:45:67:89:AB', '01-23-45-67-89-AB', '', null, 'AA:BB:CC:DD:EE:FF\n'],
    key: [KEY.slice(1), `${KEY}0`, `${KEY.slice(2)}zz`, '', null, `${KEY}\n`],
  };

  Object.keys(bad).forEach((field) => {
    bad[field].forEach((value) => {
      it(`rejects ${field} = ${JSON.stringify(value)}`, () => {
        should.throws(
          () => keyfile.validateImport({ ...record(), [field]: value }),
          new RegExp(field),
        );
      });
    });
  });

  it('rejects non-objects', () => {
    [null, undefined, 'x', 3, []].forEach((v) => {
      should.throws(() => keyfile.validateImport(v));
    });
  });

  it('does not put the key in error messages', () => {
    try {
      keyfile.validateImport({ ...record(), code: 'bad' });
    } catch (e) {
      e.message.should.not.containEql(KEY);
    }
  });
});

// The G7 ties its watch-slot key to the Bluetooth address of the central that
// paired; collectors sharing a key must also share that address ("central").
describe('g7-rig keyfile: the central Bluetooth address', () => {
  const storage = { id: '1234', sensorName: 'DXCMab', sensorKey: { key: KEY, address: 'AA:BB:CC:DD:EE:FF' } };

  it('exports the central address when known', () => {
    keyfile.exportRecord({ storage, envText: ENV, central: 'B8:27:EB:00:00:01' })
      .should.eql({ ...record(), central: 'B8:27:EB:00:00:01' });
  });

  it('round-trips the central address through validateImport', () => {
    const out = keyfile.exportRecord({ storage, envText: ENV, central: 'B8:27:EB:00:00:01' });
    keyfile.validateImport(JSON.parse(JSON.stringify(out))).central.should.equal('B8:27:EB:00:00:01');
  });

  it('accepts a record without one (older collectors)', () => {
    keyfile.validateImport(record()).should.eql(record());
  });

  it('rejects a malformed central address', () => {
    should.throws(() => keyfile.validateImport({ ...record(), central: 'nope' }), /bad central/);
  });
});
