const Debug = require('debug');

const log = Debug('transmitterWorker:log');
/* eslint-disable-next-line no-unused-vars */
const error = Debug('transmitterWorker:error');
/* eslint-disable-next-line no-unused-vars */
const debug = Debug('transmitterWorker:debug');

const Transmitter = require('xdrip-js');
const { parseWorkerArgs } = require('./workerArgs');

// id, display type (the slot byte xdrip-js sends), saved key + address, the
// pinned sensor address (never pair with other people's sensors nearby), and
// whether pairing is allowed ('0': fleet mode, authenticate with the shared
// key, never re-pair)
const {
  id, displayType, key, macAddress, sensorAddress, allowPairing,
} = parseWorkerArgs(process.argv);

/* eslint-disable-next-line no-unused-vars */
const getMessages = () => new Promise((resolve, reject) => {
  process.on('message', (messages) => {
    resolve(messages);
  });
  // TODO: consider adding a timeout here, with resolve([]), or reject
  process.send({ msg: 'getMessages' });
});

log(`kicking off with display type ${displayType}`);

const transmitter = new Transmitter(id, getMessages, displayType, key, macAddress, {
  sensorAddress,
  allowPairing,
  // no saved key => next connection is a first G7 pairing; pre-warm the crypto
  warmUp: !key,
});

transmitter.on('glucose', (glucose) => {
  process.send({ msg: 'glucose', data: glucose });
});

transmitter.on('messageProcessed', (data) => {
  process.send({ msg: 'messageProcessed', data });
});

transmitter.on('calibrationData', (data) => {
  process.send({ msg: 'calibrationData', data });
});

transmitter.on('batteryStatus', (data) => {
  process.send({ msg: 'batteryStatus', data });
});

transmitter.on('version', (data) => {
  process.send({ msg: 'version', data });
});

transmitter.on('sawTransmitter', (data) => {
  process.send({ msg: 'sawTransmitter', data });
});

transmitter.on('backfillData', (data) => {
  process.send({ msg: 'backfillData', data });
});

transmitter.on('sensorKey', (data) => {
  process.send({ msg: 'sensorKey', data });
});

transmitter.on('pairingBlocked', (data) => {
  process.send({ msg: 'pairingBlocked', data });
});

transmitter.on('disconnect', process.exit);
