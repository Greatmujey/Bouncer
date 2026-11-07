/**
 * Experimental independently operable setup-head checkpoint. Run this on a
 * separate host/database/operator from the wallet prompt service, behind
 * authenticated TLS. Every CAS is independently audited against the freshly
 * fetched exact Git remote branch; a caller with the API token cannot advance
 * it past a deleted or rewritten protected witness. Provision the underlying
 * PostgreSQL anchor out-of-band from a verified complete baseline first.
 *
 * Not deployed by this module. The checkpoint DB can still be rolled back or
 * forged by a privileged operator; retain/monitor the latest revision in yet
 * another independently controlled system. Compromised monitor code, stolen
 * operator credentials, old clients, RPC, wallet or site are out of scope.
 * Slow Git/network calls may exceed the existing five-second preflight window;
 * an expired/uncertain claim is consumed and MUST NOT be retried.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createGitWitnessHistoryAudit } from './git-witness-history-audit.mjs';

const tokenOk=x=>typeof x==='string' && /^[A-Za-z0-9_-]{43}$/.test(x);
const head=x=>typeof x==='string' && /^[a-f0-9]{40}$/.test(x);
const revision=x=>typeof x==='string' && /^[a-zA-Z0-9_-]{1,128}$/.test(x);
const plain=x=>x!==null && typeof x==='object' && !Array.isArray(x) && Object.getPrototypeOf(x)===Object.prototype;
const exact=(x,keys)=>plain(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const checkpoint=x=>exact(x,['head','revision'])&&head(x.head)&&revision(x.revision);
const same=(a,b)=>a.head===b.head&&a.revision===b.revision;
const fail=()=>new Error('independent setup checkpoint unavailable or uncertain; stop and reconcile, never repeat a prompt');

/** Fetch the exact configured remote into a monitor-only checkout. Never use
 * the user's working tree; this updates that checkout's remote-tracking ref. */
export function createIndependentGitHeadResolver({repo,branch,remoteUrl,allowLocalForTests=false}={}){
  if(typeof repo!=='string'||!path.isAbsolute(repo)||typeof branch!=='string'||
     !/^[A-Za-z0-9_./-]{1,180}$/.test(branch)||branch.includes('..')||branch.endsWith('/')||
     typeof remoteUrl!=='string'||typeof allowLocalForTests!=='boolean')throw fail();
  let root;try{root=fs.realpathSync(repo)}catch{throw fail()}
  const git=(args,timeout=30_000)=>execFileSync('git',args,{cwd:root,encoding:'utf8',timeout,maxBuffer:1_048_576,
    stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_TERMINAL_PROMPT:'0'}}).trim();
  try{
    if(git(['rev-parse','--show-toplevel'])!==root || git(['check-ref-format','--branch',branch])!==branch ||
       git(['remote','get-url','origin'])!==remoteUrl)throw Error();
    if(!allowLocalForTests){const url=new URL(remoteUrl);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||
      url.hostname!=='github.com'||url.href!==remoteUrl)throw Error()}
  }catch{throw fail()}
  return async function resolveRemoteHead(){
    try{
      if(git(['remote','get-url','origin'])!==remoteUrl)throw Error();
      git(['fetch','--quiet','--no-tags','--no-recurse-submodules','--no-write-fetch-head','origin',
        `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
      const result=git(['rev-parse','--verify',`refs/remotes/origin/${branch}^{commit}`]);if(!head(result))throw Error();return result;
    }catch{throw fail()}
  };
}
const respond=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',
  'x-content-type-options':'nosniff','referrer-policy':'no-referrer'});res.end(JSON.stringify(value))};
async function body(req){
  if(req.headers['content-length']&&(!/^\d+$/.test(req.headers['content-length'])||Number(req.headers['content-length'])>2048))throw Error();
  const parts=[];let total=0;for await(const b of req){total+=b.length;if(total>2048)throw Error();parts.push(b)}return JSON.parse(Buffer.concat(parts,total).toString('utf8'));
}
/** Authenticated machine-to-machine service; no wallet, key, receipt, or NEAR
 * broadcast route. `resolveRemoteHead` and `audit` execute on THIS host. */
export function createIndependentSetupCheckpointServer({anchor,resolveRemoteHead,audit,token,bodyTimeoutMs=5000}={}){
  if(!anchor||typeof anchor.read!=='function'||typeof anchor.compareAndSet!=='function'||typeof resolveRemoteHead!=='function'||
     typeof audit!=='function'||!tokenOk(token)||!Number.isSafeInteger(bodyTimeoutMs)||bodyTimeoutMs<10||bodyTimeoutMs>10_000)throw fail();
  const expected=Buffer.from(`Bearer ${token}`);let active=0;
  return http.createServer(async(req,res)=>{
    const actual=Buffer.from(typeof req.headers.authorization==='string'?req.headers.authorization:'');
    if(actual.length!==expected.length||!crypto.timingSafeEqual(actual,expected))return respond(res,401,{error:'unavailable'});
    if(req.url==='/v1/head' && req.method==='GET'){
      try{const value=await anchor.read();if(!checkpoint(value))throw Error();return respond(res,200,value)}catch{return respond(res,503,{error:'unavailable'})}
    }
    if(req.url!=='/v1/compare-and-set'||req.method!=='POST')return respond(res,404,{error:'unavailable'});
    if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??''))return respond(res,403,{error:'unavailable'});
    if(active>=4)return respond(res,429,{error:'unavailable'});active++;
    try{
      const timer=setTimeout(()=>req.destroy(),bodyTimeoutMs);timer.unref?.();let input;
      try{input=await body(req)}finally{clearTimeout(timer)}
      if(!exact(input,['expected','nextHead'])||!checkpoint(input.expected)||!head(input.nextHead)||input.nextHead===input.expected.head)
        return respond(res,400,{error:'invalid request'});
      const before=await anchor.read();if(!checkpoint(before)||!same(before,input.expected))return respond(res,409,{error:'conflict'});
      if(await resolveRemoteHead()!==input.nextHead||await audit(before.head,input.nextHead)!==true)return respond(res,409,{error:'unsafe head'});
      const result=await anchor.compareAndSet(input);
      if(!exact(result,['confirmed','head','revision'])||result.confirmed!==true||result.head!==input.nextHead||
         !revision(result.revision)||result.revision===before.revision)throw Error();
      const after=await anchor.read();if(!checkpoint(after)||after.head!==result.head||after.revision!==result.revision)throw Error();
      return respond(res,200,result);
    }catch{return respond(res,503,{error:'unavailable'})}finally{active--}
  });
}
/** Convenience wiring for an independently provisioned monitor checkout. */
export function createGitAuditedSetupCheckpointServer({anchor,repo,branch,remoteUrl,token,allowLocalForTests=false}={}){
  return createIndependentSetupCheckpointServer({anchor,token,audit:createGitWitnessHistoryAudit({repo}),
    resolveRemoteHead:createIndependentGitHeadResolver({repo,branch,remoteUrl,allowLocalForTests})});
}
async function bounded(response){
  const length=response.headers?.get?.('content-length');if(length!==null&&length!==undefined&&(!/^\d+$/.test(length)||Number(length)>4096))throw fail();
  if(!response.body?.getReader)throw fail();const reader=response.body.getReader(),parts=[];let total=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>4096){await reader.cancel();throw fail()}parts.push(value)}}
  finally{reader.releaseLock()}
  const bytes=new Uint8Array(total);let index=0;for(const part of parts){bytes.set(part,index);index+=part.length}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
/** One network request per operation; unknown CAS responses are never retried. */
export function createIndependentSetupCheckpointClient({origin,token,fetch:fetchImpl=globalThis.fetch,timeoutMs=30_000}={}){
  let url;try{url=new URL(origin)}catch{throw fail()}
  if(url.protocol!=='https:'||url.origin!==origin||url.pathname!=='/'||url.username||url.password||url.search||url.hash||!tokenOk(token)||
     typeof fetchImpl!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>60_000)throw fail();
  async function request(route,input){
    try{
      const response=await fetchImpl(`${origin}/v1/${route}`,{method:input?'POST':'GET',redirect:'error',cache:'no-store',
        headers:{authorization:`Bearer ${token}`,...(input?{'content-type':'application/json'}:{})},
        ...(input?{body:JSON.stringify(input)}:{}),signal:AbortSignal.timeout(timeoutMs)});
      const data=await bounded(response);if(!response.ok)throw Error();return data;
    }catch{throw fail()}
  }
  return Object.freeze({
    async read(){const result=await request('head');if(!checkpoint(result))throw fail();return result},
    async compareAndSet({expected,nextHead}={}){
      if(!checkpoint(expected)||!head(nextHead)||nextHead===expected.head)throw fail();
      const result=await request('compare-and-set',{expected,nextHead});
      if(!exact(result,['confirmed','head','revision'])||result.confirmed!==true||result.head!==nextHead||
         !revision(result.revision)||result.revision===expected.revision)throw fail();return result;
    },
  });
}
