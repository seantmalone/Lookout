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

// --display_type X / --display_type=X (yargs also accepts --display-type).
const DISPLAY_TYPE_RE = /^--display[_-]type(=|$)/;
// Slot 1 is the pump's (medical) slot, by any of its names.
const isMedicalDisplayType = (v) => typeof v === 'string'
  && (['medical', 'receiver'].includes(v.toLowerCase()) || Number(v) === 1);

// The values given to --display_type, in either form.
const displayTypes = (tokens) => tokens.reduce((vals, t, i) => {
  const m = DISPLAY_TYPE_RE.exec(t);
  if (!m) return vals;
  return vals.concat(m[1] === '=' ? t.slice(t.indexOf('=') + 1) : (tokens[i + 1] || ''));
}, []);

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
  const tokens = inner.split(/\s+/);
  const medical = tokens.some(isMedicalToken) || displayTypes(tokens).some(isMedicalDisplayType);
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

// Drop the --sensor_address pin (either form) from LOOKOUT_ARGS; every other
// byte stays as it was.
const removeSensorAddress = (envText) => {
  const text = String(envText || '');
  const lines = text.split('\n');
  const idx = findArgsLine(lines);
  if (idx < 0) return text;
  const { quote, inner } = splitQuotes(LINE_RE.exec(lines[idx])[1]);
  // a pin in the middle or at the end takes its leading space with it; one at
  // the start takes the space after it
  const next = inner.replace(/(^|\s+)--sensor_address(?:=|\s+)\S+(\s*)/g, (all, pre, post) => (pre ? post : ''));
  if (next === inner) return text;
  lines[idx] = `LOOKOUT_ARGS=${quote}${next}${quote}`;
  return lines.join('\n');
};

// A collector uses the watch slot unless the env file names one: say so
// explicitly, so it does not depend on Lookout's default slot.
const ensureDisplayType = (envText) => {
  const { args } = readArgs(envText);
  if (args.split(/\s+/).some((t) => DISPLAY_TYPE_RE.test(t))) return String(envText || '');
  return ensureFlag(envText, '--display_type watch');
};

module.exports = {
  readArgs, setSensorAddress, ensureFlag, removeSensorAddress, ensureDisplayType, ADDRESS_RE,
};
