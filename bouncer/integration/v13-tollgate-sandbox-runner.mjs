#!/usr/bin/env node
/** Start a NEW loopback-only nearcore chain with disposable keys and no public
 * chain access. The seller and voucher are fixtures; no HTTP provider order. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nearApi from 'near-api-js';
import {startSandbox,stopSandboxChild} from './v11-nearcore-sandbox.mjs';
import {readVerifiedFile,SANDBOX_SHA256} from './v11-sandbox-support.mjs';
import {exerciseV13TollgateSandbox,PUBLISHED_CHANNEL_SHA256} from './v13-sandbox-tollgate.mjs';
readVerifiedFile(process.env.BOUNCER_SANDBOX_BIN,SANDBOX_SHA256);
const wasm=fs.readFileSync(process.env.BOUNCER_V13_WASM_PATH);
const channel=readVerifiedFile(process.env.BOUNCER_TOLLGATE_WASM_PATH,PUBLISHED_CHANNEL_SHA256,{maxBytes:4*1024*1024});
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bouncer-v13-tollgate-sandbox-'));
const genesisKey=nearApi.KeyPair.fromRandom('ed25519');let sandbox;
try{
 sandbox=await startSandbox(process.env.BOUNCER_SANDBOX_BIN,dir,String(genesisKey.getPublicKey()));
 const root=new nearApi.Account('testnet',sandbox.provider,new nearApi.KeyPairSigner(sandbox.rootKey));
 const result=await exerciseV13TollgateSandbox({rpcUrl:sandbox.rpcUrl,root,v13Wasm:wasm,
  v13Sha256:process.env.BOUNCER_V13_WASM_SHA256,channelWasm:channel});
 console.log(JSON.stringify(result,null,2));
}finally{
 if(sandbox)await stopSandboxChild(sandbox.child);
 fs.rmSync(dir,{recursive:true,force:true});
}
