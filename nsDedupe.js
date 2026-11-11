// Fleet collectors may read the same G7 reading. Each one estimates the
// reading's time from its own connection, so the copies differ by a second or
// so, and Nightscout (which merges only identical timestamps) would keep both.
// In fleet mode, check for an sgv entry close to this one before uploading.
// G7 readings are 5 minutes apart, so anything within 2.5 minutes is the same
// reading. If the check fails, upload anyway: never lose a reading.

const HALF_WINDOW_MS = 150 * 1000;

const duplicateQuery = (dateMs, halfWindowMs = HALF_WINDOW_MS) => [
  'find%5Btype%5D=sgv',
  `find%5Bdate%5D%5B%24gte%5D=${dateMs - halfWindowMs}`,
  `find%5Bdate%5D%5B%24lte%5D=${dateMs + halfWindowMs}`,
  'count=1',
].join('&');

const isDuplicate = (entries, dateMs, halfWindowMs = HALF_WINDOW_MS) => Array.isArray(entries)
  && entries.some((e) => e && e.type === 'sgv' && typeof e.date === 'number'
    && Math.abs(e.date - dateMs) <= halfWindowMs);

const uploadUnlessPresent = async ({
  dateMs, get, post, entry,
}) => {
  let existing = null;
  try {
    existing = await get(duplicateQuery(dateMs));
  } catch (e) {
    existing = null;
  }
  if (isDuplicate(existing, dateMs)) return 'duplicate';
  post(entry);
  return 'uploaded';
};

module.exports = {
  duplicateQuery, isDuplicate, uploadUnlessPresent, HALF_WINDOW_MS,
};
