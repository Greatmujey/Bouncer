// Optional preload for older near-api-js scripts which use `depd`.
// Suppress deprecations, never ordinary warnings, errors, or stderr writes.
// Usage: NODE_OPTIONS="--require=./bouncer/quiet.cjs" node bouncer/xxx.mjs
process.env.NO_DEPRECATION = '*';
process.noDeprecation = true;
