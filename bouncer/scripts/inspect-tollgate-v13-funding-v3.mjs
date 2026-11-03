#!/usr/bin/env node
/** Fixed V3 owner, trusted-RPC views only. This does not sign, spend, fund,
 * restore a key or authorize an owner transaction. Both public originals are
 * observed for age only; absence of a receipt is not proof of past absence. */
import fs from 'node:fs';
import { ReadOnlyNearRpcProvider } from '../agent/read-only-near-rpc.mjs';
import { inspectTollgateV13Funding } from '../agent/tollgate-v13-funding.mjs';
import { observeOriginalReference } from '../agent/observe-original-reference.mjs';
const ownerPlan=JSON.parse(fs.readFileSync(new URL('../config/testnet-owner-v3-plan.json',import.meta.url),'utf8'));
const references=[['registration','Fya6QcT1fW6aBChdrCi9p44AuCf2dhSNRNpR7tzXEiYf'],
 ['control','Cz6JjNTchF3drnemZVg4cNsM4SobAJRfRB1hBvfcADzQ']];
for(const endpoint of ['https://test.rpc.fastnear.com','https://rpc.testnet.near.org']){
 try{
  const provider=new ReadOnlyNearRpcProvider(endpoint,{timeoutMs:10_000});
  const funding=await inspectTollgateV13Funding({ownerPlan,provider});
  const originalReferences={};
  for(const [name,referenceHash] of references){
   try{originalReferences[name]=await observeOriginalReference({provider,referenceHash})}
   catch{originalReferences[name]={status:'UNAVAILABLE',historical_execution_known:false,do_not_resend_original:true}}
  }
  console.log(JSON.stringify({...funding,rpc:new URL(endpoint).hostname,original_references:originalReferences,
   owner_transaction_authorized:false,do_not_resend_registration_or_control:true,
   note:'Reference age does not prove historical non-execution. Recover custody securely and reconcile before owner signing.'},null,2));
  process.exit(0);
 }catch{console.error(`V13 read-only funding snapshot unavailable at ${new URL(endpoint).hostname}; no signing or payment`)}
}
console.error('V13 funding snapshot unavailable; no owner transaction was authorized.');process.exitCode=1;
