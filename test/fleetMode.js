/* global describe it */

require('should');

const fleet = require('../fleetMode');

const KEY = { key: '00112233445566778899aabbccddeeff', address: 'AA:BB:CC:DD:EE:01' };

// In a fleet the collectors share one sensor key. A collector must only run a
// J-PAKE pairing when the UI asked it to (g7-rig pair); otherwise it would give
// the sensor's slot a new key and lock every other collector out.
describe('fleetMode.workerPlan', () => {
  it('waits without a key or a pair request', () => {
    fleet.workerPlan({ noAutoPair: true, sensorKey: null, pairRequest: null })
      .should.eql({ start: false, allowPairing: false, reason: 'waiting for a key' });
  });

  it('treats an empty stored key as no key', () => {
    fleet.workerPlan({ noAutoPair: true, sensorKey: { key: '', address: '' }, pairRequest: null })
      .start.should.equal(false);
  });

  it('pairs when the UI asked for it', () => {
    fleet.workerPlan({ noAutoPair: true, sensorKey: null, pairRequest: { code: '1234', name: 'DXCMab', at: 1 } })
      .should.eql({ start: true, allowPairing: true, reason: 'pairing requested' });
  });

  it('uses a saved key and never re-pairs', () => {
    fleet.workerPlan({ noAutoPair: true, sensorKey: KEY, pairRequest: null })
      .should.eql({ start: true, allowPairing: false, reason: 'saved key' });
  });

  it('keeps the standalone behaviour without --no_auto_pair', () => {
    fleet.workerPlan({ noAutoPair: false, sensorKey: null, pairRequest: null })
      .should.eql({ start: true, allowPairing: true, reason: 'automatic pairing' });
    fleet.workerPlan({ noAutoPair: false, sensorKey: KEY, pairRequest: null })
      .should.eql({ start: true, allowPairing: true, reason: 'automatic pairing' });
  });
});

describe('fleetMode.onSensorKey', () => {
  it('stores a new key and clears the request and any rejection', () => {
    fleet.onSensorKey({ data: KEY, noAutoPair: true }).should.eql({
      set: { sensorKey: KEY }, remove: ['pairRequest', 'keyRejected'],
    });
  });

  it('does not store an empty key in fleet mode (keeps the shared key)', () => {
    fleet.onSensorKey({ data: { key: '', address: '' }, noAutoPair: true }).should.eql({
      set: {}, remove: [],
    });
  });

  it('stores an empty key in standalone mode (today\'s behaviour)', () => {
    fleet.onSensorKey({ data: { key: '', address: '' }, noAutoPair: false }).should.eql({
      set: { sensorKey: { key: '', address: '' } }, remove: [],
    });
  });
});

describe('fleetMode.onSensorKey: when the key was paired', () => {
  it('records the pairing time when the key comes from a requested pairing', () => {
    fleet.onSensorKey({
      data: KEY, noAutoPair: true, pairRequest: { code: '1234', at: 1 }, now: 5000,
    }).should.eql({
      set: { sensorKey: KEY, pairedAt: 5000 }, remove: ['pairRequest', 'keyRejected'],
    });
  });

  it('does not touch the pairing time on an ordinary reconnect', () => {
    fleet.onSensorKey({
      data: KEY, noAutoPair: true, pairRequest: null, now: 5000,
    }).set.should.not.have.property('pairedAt');
  });
});

describe('fleetMode.onPairingBlocked', () => {
  it('records the rejection time', () => {
    fleet.onPairingBlocked({ now: 1000 })
      .should.eql({ set: { keyRejected: { at: 1000 } }, remove: [] });
  });
});

describe('fleetMode.shouldStoreSeen', () => {
  const seen = (time, address = 'AA:BB:CC:DD:EE:01') => ({ time, rssi: -70, address });

  it('stores the first sighting', () => { fleet.shouldStoreSeen(null, seen(0)).should.equal(true); });
  it('skips sightings within 60 s', () => { fleet.shouldStoreSeen(seen(0), seen(59999)).should.equal(false); });
  it('stores after 60 s', () => { fleet.shouldStoreSeen(seen(0), seen(60000)).should.equal(true); });
  it('stores at once when the address changes', () => {
    fleet.shouldStoreSeen(seen(0), seen(1, 'AA:BB:CC:DD:EE:02')).should.equal(true);
  });
});
