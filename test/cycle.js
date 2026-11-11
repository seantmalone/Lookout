/* global describe it */

const should = require('should');

const { cycleTiming } = require('../cycle');

// Collection timing scales with the sensor's reading interval so the lab can
// run a fast simulator cycle; the default must stay exactly as before.
describe('cycle.cycleTiming', () => {
  it('keeps the standard 5-minute values by default', () => {
    const t = cycleTiming(undefined);
    t.cycleMs.should.equal(5 * 60000);
    t.workerTimeoutMs.should.equal(6.5 * 60000);
    t.rebootAfterMs.should.equal(11 * 60000);
    t.gapMs.should.equal(6 * 60000);
    t.gapMarginMs.should.equal(60000);
  });

  it('scales everything for a 60 s lab cycle', () => {
    const t = cycleTiming('60');
    t.cycleMs.should.equal(60000);
    t.workerTimeoutMs.should.equal(78000);
    t.rebootAfterMs.should.equal(132000);
    t.gapMs.should.equal(72000);
    t.gapMarginMs.should.equal(12000);
  });

  it('ignores nonsense and never goes below 30 s', () => {
    cycleTiming('abc').cycleMs.should.equal(5 * 60000);
    cycleTiming('5').cycleMs.should.equal(30000);
  });
});

should(true).be.ok();
