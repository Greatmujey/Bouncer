// Preload: aggressively suppress near-api-js v6 deprecation noise for clean recordings.
// Usage: NODE_OPTIONS="--require=./bouncer/quiet.cjs" node bouncer/xxx.mjs
process.env.NODE_NO_WARNINGS = '1';
process.removeAllListeners('warning');
process.on('warning', () => {});

const isNoise = (args) => {
  const m = args.map(a => String(a)).join(' ');
  return /deprecated|please switch|It will be removed|new Connection\(|^Account\.|^Receipts?:?\s*[A-Za-z0-9]{20,}/i.test(m);
};
const wrap = (orig) => (...args) => { if (!isNoise(args)) orig.apply(console, args); };
console.warn = wrap(console.warn);
console.error = wrap(console.error);

const origOut = process.stdout.write.bind(process.stdout);
const origErr = process.stderr.write.bind(process.stderr);
process.stdout.write = function(chunk, ...rest) {
  const s = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
  if (/deprecated|It will be removed|please switch|Account\.\w+\(\)\s+deprecated|signTransaction\(\)\s+deprecated|signAndSendTransaction/i.test(s)) return true;
  return origOut(chunk, ...rest);
};
process.stderr.write = function(chunk, ...rest) {
  const s = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
  if (/deprecated|It will be removed|please switch|warning/i.test(s)) return true;
  return origErr(chunk, ...rest);
};
