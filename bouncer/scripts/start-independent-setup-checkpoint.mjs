#!/usr/bin/env node
/**
 * Monitor-only bootstrap. This does NOT provision or repair a checkpoint and
 * never prompts/signs/sends a NEAR transaction. Run on an independently
 * controlled host with a separate protected database and a dedicated HTTPS
 * reverse proxy in front of loopback. Do not put secrets in command arguments,
 * repository files or logs. A second independent latest-revision monitor and
 * real operational review remain necessary before using it for wallet prompts.
 */
import fs from 'node:fs';
import pg from 'pg';
import { createPostgresSetupHeadAnchor } from '../agent/postgres-setup-head-anchor.mjs';
import { createGitAuditedSetupCheckpointServer } from '../agent/independent-setup-checkpoint.mjs';

function readSecret(file){
  if(typeof file!=='string'||!file.startsWith('/'))throw Error();let fd;
  try{
    fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||(stat.mode&0o077)!==0||
      (typeof process.getuid==='function'&&stat.uid!==process.getuid())||stat.size<43||stat.size>44)throw Error();
    const bytes=Buffer.alloc(45);try{
      const count=fs.readSync(fd,bytes,0,bytes.length,0);if(count!==stat.size||count>44)throw Error();
      const token=bytes.subarray(0,count).toString('utf8').replace(/\n$/,'');
      if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw Error();return token;
    }finally{bytes.fill(0)}
  }finally{if(fd!==undefined)fs.closeSync(fd)}
}
async function main(){
  if(process.argv.length===3&&process.argv[2]==='--help'){
    console.log('Experimental checkpoint monitor: reads an already provisioned separate database and independently audits the configured Git branch.');
    console.log('Listens on 127.0.0.1 only; place behind authenticated HTTPS. No provisioning, wallet, signature, broadcast or payment.');
    console.log('Configuration: BOUNCER_CHECKPOINT_DATABASE_URL, BOUNCER_CHECKPOINT_TOKEN_FILE, BOUNCER_CHECKPOINT_REPOSITORY,');
    console.log('BOUNCER_CHECKPOINT_BRANCH, BOUNCER_CHECKPOINT_INITIAL_HEAD, BOUNCER_CHECKPOINT_GIT_REPO, BOUNCER_CHECKPOINT_REMOTE_URL, BOUNCER_CHECKPOINT_PORT.');
    return;
  }
  if(process.argv.length!==2)throw Error();
  const e=process.env,url=new URL(e.BOUNCER_CHECKPOINT_DATABASE_URL??'');
  if(!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname||url.hash)throw Error();
  if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&url.searchParams.get('sslmode')!=='verify-full')throw Error();
  const repository=e.BOUNCER_CHECKPOINT_REPOSITORY,branch=e.BOUNCER_CHECKPOINT_BRANCH,initialHead=e.BOUNCER_CHECKPOINT_INITIAL_HEAD,
    repo=e.BOUNCER_CHECKPOINT_GIT_REPO,remoteUrl=e.BOUNCER_CHECKPOINT_REMOTE_URL,token=readSecret(e.BOUNCER_CHECKPOINT_TOKEN_FILE);
  if(typeof repository!=='string'||remoteUrl!==`https://github.com/${repository}.git`)throw Error();
  const port=Number(e.BOUNCER_CHECKPOINT_PORT??'8788');if(!Number.isSafeInteger(port)||port<1||port>65535)throw Error();
  const pool=new pg.Pool({connectionString:url.href,max:6,connectionTimeoutMillis:5000,idleTimeoutMillis:30_000});
  let server;
  try{
    const anchor=createPostgresSetupHeadAnchor({pool,repository,branch,initialHead});
    await anchor.read(); // absent or damaged state is a stop, NEVER bootstrap here
    server=createGitAuditedSetupCheckpointServer({anchor,repo,branch,remoteUrl,token});
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve)});
    console.log(`Independent checkpoint monitor listening on loopback port ${port}; external HTTPS and separate rollback monitoring required.`);
    const shutdown=()=>server.close(()=>{void pool.end().finally(()=>process.exit(0))});
    process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
  }catch(error){if(server)server.close();await pool.end();throw error}
}
main().catch(()=>{console.error('Independent checkpoint monitor unavailable; stop and reconcile. No checkpoint was provisioned or changed.');process.exitCode=1});
