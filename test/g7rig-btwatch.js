/* global describe it */

require('should');
const btwatch = require('../lib/g7rig/btwatch');

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-11-15T12:00:00.000Z');

describe('g7-rig bt-watchdog decision (lib/g7rig/btwatch)', () => {
  const { decide } = btwatch;

  it('does nothing and forgets misses when the adapter is not discovering', () => {
    decide({
      discovering: false, adverts: 0, misses: 2, lastRestart: null, now: NOW,
    }).should.eql({ act: false, reason: 'not-discovering', state: { misses: 0, lastRestart: null } });
  });

  it('forgets misses as soon as anything is heard', () => {
    decide({
      discovering: true, adverts: 5, misses: 2, lastRestart: NOW - HOUR, now: NOW,
    }).should.eql({ act: false, reason: 'heard', state: { misses: 0, lastRestart: NOW - HOUR } });
  });

  it('counts empty samples while discovering, without acting before the third', () => {
    let state = { misses: 0, lastRestart: null };
    [1, 2].forEach((n) => {
      const d = decide({
        discovering: true, adverts: 0, ...state, now: NOW,
      });
      d.should.eql({ act: false, reason: 'miss', state: { misses: n, lastRestart: null } });
      state = d.state;
    });
  });

  it('acts on the third consecutive empty sample and records the restart', () => {
    decide({
      discovering: true, adverts: 0, misses: 2, lastRestart: null, now: NOW,
    }).should.eql({ act: true, reason: 'deaf', state: { misses: 0, lastRestart: NOW } });
  });

  it('restarts at most once an hour', () => {
    decide({
      discovering: true, adverts: 0, misses: 2, lastRestart: NOW - HOUR + 1000, now: NOW,
    }).should.eql({ act: false, reason: 'rate-limited', state: { misses: 3, lastRestart: NOW - HOUR + 1000 } });
    decide({
      discovering: true, adverts: 0, misses: 5, lastRestart: NOW - HOUR, now: NOW,
    }).should.eql({ act: true, reason: 'deaf', state: { misses: 0, lastRestart: NOW } });
  });

  it('is not stuck if the clock went backwards since the last restart', () => {
    decide({
      discovering: true, adverts: 0, misses: 2, lastRestart: NOW + HOUR, now: NOW,
    }).act.should.equal(true);
  });

  it('leaves the state alone when no sample could be taken (btmon missing or failed)', () => {
    decide({
      discovering: true, adverts: null, misses: 2, lastRestart: null, now: NOW,
    }).should.eql({ act: false, reason: 'no-sample', state: { misses: 2, lastRestart: null } });
  });

  it('treats missing or bad previous state as a clean start', () => {
    decide({ discovering: true, adverts: 0, now: NOW })
      .should.eql({ act: false, reason: 'miss', state: { misses: 1, lastRestart: null } });
    decide({
      discovering: true, adverts: 0, misses: 'x', lastRestart: 'y', now: NOW,
    }).should.eql({ act: false, reason: 'miss', state: { misses: 1, lastRestart: null } });
  });

  describe('parseState', () => {
    it('reads what the command wrote', () => {
      btwatch.parseState(JSON.stringify({ misses: 2, lastRestart: NOW }))
        .should.eql({ misses: 2, lastRestart: NOW });
    });
    it('falls back to a clean state', () => {
      [null, '', 'not json', '[]', '{"misses":-1,"lastRestart":"x"}'].forEach((t) => {
        btwatch.parseState(t).should.eql({ misses: 0, lastRestart: null });
      });
    });
  });

  describe('countAdverts (btmon output)', () => {
    it('counts legacy and extended advertising reports', () => {
      const text = [
        '> HCI Event: LE Meta Event (0x3e) plen 43            #1 [hci0] 12:00:00.000000',
        '      LE Advertising Report (0x02)',
        '        Num reports: 1',
        '> HCI Event: LE Meta Event (0x3e) plen 60            #2 [hci0] 12:00:00.100000',
        '      LE Extended Advertising Report (0x0d)',
        '> HCI Event: LE Meta Event (0x3e) plen 43            #3 [hci0] 12:00:00.200000',
        '      LE Advertising Report (0x02)',
        '< HCI Command: LE Set Scan Enable (0x08|0x000c) plen 2',
      ].join('\n');
      btwatch.countAdverts(text).should.equal(3);
    });
    it('is 0 for a monitor that heard nothing', () => {
      btwatch.countAdverts('Bluetooth monitor ver 5.82\n= Note: Linux version 6.12\n').should.equal(0);
      btwatch.countAdverts('').should.equal(0);
      btwatch.countAdverts(undefined).should.equal(0);
    });
  });

  describe('adapterState (bluetoothctl show)', () => {
    it('reads Powered and Discovering', () => {
      btwatch.adapterState('Controller B8:27:EB:00:00:01 (public)\n\tPowered: yes\n\tDiscovering: yes\n')
        .should.eql({ powered: true, discovering: true });
      btwatch.adapterState('Controller B8:27:EB:00:00:01 (public)\n\tPowered: yes\n\tDiscovering: no\n')
        .should.eql({ powered: true, discovering: false });
      btwatch.adapterState('').should.eql({ powered: false, discovering: false });
    });
  });
});
