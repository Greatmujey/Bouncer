/** Bounded public inputs for one replacement testnet resource agent. */
import fs from 'node:fs';
import { validateOwnerBootstrapPlan } from '../agent/testnet-owner-bootstrap.mjs';
import { validateTestnetResourceAgentPlan } from '../agent/testnet-resource-agent-keyring.mjs';
import { verifyTestnetResourceAgentFundingAnchor } from '../agent/testnet-resource-agent-funding-anchor.mjs';
import { verifySignedTestnetResourceAgentSetup } from '../agent/testnet-resource-agent-setup.mjs';
const stages=['guard-probe','configure','install'];
function load(url,max=100_000){
 const stat=fs.lstatSync(url);if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>max)throw new Error('invalid public resource-agent input');
 const bytes=fs.readFileSync(url);if(bytes.length!==stat.size)throw new Error('public resource-agent input changed');
 return {bytes,value:JSON.parse(bytes.toString('utf8'))};
}
export function publicResourceAgentInputs(stage){
 if(stage!==undefined&&!stages.includes(stage))throw new Error('invalid resource-agent stage');
 const owner=validateOwnerBootstrapPlan(load(new URL('../config/testnet-owner-v2-plan.json',import.meta.url)).value);
 const agent=validateTestnetResourceAgentPlan(load(new URL('../config/testnet-resource-agent-v2-plan.json',import.meta.url)).value,owner);
 const fund=load(new URL('../evidence/testnet-owner-v2/vault-circle-fund-original.json',import.meta.url)).value;
 const proof=load(new URL('../evidence/testnet-owner-v2/vault-circle-fund-final-verification.json',import.meta.url)).value;
 const anchor=verifyTestnetResourceAgentFundingAnchor({ownerPlan:owner,envelope:fund,proof});
 if(stage===undefined)return {owner,agent,anchor};
 const original=load(new URL(`../evidence/testnet-owner-v2/resource-agent-${stage}-original.json`,import.meta.url),16_384);
 if(original.value.stage!==stage)throw new Error('original resource-agent stage differs');
 verifySignedTestnetResourceAgentSetup(original.value,owner,agent);
 return {owner,agent,anchor,envelope:original.value,bytes:original.bytes};
}
