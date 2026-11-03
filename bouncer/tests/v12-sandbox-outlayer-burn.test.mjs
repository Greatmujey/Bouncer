import test from 'node:test';
import assert from 'node:assert/strict';
import {exerciseSandboxOutlayerBurn} from '../integration/v12-sandbox-outlayer-burn.mjs';

test('V12 OutLayer burn-plan harness refuses non-loopback, mismatched roots and unpinned bytecode before signing',async()=>{
 const root={accountId:'testnet',provider:{connection:{url:'http://127.0.0.1:3030'}}};
 await assert.rejects(exerciseSandboxOutlayerBurn({rpcUrl:'https://rpc.testnet.near.org',root,wasm:Buffer.alloc(0),mockFt:Buffer.alloc(0)}),/loopback|sandbox/i);
 await assert.rejects(exerciseSandboxOutlayerBurn({rpcUrl:'http://127.0.0.1:4040',root,wasm:Buffer.alloc(0),mockFt:Buffer.alloc(0)}),/local sandbox/i);
 await assert.rejects(exerciseSandboxOutlayerBurn({rpcUrl:'http://127.0.0.1:3030',root,wasm:Buffer.alloc(0),mockFt:Buffer.alloc(0)}),/pinned fixture bytecode/i);
});
