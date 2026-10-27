// Preload: completely mute near-api-js v6 deprecation spam for clean recordings.
// Usage: node --require=./bouncer/quiet.cjs bouncer/redeploy.mjs
// For ESM, use:  NODE_OPTIONS='--require=./bouncer/quiet.cjs' node bouncer/redeploy.mjs
const origEmit = process.emit;
process.emit = function(ev, ...args) {
  if (ev === 'warning') return false; // swallow deprecation warnings
  return origEmit.call(this, ev, ...args);
};
const origWarn = console.warn;
console.warn = (...a) => {
  const m = a.join(' ');
  if (/deprecated|please switch|It will be removed|new Connection|Account\./i.test(m)) return;
  origWarn.apply(console, a);
};
const origErr = console.error;
console.error = (...a) => {
  const m = a.join(' ');
  if (/deprecated|please switch|It will be removed|new Connection|Account\./i.test(m)) return;
  origErr.apply(console, a);
};
