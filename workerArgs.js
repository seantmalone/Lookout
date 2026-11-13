// Node flags for the forked transmitter worker. Measured on a Pi Zero W
// (Node 22): the G7 EC-J-PAKE exchange takes ~2.2 s with these flags versus
// 4.6-5 s with the launcher's tiny heap (constant scavenges), at ~55 MB peak RSS.
const WORKER_EXEC_ARGV = [
  '--max-old-space-size=128',
  '--max-semi-space-size=16',
];

// The worker's command line: id, display type (the slot byte xdrip-js sends:
// 1 medical/receiver, 2 phone, 3 watch), saved key and its address, the
// pinned sensor address, and whether pairing is allowed ('0' = fleet, no).
const buildWorkerArgs = ({
  id, displayType, key, macAddress, sensorAddress, allowPairing,
}) => [id, String(displayType), key || '', macAddress || '', sensorAddress || '',
  allowPairing ? '1' : '0'];

const parseWorkerArgs = (argv) => {
  const [id, type, key, mac, pinned, allow] = argv.slice(2);
  const displayType = Number(type);
  if (!Number.isInteger(displayType) || displayType < 1 || displayType > 3) {
    throw new Error(`invalid display type "${type}" for the transmitter worker`);
  }
  return {
    id,
    displayType,
    key: key?.trim() || null,
    macAddress: mac?.trim() || null,
    sensorAddress: pinned?.trim() || null,
    allowPairing: allow !== '0',
  };
};

module.exports = { WORKER_EXEC_ARGV, buildWorkerArgs, parseWorkerArgs };
