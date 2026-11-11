/* global describe it */

const should = require('should');

const { parseScan } = require('../lib/g7rig/scan');

const ESC = '\x1b';

describe('g7-rig scan.parseScan', () => {
  const devices = [
    'Device AA:BB:CC:DD:EE:FF DXCMab',
    'Device 11:22:33:44:55:66 DXCMcd',
    'Device 22:33:44:55:66:77 DXCMabX',
    `${ESC}[1;39mDevice 33:44:55:66:77:88 SomePhone${ESC}[0m`,
  ].join('\n');

  it('finds the named device heard in this scan, with its latest RSSI', () => {
    const scan = [
      'Discovery started',
      `${ESC}[0;93m[CHG]${ESC}[0m Controller 00:00:00:00:00:01 Discovering: yes`,
      `[${ESC}[0;92mNEW${ESC}[0m] Device AA:BB:CC:DD:EE:FF DXCMab`,
      '[CHG] Device AA:BB:CC:DD:EE:FF RSSI: 0xffffffb5 (-75)',
      '[CHG] Device 11:22:33:44:55:66 RSSI: -40',
      '\r[CHG] Device AA:BB:CC:DD:EE:FF RSSI: 0xffffffb9 (-71)\r',
    ].join('\n');
    parseScan(scan, devices, 'DXCMab').should.eql({ heard: true, rssi: -71, address: 'AA:BB:CC:DD:EE:FF' });
  });

  it('reads the plain RSSI form', () => {
    const scan = '[CHG] Device 11:22:33:44:55:66 RSSI: -40\n';
    parseScan(scan, devices, 'DXCMcd').should.eql({ heard: true, rssi: -40, address: '11:22:33:44:55:66' });
  });

  it('reports a device that was only [NEW] with a null RSSI', () => {
    parseScan('[NEW] Device AA:BB:CC:DD:EE:FF DXCMab\n', devices, 'DXCMab')
      .should.eql({ heard: true, rssi: null, address: 'AA:BB:CC:DD:EE:FF' });
  });

  it('ignores a known device that did not advertise during this scan', () => {
    parseScan('[CHG] Device 11:22:33:44:55:66 RSSI: -40\n', devices, 'DXCMab')
      .should.eql({ heard: false, rssi: null, address: null });
  });

  it('matches the name exactly (no prefix or case-insensitive match)', () => {
    const scan = '[CHG] Device 22:33:44:55:66:77 RSSI: -50\n';
    parseScan(scan, devices, 'DXCMab').heard.should.equal(false);
    parseScan(scan, devices, 'dxcmabx').heard.should.equal(false);
  });

  it('also uses names from [NEW] lines missing from the device list', () => {
    parseScan('[NEW] Device 44:55:66:77:88:99 DXCMef\n[CHG] Device 44:55:66:77:88:99 RSSI: -60\n', '', 'DXCMef')
      .should.eql({ heard: true, rssi: -60, address: '44:55:66:77:88:99' });
  });

  it('refuses when two devices with that name advertised', () => {
    const dup = `${devices}\nDevice 99:88:77:66:55:44 DXCMab`;
    const scan = '[CHG] Device AA:BB:CC:DD:EE:FF RSSI: -70\n[CHG] Device 99:88:77:66:55:44 RSSI: -60\n';
    should.throws(() => parseScan(scan, dup, 'DXCMab'), /two devices named DXCMab/);
  });

  it('copes with empty input', () => {
    parseScan('', '', 'DXCMab').should.eql({ heard: false, rssi: null, address: null });
  });
});
