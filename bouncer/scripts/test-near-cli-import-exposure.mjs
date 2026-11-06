#!/usr/bin/env node
/**
 * Disposable safety probe: generates a never-funded, never-registered random
 * key in memory and asks the official CLI to import it into a temporary home.
 * No user key, seed phrase, wallet account, signer or network transaction is
 * involved. Only booleans are reported; all test files are removed afterwards.
 * DO NOT use this script to import anyone's actual credentials.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import nearApi from 'near-api-js';

if (process.argv.length !== 3) throw new Error('usage: node scripts/test-near-cli-import-exposure.mjs NEAR');
const near = path.resolve(process.argv[2]);
if (!fs.statSync(near).isFile()) throw new Error('CLI executable required');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-cli-import-fixture-'));
try {
  const home = path.join(temp, 'home'); fs.mkdirSync(home, { mode: 0o700 });
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: home, APPDATA: home,
    TMPDIR: temp, TMP: temp, TEMP: temp, NO_COLOR: '1', TERM: 'dumb' };
  const throwaway = nearApi.KeyPair.fromRandom('ed25519').toString();
  const args = ['--offline', '--quiet', 'account', 'import-account', 'using-private-key', throwaway,
    'cli-import-fixture.testnet', 'network-config', 'testnet', 'save-to-legacy-keychain'];
  const result = spawnSync(near, args, { env, encoding: 'utf8', timeout: 30_000,
    maxBuffer: 100_000, stdio: ['ignore', 'pipe', 'pipe'] });
  // Never print a raw argument, CLI output, credential file or key. This is a
  // generated fixture, not a usable user credential or an on-chain account.
  const commandLog = path.join(temp, 'near-cli-rs-final-command.log');
  const commandLogExists = fs.existsSync(commandLog);
  const commandLogContainsFixture = commandLogExists && fs.readFileSync(commandLog, 'utf8').includes(throwaway);
  const resultReport = { synthetic_unfunded_key_only: true, cli_offline_flag_used: true,
    import_completed: result.status === 0, cli_status: result.status,
    fixture_found_in_command_log: commandLogContainsFixture,
    fixture_found_in_captured_stdout: (result.stdout || '').includes(throwaway),
    fixture_found_in_captured_stderr: (result.stderr || '').includes(throwaway),
    temp_command_log_created: commandLogExists,
    signed: false, broadcast: false, user_key_used: false,
    scope: 'Disposable local-file behavior only; never enter real keys in a command, chat, GitHub or an untrusted terminal.' };
  console.log(JSON.stringify(resultReport));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
