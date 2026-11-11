/* global describe it */

require('should');

const { duplicateQuery, isDuplicate, uploadUnlessPresent } = require('../nsDedupe');

const T = 1789000000000;

// Several fleet collectors may read the same G7 reading; each estimates its time
// from its own connection, so the copies differ by a second or so and
// Nightscout (which merges only identical timestamps) would keep both.
describe('nsDedupe', () => {
  it('asks Nightscout for sgv entries within 2.5 minutes of the reading', () => {
    duplicateQuery(T).should.equal(
      `find%5Btype%5D=sgv&find%5Bdate%5D%5B%24gte%5D=${T - 150000}&find%5Bdate%5D%5B%24lte%5D=${T + 150000}&count=1`,
    );
  });

  it('treats any sgv entry in the window as the same reading', () => {
    isDuplicate([{ type: 'sgv', date: T + 1200 }], T).should.equal(true);
    isDuplicate([{ type: 'sgv', date: T - 149000 }], T).should.equal(true);
  });

  it('ignores entries outside the window, other types and junk', () => {
    isDuplicate([{ type: 'sgv', date: T + 300000 }], T).should.equal(false);
    isDuplicate([{ type: 'mbg', date: T }], T).should.equal(false);
    isDuplicate(null, T).should.equal(false);
    isDuplicate('oops', T).should.equal(false);
  });

  it('uploads when Nightscout has no copy', async () => {
    const posted = [];
    const r = await uploadUnlessPresent({
      dateMs: T, get: async () => [], post: (e) => posted.push(e), entry: ['x'],
    });
    r.should.equal('uploaded');
    posted.should.eql([['x']]);
  });

  it('skips the upload when another collector already sent this reading', async () => {
    const posted = [];
    const r = await uploadUnlessPresent({
      dateMs: T, get: async () => [{ type: 'sgv', date: T + 900 }], post: (e) => posted.push(e), entry: ['x'],
    });
    r.should.equal('duplicate');
    posted.should.eql([]);
  });

  it('uploads anyway when the check fails (never lose a reading)', async () => {
    const posted = [];
    const r = await uploadUnlessPresent({
      dateMs: T, get: async () => { throw new Error('timeout'); }, post: (e) => posted.push(e), entry: ['x'],
    });
    r.should.equal('uploaded');
    posted.length.should.equal(1);
  });
});
