/* global describe it */

const should = require('should');

const { readArgs, setSensorAddress, ensureFlag } = require('../lib/g7rig/env');

const ENV = [
  '# comment mentioning --force_medical_slot and --sensor_address 11:11:11:11:11:11',
  'NIGHTSCOUT_HOST=https://ns.example.com',
  'API_SECRET=not-a-real-secret',
  'LOOKOUT_ARGS=--openaps /home/pi/myopenaps --display_type watch --sensor_address AA:BB:CC:DD:EE:FF --no_xdripaps',
  '',
].join('\n');

const ENV_NO_ADDR = [
  'NIGHTSCOUT_HOST=https://ns.example.com',
  'LOOKOUT_ARGS=--display_type watch --no_xdripaps',
  'API_SECRET=not-a-real-secret',
].join('\n');

describe('g7-rig env.readArgs', () => {
  it('finds LOOKOUT_ARGS and the pinned address', () => {
    const r = readArgs(ENV);
    r.args.should.equal('--openaps /home/pi/myopenaps --display_type watch --sensor_address AA:BB:CC:DD:EE:FF --no_xdripaps');
    r.sensorAddress.should.equal('AA:BB:CC:DD:EE:FF');
    r.medical.should.equal(false);
  });

  it('returns a null address when none is pinned', () => {
    should(readArgs(ENV_NO_ADDR).sensorAddress).be.null();
  });

  it('copes with no LOOKOUT_ARGS line or empty text', () => {
    readArgs('').should.eql({ args: '', sensorAddress: null, medical: false });
    readArgs('API_SECRET=x\n').should.eql({ args: '', sensorAddress: null, medical: false });
  });

  it('ignores flags that only appear in comments', () => {
    readArgs('# LOOKOUT_ARGS=--force_medical_slot\nLOOKOUT_ARGS=--display_type watch\n').medical.should.equal(false);
  });

  it('flags --force_medical_slot', () => {
    readArgs('LOOKOUT_ARGS=--display_type watch --force_medical_slot\n').medical.should.equal(true);
  });

  it('flags --alternate', () => {
    readArgs('LOOKOUT_ARGS=--alternate --display_type watch\n').medical.should.equal(true);
  });

  it('flags the -c alias of --alternate, alone or in a short-flag cluster', () => {
    readArgs('LOOKOUT_ARGS=-c --display_type watch\n').medical.should.equal(true);
    readArgs('LOOKOUT_ARGS=-vc --display_type watch\n').medical.should.equal(true);
    readArgs('LOOKOUT_ARGS=-v --display_type watch\n').medical.should.equal(false);
  });

  it('flags the kebab-case spellings', () => {
    readArgs('LOOKOUT_ARGS=--force-medical-slot\n').medical.should.equal(true);
  });

  it('does not flag --no_xdripaps or paths that merely contain the words', () => {
    readArgs('LOOKOUT_ARGS=--openaps /home/pi/alternate --no_xdripaps\n').medical.should.equal(false);
  });

  it('flags medical options written with =value or in quotes', () => {
    readArgs('LOOKOUT_ARGS=--force_medical_slot=true\n').medical.should.equal(true);
    readArgs('LOOKOUT_ARGS="--alternate --display_type watch"\n').medical.should.equal(true);
  });
});

describe('g7-rig env.ensureFlag', () => {
  it('appends a missing flag to LOOKOUT_ARGS only', () => {
    const out = ensureFlag(ENV, '--no_auto_pair');
    out.should.equal(ENV.replace(
      'LOOKOUT_ARGS=--openaps /home/pi/myopenaps --display_type watch --sensor_address AA:BB:CC:DD:EE:FF --no_xdripaps',
      'LOOKOUT_ARGS=--openaps /home/pi/myopenaps --display_type watch --sensor_address AA:BB:CC:DD:EE:FF --no_xdripaps --no_auto_pair',
    ));
  });

  it('leaves the text unchanged when the flag is there', () => {
    const once = ensureFlag(ENV, '--no_auto_pair');
    ensureFlag(once, '--no_auto_pair').should.equal(once);
  });

  it('adds a LOOKOUT_ARGS line when there is none', () => {
    ensureFlag('A=1\n', '--no_auto_pair').should.equal('A=1\nLOOKOUT_ARGS=--no_auto_pair\n');
  });

  it('keeps quotes around LOOKOUT_ARGS', () => {
    ensureFlag('LOOKOUT_ARGS="--display_type watch"\n', '--no_auto_pair')
      .should.equal('LOOKOUT_ARGS="--display_type watch --no_auto_pair"\n');
  });
});

describe('g7-rig env.setSensorAddress', () => {
  it('replaces the pinned address and leaves every other line and flag alone', () => {
    const out = setSensorAddress(ENV, '01:23:45:67:89:AB');
    out.should.equal(ENV.replace(
      'LOOKOUT_ARGS=--openaps /home/pi/myopenaps --display_type watch --sensor_address AA:BB:CC:DD:EE:FF --no_xdripaps',
      'LOOKOUT_ARGS=--openaps /home/pi/myopenaps --display_type watch --sensor_address 01:23:45:67:89:AB --no_xdripaps',
    ));
    readArgs(out).sensorAddress.should.equal('01:23:45:67:89:AB');
  });

  it('does not touch a --sensor_address in a comment', () => {
    setSensorAddress(ENV, '01:23:45:67:89:AB').should.containEql('# comment mentioning --force_medical_slot and --sensor_address 11:11:11:11:11:11');
  });

  it('appends the address when none is pinned', () => {
    const out = setSensorAddress(ENV_NO_ADDR, '01:23:45:67:89:ab');
    out.should.equal([
      'NIGHTSCOUT_HOST=https://ns.example.com',
      'LOOKOUT_ARGS=--display_type watch --no_xdripaps --sensor_address 01:23:45:67:89:ab',
      'API_SECRET=not-a-real-secret',
    ].join('\n'));
  });

  it('appends inside quotes when LOOKOUT_ARGS is quoted', () => {
    setSensorAddress('LOOKOUT_ARGS="--display_type watch"\n', '01:23:45:67:89:AB')
      .should.equal('LOOKOUT_ARGS="--display_type watch --sensor_address 01:23:45:67:89:AB"\n');
  });

  it('adds a LOOKOUT_ARGS line when there is none', () => {
    setSensorAddress('API_SECRET=x\n', '01:23:45:67:89:AB')
      .should.equal('API_SECRET=x\nLOOKOUT_ARGS=--sensor_address 01:23:45:67:89:AB\n');
  });

  it('rejects malformed addresses', () => {
    ['', '01:23:45:67:89', '01:23:45:67:89:AB:CD', '01-23-45-67-89-AB', 'GG:23:45:67:89:AB',
      '01:23:45:67:89:AB; id', '01:23:45:67:89:AB\nAPI_SECRET=x', null].forEach((addr) => {
      should.throws(() => setSensorAddress(ENV, addr), /address/);
    });
  });
});
