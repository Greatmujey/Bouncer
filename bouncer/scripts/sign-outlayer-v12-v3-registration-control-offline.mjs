#!/usr/bin/env node
/** LOCAL ONLY, one distinct zero-yocto control. No registration resend,
 * no network access, and no private key enters CI. */
import fs from 'node:fs';
import { signAndJournalV12RegistrationControl } from '../agent/outlayer-v12-registration-control-journal.mjs';
const [option,...extra]=process.argv.slice(2);
if ((option && option!=='--restore-original')||extra.length) throw new Error('usage: sign-outlayer-v12-v3-registration-control-offline.mjs [--restore-original]');
const ownerPlan=JSON.parse(fs.readFileSync(new URL('../config/testnet-owner-v3-plan.json',import.meta.url),'utf8'));
const plan=JSON.parse(fs.readFileSync(new URL('../config/testnet-outlayer-burn-v3-plan.json',import.meta.url),'utf8'));
const original=JSON.parse(fs.readFileSync(new URL('../evidence/testnet-owner-v3/outlayer-v12-register-original.json',import.meta.url),'utf8'));
if(original.tx_hash!=='9tsgJgUUqJsV9X8hpRABqPwcC7SZJ9uV64xc3bFoamPe'||original.nonce!=='276049352000007') throw new Error('unexpected original registration');
const base='/home/user/near_hub/.bouncer-private/owner-v3';
const paths={ownerKeyring:base,originalJournal:`${base}/outlayer-v12-registration-journal.json`,
 snapshot:`${base}/outlayer-v12-control-snapshot.json`,journal:`${base}/outlayer-v12-control-journal.json`,
 evidence:'/home/user/near_hub/bouncer/evidence/testnet-owner-v3/outlayer-v12-register-control-original.json',lock:`${base}/outlayer-v12-control.lock`};
try{console.log(JSON.stringify(await signAndJournalV12RegistrationControl({ownerPlan,plan,original,paths,restore:option==='--restore-original'}),null,2))}
catch(error){console.error(`V12 registration control signing stopped: ${error?.message??'unknown'}`);process.exitCode=1}
