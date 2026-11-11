// Argument rules for g7-rig, shared by the CLI and (in shell form) the
// forced-command wrapper deploy/g7-rig-remote.sh. Only node built-ins here:
// this file is installed to /usr/local/lib/g7rig.

const NAME = 'DXCM[A-Za-z0-9]{2}';
const CODE = '[0-9]{4}';

const FORMS = [
  { cmd: 'status', re: /^status$/ },
  { cmd: 'export-key', re: /^export-key$/ },
  { cmd: 'import-key', re: /^import-key$/ },
  { cmd: 'scan', re: new RegExp(`^scan (${NAME})$`) },
  { cmd: 'pair', re: new RegExp(`^pair (${CODE}) (${NAME})$`) },
];

const NAME_RE = new RegExp(`^${NAME}$`);
const CODE_RE = new RegExp(`^${CODE}$`);

// cmdline: the whole command as one string (e.g. SSH_ORIGINAL_COMMAND).
const parseRemote = (cmdline) => {
  if (typeof cmdline !== 'string') throw new Error('rejected');
  for (let i = 0; i < FORMS.length; i += 1) {
    const m = FORMS[i].re.exec(cmdline);
    if (m) return { cmd: FORMS[i].cmd, args: m.slice(1) };
  }
  throw new Error('rejected');
};

module.exports = { parseRemote, NAME_RE, CODE_RE };
