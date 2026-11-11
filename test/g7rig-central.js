/* global describe it */

require('should');

const central = require('../lib/g7rig/central');

describe('g7-rig central address file', () => {
  it('reads the address, ignoring comments and blank lines', () => {
    central.parse('# the address the sensor knows\n\nb8:27:eb:00:00:01\n').should.equal('B8:27:EB:00:00:01');
  });

  it('is null when missing or malformed', () => {
    (central.parse('') === null).should.be.true();
    (central.parse('# only a comment\n') === null).should.be.true();
    (central.parse('not-an-address\n') === null).should.be.true();
  });

  it('formats a file that parses back', () => {
    central.parse(central.format('b8:27:eb:00:00:01')).should.equal('B8:27:EB:00:00:01');
  });

  it('reads the adapter address from bluetoothctl show', () => {
    central.adapterAddress('Controller B8:27:EB:3F:E8:DD (public)\n\tName: x\n').should.equal('B8:27:EB:3F:E8:DD');
    (central.adapterAddress('No default controller available\n') === null).should.be.true();
  });
});
