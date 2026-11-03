#!/usr/bin/env node
/** LOCAL ONLY: journal and export one fixed fake-token registration. Does not
 * broadcast, install agent keys or contact a seller. */
import fs from 'node:fs';
import { signAndJournalOutlayerV12Registration } from '../agent/outlayer-v12-burn-register-journal.mjs';
const [option,...extra]=process.argv.slice(2);
if ((option && option!=='--restore-original')||extra.length)throw new Error('usage: sign-outlayer-v12-v3-registration-offline.mjs [--restore-original]');
const ownerPlan=JSON.parse(fs.readFileSync(new URL('../config/testnet-owner-v3-plan.json',import.meta.url),'utf8'));
const plan=JSON.parse(fs.readFileSync(new URL('../config/testnet-outlayer-burn-v3-plan.json',import.meta.url),'utf8'));
const base='/home/user/near_hub/.bouncer-private/owner-v3';
const paths={ownerKeyring:base,agentKeyring:`${base}/outlayer-v12-agent`,circleFundJournal:`${base}/vault-v12-circle-fund-journal.json`,
 snapshot:`${base}/outlayer-v12-registration-snapshot.json`,journal:`${base}/outlayer-v12-registration-journal.json`,
 evidence:'/home/user/near_hub/bouncer/evidence/testnet-owner-v3/outlayer-v12-register-original.json',lock:`${base}/outlayer-v12-registration.lock`};
try{console.log(JSON.stringify(await signAndJournalOutlayerV12Registration({ownerPlan,plan,paths,restore:option==='--restore-original'}),null,2))}
catch(error){console.error(`OutLayer V12 registration signing stopped: ${error?.message??'unknown'}`);process.exitCode=1}
