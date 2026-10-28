#!/usr/bin/env node
/**
 * Plan an objective with an explicitly configured model, save the validated
 * goals, then optionally preview/execute using the existing guarded runner.
 * Planning alone has no key, blockchain transaction or provider side effect.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createModelClient, planObjective, saveGoals, validatePlanningConfig } from './goal-planner.mjs';
import { compareApprovedQuotes } from './quote-comparison.mjs';

const USAGE = `Usage: node bouncer/agent/autonomous.mjs --config owner.json --objective-file objective.txt --output new-goals.json [--compare-providers] [--key agent-key.json] [--local-provider provider.json] [--execute]

Uses BOUNCER_LLM_URL (full chat-completions endpoint), BOUNCER_LLM_MODEL, and
optionally BOUNCER_LLM_API_KEY. The objective is sent to that model; do not
include secrets in it. The owner config, signing key and journal are not sent.
Planning alone sends no transactions. --compare-providers sends each order to
all owner-approved quote endpoints; start them separately, not --local-provider.
Supplying --key also runs a read-only quote/policy preflight; --execute
explicitly sends real TESTNET transactions. The output and its matching journal
are private and must be kept for recovery.
Do not use real funds or a full-access key. See bouncer/docs/AI_AGENT.md.
`;

function parseArgs(args) {
  const options = { execute: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') return { help: true };
    if (arg === '--execute' || arg === '--compare-providers') {
      const name = arg.slice(2);
      if (options[name]) throw new Error(`duplicate ${arg}`);
      options[name] = true; continue;
    }
    if (['--config', '--objective-file', '--output', '--key', '--local-provider'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--')) {
      const name = arg.slice(2);
      if (options[name]) throw new Error(`duplicate ${arg}`);
      options[name] = args[++i];
    } else throw new Error(`unknown or incomplete argument: ${arg}`);
  }
  if (!options.config || !options['objective-file'] || !options.output) throw new Error('--config, --objective-file and --output are required');
  if ((options.execute || options['local-provider']) && !options.key) throw new Error('--execute and --local-provider require --key');
  if (options['compare-providers'] && options['local-provider']) throw new Error('--compare-providers requires separately running providers, not --local-provider');
  return options;
}

// Read bounded files even if an untrusted objective grows while being read.
function readBounded(file, maxBytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const n = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (!n) break;
      length += n;
    }
    if (length > maxBytes) throw new Error('input file is too large');
    return buffer.subarray(0, length).toString('utf8');
  } finally { fs.closeSync(fd); }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(USAGE); return; }
  const target = path.resolve(options.output);
  // Check early to avoid contacting a model when the output already exists;
  // saveGoals also uses exclusive creation to close the race.
  try { fs.lstatSync(target); throw new Error('output already exists; choose a new path or use the existing goals to resume'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let config;
  try { config = JSON.parse(readBounded(options.config, 32 * 1024)); } catch { throw new Error('could not read a valid owner config'); }
  validatePlanningConfig(config);
  const objective = readBounded(options['objective-file'], 4000);
  const modelClient = createModelClient({ endpoint: process.env.BOUNCER_LLM_URL, model: process.env.BOUNCER_LLM_MODEL, apiKey: process.env.BOUNCER_LLM_API_KEY || undefined });
  let goals = await planObjective({ objective, config, modelClient });
  if (options['compare-providers']) {
    goals = await compareApprovedQuotes({ config, proposedGoals: goals });
    for (const comparison of goals.quote_comparisons) {
      const quotes = comparison.quotes.map(q => `${q.provider_id}=${q.amount}`).join(', ');
      console.log(`[autonomous] ${comparison.goal_id}: ${quotes} ${comparison.token}; selected ${comparison.selected_provider} (owner-order tie break)`);
    }
    console.log('[autonomous] Selected quotes will be rechecked exactly before payment; review the saved routes and work.');
  }
  saveGoals(target, goals);
  console.log(`[autonomous] Saved ${goals.goals.length} validated model-proposed task(s) to ${target}`);
  console.log('[autonomous] Model output is untrusted. Review the objective, task inputs and owner limits; the model cannot set payees, tokens or policy.');
  if (!options.key) {
    console.log(options['compare-providers'] ? '[autonomous] Quote comparison only: no blockchain transactions or fulfillment.' :
      '[autonomous] Planning only: no quotes, blockchain transactions or fulfillment.');
    return;
  }
  const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), 'resource-agent.mjs');
  const args = [runner, '--goals', target, '--key', options.key];
  if (options['local-provider']) args.push('--local-provider', options['local-provider']);
  if (options.execute) args.push('--execute');
  const childEnv = { ...process.env };
  // The resource runner has no need for the model credential.
  delete childEnv.BOUNCER_LLM_API_KEY;
  const child = spawn(process.execPath, args, { stdio: 'inherit', env: childEnv });
  const status = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  if (status) process.exitCode = status;
}

main().catch(error => { console.error(`[autonomous] ERROR: ${error.message}`); process.exitCode = 1; });
