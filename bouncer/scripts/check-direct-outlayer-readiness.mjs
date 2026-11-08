#!/usr/bin/env node
// Public read-only testnet checks for the dedicated direct OutLayer preview.
// No wallet, signing, key, transaction submission or purchase occurs here.
import { inspectDirectOutlayerReadiness } from '../web-src/direct-outlayer-testnet.mjs';

const endpoint='https://rpc.testnet.near.org', origin='https://4173-read-only-probe.e2b.app';
const allowed=response=>['*',origin].includes(response.headers.get('access-control-allow-origin'));
const includes=(response,key,value)=>(response.headers.get(key)??'').toLowerCase().split(',').map(x=>x.trim()).some(x=>x===value||x==='*');
const options=await fetch(endpoint,{method:'OPTIONS',headers:{origin,'access-control-request-method':'POST','access-control-request-headers':'content-type'},
  signal:AbortSignal.timeout(15000),redirect:'error'});
if(!options.ok||!allowed(options)||!includes(options,'access-control-allow-methods','post')||!includes(options,'access-control-allow-headers','content-type'))throw Error('browser RPC preflight unavailable');
await options.body?.cancel();
const probe=await fetch(endpoint,{method:'POST',headers:{origin,'content-type':'application/json'},
  body:JSON.stringify({jsonrpc:'2.0',id:'bouncer-cors-probe',method:'status',params:[]}),signal:AbortSignal.timeout(15000),redirect:'error'});
if(!probe.ok||!allowed(probe))throw Error('browser RPC CORS unavailable');
const body=await probe.json();if(body.id!=='bouncer-cors-probe'||body.result?.chain_id!=='testnet')throw Error('RPC is not testnet');
const ready=await inspectDirectOutlayerReadiness({fetch});
const summary={scope:'public testnet FINAL views and representative preview-origin CORS; no phone or wallet verification',
  block_hash:ready.block_hash,block_height:ready.block_height,owner:ready.owner,
  owner_available_yocto:ready.owner_available_yocto,receiver:ready.payee,project_id:ready.project_id,
  maximum_yocto:ready.maximum_yocto,gas:ready.gas,browser_rpc_cors:true,firewall_used:false,signed:false,sent:false};
console.log(JSON.stringify(summary));
if(process.env.GITHUB_ACTIONS==='true')console.log('::notice title=Direct OutLayer read-only browser readiness::'+JSON.stringify(summary));
