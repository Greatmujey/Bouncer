/**
 * Read a machine-to-machine checkpoint bearer from an operator-provisioned
 * local file. The token never belongs in the repository, browser, URLs, command
 * arguments or logs. This checks the local file only; it does not establish
 * operator independence, server identity or rollback protection.
 */
import fs from 'node:fs';
import path from 'node:path';

export function readProtectedCheckpointToken(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('protected checkpoint token unavailable');
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || stat.size < 43 || stat.size > 44) throw Error();
    const bytes = Buffer.alloc(45);
    try {
      const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
      if (count !== stat.size || count > 44) throw Error();
      const token = bytes.subarray(0, count).toString('utf8').replace(/\n$/, '');
      const decoded = Buffer.from(token, 'base64url');
      try {
        if (!/^[A-Za-z0-9_-]{43}$/.test(token) || decoded.length !== 32 || decoded.toString('base64url') !== token) throw Error();
      } finally { decoded.fill(0); }
      return token;
    } finally { bytes.fill(0); }
  } catch {
    throw new Error('protected checkpoint token unavailable');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
