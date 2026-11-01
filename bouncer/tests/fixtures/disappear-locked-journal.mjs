// Offline fault injection: move one synthetic journal after its lock is taken.
// The test retains its exact bytes and checks the CLI never creates a replacement.
import fs from 'node:fs';

const target = process.env.BOUNCER_TEST_DISAPPEARING_JOURNAL;
if (!target) throw new Error('synthetic journal path is required');
const lstat = fs.lstatSync;
let injected = false;
fs.lstatSync = function (file, ...args) {
  if (!injected && file === target) {
    if (!fs.existsSync(`${target}.lock`)) throw new Error('fault injected before journal lock');
    fs.renameSync(target, `${target}.disappeared`);
    injected = true;
  }
  return lstat.call(this, file, ...args);
};
