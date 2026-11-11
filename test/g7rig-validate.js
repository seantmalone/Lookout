/* global describe it */

const should = require('should');

const { parseRemote } = require('../lib/g7rig/validate');

describe('g7-rig validate.parseRemote', () => {
  it('accepts status, export-key and import-key with no arguments', () => {
    parseRemote('status').should.eql({ cmd: 'status', args: [] });
    parseRemote('export-key').should.eql({ cmd: 'export-key', args: [] });
    parseRemote('import-key').should.eql({ cmd: 'import-key', args: [] });
  });

  it('accepts scan with an exact sensor name', () => {
    parseRemote('scan DXCMab').should.eql({ cmd: 'scan', args: ['DXCMab'] });
    parseRemote('scan DXCM1Z').should.eql({ cmd: 'scan', args: ['DXCM1Z'] });
  });

  it('accepts pair with a 4-digit code and a sensor name', () => {
    parseRemote('pair 1234 DXCMab').should.eql({ cmd: 'pair', args: ['1234', 'DXCMab'] });
  });

  const rejected = [
    '',
    ' ',
    'status ',
    ' status',
    'status\n',
    'status\nid',
    'status; rm -rf /',
    'status && id',
    'status extra',
    'export-key now',
    'import-key x',
    'scan',
    'scan DXCM',
    'scan DXCMa',
    'scan DXCMa!',
    'scan DXCMabc',
    'scan DXCMab && id',
    'scan DXCMab extra',
    'scan dxcmab',
    'scan  DXCMab',
    'scan DXCMé1',
    'pair 12345 DXCMab',
    'pair 123 DXCMab',
    'pair 12a4 DXCMab',
    'pair 1234',
    'pair 1234 DXCMab extra',
    'pair 1234 DXCMab;id',
    '$(id)',
    '`id`',
    'cat /etc/shadow',
    'STATUS',
  ];

  rejected.forEach((cmdline) => {
    it(`rejects ${JSON.stringify(cmdline)}`, () => {
      should.throws(() => parseRemote(cmdline), /^Error: rejected$/);
    });
  });

  it('rejects non-strings', () => {
    should.throws(() => parseRemote(undefined), /rejected/);
    should.throws(() => parseRemote(null), /rejected/);
    should.throws(() => parseRemote(['status']), /rejected/);
  });
});
