// Read and rewrite LOOKOUT_ARGS in /etc/lookout.env. Only node built-ins
// here: this file is installed to /usr/local/lib/g7rig.

const ADDRESS_RE = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/i;
const LINE_RE = /^LOOKOUT_ARGS=(.*)$/;
const ADDR_FLAG_RE = /(--sensor_address)(=|\s+)(\S+)/;

// Any spelling that could put Lookout on the pump's medical slot. Erring on
// the side of refusing: --alternate has the short alias -c (also inside a
// cluster such as -vc), and yargs accepts kebab-case.
const isMedicalToken = (t) => /^--(force[_-]medical[_-]slot|alternate)(=|$)/.test(t)
  || /^-[A-Za-z]*c[A-Za-z]*$/.test(t);

// systemd EnvironmentFile values may be wrapped in one pair of quotes.
const splitQuotes = (value) => {
  const m = /^(["'])(.*)\1$/.exec(value);
  return m ? { quote: m[1], inner: m[2] } : { quote: '', inner: value };
};

// The last LOOKOUT_ARGS= line is the one systemd uses.
const findArgsLine = (lines) => {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (LINE_RE.test(lines[i])) return i;
  }
  return -1;
};

const readArgs = (envText) => {
  const lines = String(envText || '').split('\n');
  const idx = findArgsLine(lines);
  if (idx < 0) return { args: '', sensorAddress: null, medical: false };
  const { inner } = splitQuotes(LINE_RE.exec(lines[idx])[1]);
  const m = ADDR_FLAG_RE.exec(inner);
  const sensorAddress = m && ADDRESS_RE.test(m[3]) ? m[3] : null;
  const medical = inner.split(/\s+/).some(isMedicalToken);
  return { args: inner, sensorAddress, medical };
};

const setSensorAddress = (envText, addr) => {
  if (typeof addr !== 'string' || !ADDRESS_RE.test(addr)) {
    throw new Error('bad sensor address');
  }
  const text = String(envText || '');
  const lines = text.split('\n');
  const idx = findArgsLine(lines);
  if (idx < 0) {
    const sep = text === '' || text.endsWith('\n') ? '' : '\n';
    return `${text}${sep}LOOKOUT_ARGS=--sensor_address ${addr}\n`;
  }
  const { quote, inner } = splitQuotes(LINE_RE.exec(lines[idx])[1]);
  const next = ADDR_FLAG_RE.test(inner)
    ? inner.replace(ADDR_FLAG_RE, (all, flag, sep) => `${flag}${sep}${addr}`)
    : `${inner}${inner ? ' ' : ''}--sensor_address ${addr}`;
  lines[idx] = `LOOKOUT_ARGS=${quote}${next}${quote}`;
  return lines.join('\n');
};

// Make sure LOOKOUT_ARGS contains `flag` (e.g. --no_auto_pair for fleet mode).
const ensureFlag = (envText, flag) => {
  const text = String(envText || '');
  const lines = text.split('\n');
  const idx = findArgsLine(lines);
  if (idx < 0) {
    const sep = text === '' || text.endsWith('\n') ? '' : '\n';
    return `${text}${sep}LOOKOUT_ARGS=${flag}\n`;
  }
  const { quote, inner } = splitQuotes(LINE_RE.exec(lines[idx])[1]);
  if (inner.split(/\s+/).includes(flag)) return text;
  lines[idx] = `LOOKOUT_ARGS=${quote}${inner}${inner ? ' ' : ''}${flag}${quote}`;
  return lines.join('\n');
};

module.exports = {
  readArgs, setSensorAddress, ensureFlag, ADDRESS_RE,
};
