/* global describe it */

const crypto = require('crypto');
const should = require('should');

const status = require('../lib/g7rig/status');

const KEY = '00112233445566778899aabbccddeeff';
const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const MIN = 60 * 1000;
const ENV = 'LOOKOUT_ARGS=--display_type watch --sensor_address 01:23:45:67:89:AB\n';

const fullStorage = () => ({
  id: '1234',
  sensorName: 'DXCMab',
  sensorKey: { key: KEY, address: 'AA:BB:CC:DD:EE:FF' },
  sensorStart: { date: Date.parse('2026-11-05T08:00:00.000Z'), notes: '' },
  glucoseHist: [
    { readDateMills: NOW - 10 * MIN, glucose: 120, trend: 5 },
    {
      readDateMills: NOW - 5 * MIN, glucose: 125, trend: 10, sessionStartDate: '2026-11-05T07:55:00.000Z',
    },
  ],
  sensorSeen: { time: NOW - 30 * 1000, rssi: -71, address: 'AA:BB:CC:DD:EE:FF' },
});

const base = (storage, extra = {}) => status.build({
  storage,
  envText: ENV,
  lookoutActive: true,
  btPowered: true,
  now: NOW,
  host: 'rig-test',
  uptimeS: 3600.7,
  version: '2.0.8',
  errors: [],
  ...extra,
});

// Walk every key and value; the sensor key must appear nowhere.
const assertNoKey = (obj, key) => {
  const walk = (v, path) => {
    if (v && typeof v === 'object') {
      Object.keys(v).forEach((k) => {
        should(k).not.equal('key', `field named "key" at ${path}`);
        walk(v[k], `${path}.${k}`);
      });
    } else if (typeof v === 'string') {
      should(v.toLowerCase().includes(key.toLowerCase())).equal(false, `key leaked at ${path}`);
    }
  };
  walk(obj, '$');
  JSON.stringify(obj).toLowerCase().should.not.containEql(key.toLowerCase());
};

describe('g7-rig status.fingerprint', () => {
  it('is the first 12 hex characters of the SHA-256 of the key hex string', () => {
    const expected = crypto.createHash('sha256').update(KEY).digest('hex').slice(0, 12);
    status.fingerprint(KEY).should.equal(expected);
    status.fingerprint(KEY).should.match(/^[0-9a-f]{12}$/);
  });
});

describe('g7-rig status.build', () => {
  it('returns exactly the status shape', () => {
    const s = base(fullStorage());
    s.should.eql({
      host: 'rig-test',
      version: '2.0.8',
      uptime_s: 3600,
      lookout_active: true,
      bluetooth_powered: true,
      sensor: {
        code: '1234',
        name: 'DXCMab',
        address: 'AA:BB:CC:DD:EE:FF',
        key_fingerprint: status.fingerprint(KEY),
        session_start: '2026-11-05T07:55:00.000Z',
        session_length_s: null,
        paired_at: null,
      },
      last_reading: { time: '2026-11-10T11:55:00.000Z', glucose: 125, trend: 10 },
      last_heard: { time: '2026-11-10T11:59:30.000Z', rssi: -71 },
      pairing: { state: 'paired', since: null, error: null },
      errors: [],
    });
  });

  it('never includes the key, anywhere', () => {
    const storage = fullStorage();
    assertNoKey(base(storage), KEY);
    storage.pairRequest = { code: '1234', name: 'DXCMab', at: NOW - MIN };
    assertNoKey(base(storage), KEY);
    storage.keyRejected = { at: NOW };
    assertNoKey(base(storage), KEY);
    // even if a key-like string sneaks into other stored items
    storage.sensorName = KEY;
    should.throws(() => assertNoKey(base(storage), KEY));
  });

  it('passes the G7 trend through unchanged', () => {
    const storage = fullStorage();
    storage.glucoseHist[1].trend = -23;
    base(storage).last_reading.trend.should.equal(-23);
  });

  it('falls back to the stored sensorStart, then null, for session_start', () => {
    const storage = fullStorage();
    delete storage.glucoseHist[1].sessionStartDate;
    base(storage).sensor.session_start.should.equal('2026-11-05T08:00:00.000Z');
    delete storage.sensorStart;
    should(base(storage).sensor.session_start).be.null();
  });

  it('reports session_length_s only when stored', () => {
    const storage = fullStorage();
    storage.sessionLengthSeconds = 907200;
    base(storage).sensor.session_length_s.should.equal(907200);
  });

  it('uses the pinned env address when the key has none', () => {
    const storage = fullStorage();
    storage.sensorKey = { key: KEY, address: '' };
    base(storage).sensor.address.should.equal('01:23:45:67:89:AB');
  });

  it('copes with an empty storage', () => {
    const s = base({});
    s.sensor.should.eql({
      code: null,
      name: null,
      address: '01:23:45:67:89:AB',
      key_fingerprint: null,
      session_start: null,
      session_length_s: null,
      paired_at: null,
    });
    should(s.last_reading).be.null();
    should(s.last_heard).be.null();
    s.pairing.should.eql({ state: 'idle', since: null, error: null });
    s.errors.should.eql([]);
  });

  it('treats an empty key as no key', () => {
    const s = base({ sensorKey: { key: '', address: 'AA:BB:CC:DD:EE:FF' } });
    should(s.sensor.key_fingerprint).be.null();
    s.pairing.state.should.equal('idle');
  });

  it('redacts the key from error lines', () => {
    const s = base(fullStorage(), { errors: [`Error: bad key ${KEY.toUpperCase()}!`] });
    s.errors.should.eql(['Error: bad key [redacted]!']);
    assertNoKey(s, KEY);
  });

  it('passes errors through', () => {
    base({}, { errors: ['Error: x', 'Mismatch y'] }).errors.should.eql(['Error: x', 'Mismatch y']);
  });

  describe('pairing state', () => {
    const at = NOW - 5 * MIN;
    const request = { code: '1234', name: 'DXCMab', at };

    it('is waiting with a recent request and no key', () => {
      base({ pairRequest: request }).pairing.should.eql({
        state: 'waiting', since: new Date(at).toISOString(), error: null,
      });
    });

    it('fails with "not heard" when the request is older than 15 minutes', () => {
      const old = { ...request, at: NOW - 16 * MIN };
      base({ pairRequest: old, sensorKey: null }).pairing.should.eql({
        state: 'failed', since: new Date(old.at).toISOString(), error: 'not heard',
      });
    });

    it('is paired when a key is present, with or without a request', () => {
      base({ pairRequest: request, sensorKey: { key: KEY, address: 'AA:BB:CC:DD:EE:FF' } })
        .pairing.should.eql({ state: 'paired', since: new Date(at).toISOString(), error: null });
      base({ sensorKey: { key: KEY, address: 'AA:BB:CC:DD:EE:FF' } })
        .pairing.should.eql({ state: 'paired', since: null, error: null });
    });

    it('fails with "rejected: check the code" when the key was rejected', () => {
      const rejectedAt = NOW - MIN;
      const expected = {
        state: 'failed', since: new Date(rejectedAt).toISOString(), error: 'rejected: check the code',
      };
      base({ pairRequest: request, keyRejected: { at: rejectedAt } }).pairing.should.eql(expected);
      base({ keyRejected: { at: rejectedAt } }).pairing.should.eql(expected);
      base({ keyRejected: { at: rejectedAt }, sensorKey: { key: KEY, address: 'AA:BB:CC:DD:EE:FF' } })
        .pairing.should.eql(expected);
    });

    it('is idle with no key and no request', () => {
      base({ id: '1234' }).pairing.should.eql({ state: 'idle', since: null, error: null });
    });
  });
});

describe('g7-rig status.recentErrors', () => {
  it('keeps the last 5 distinct matching lines, oldest first', () => {
    const journal = [
      'got glucose 120',
      'Error: one',
      'status 0a0300 from sensor',
      'Error: one',
      'Mismatch in challenge',
      'uploaded SGV',
      '3 failed reads',
      'Error: two',
      'Error: three',
      'Error: two',
    ].join('\n');
    status.recentErrors(journal).should.eql([
      'Error: one',
      'Mismatch in challenge',
      '3 failed reads',
      'Error: three',
      'Error: two',
    ]);
  });

  it('redacts anything that looks like a 16-byte key', () => {
    status.recentErrors(`Error: key ${KEY} refused`).should.eql(['Error: key [redacted] refused']);
  });

  it('returns [] for no input', () => {
    status.recentErrors('').should.eql([]);
    status.recentErrors(null).should.eql([]);
  });
});

describe('g7-rig status: when the key was paired', () => {
  it('reports sensor.paired_at from storage pairedAt', () => {
    const s = base({ ...fullStorage(), pairedAt: Date.UTC(2026, 10, 11, 12, 0, 0) });
    s.sensor.paired_at.should.equal('2026-11-11T12:00:00.000Z');
  });

  it('is null when unknown', () => {
    should(base(fullStorage()).sensor.paired_at).be.null();
  });
});
