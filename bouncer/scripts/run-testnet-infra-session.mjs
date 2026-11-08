#!/usr/bin/env node
/**
 * One explicitly requested, infrastructure-only testnet provisioning run.
 * Two separate GitHub runners connect over verified TLS to different dedicated
 * free Supabase projects, using independent runner-local database passwords.
 * The coordinator provisions prompt-fence schemas; the checkpoint provisions
 * its append-only head only after independently auditing the Git baseline.
 *
 * Neither side enables the wallet UI, signs, broadcasts, or authorizes a NEAR
 * transaction. Loss/rollback or uncertain acknowledgement is a hard stop.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { validateTestnetInfraConfig,testnetPoolerHosts,testnetPoolerSsl,deriveTestnetCheckpointToken } from '../agent/testnet-infra-session-config.mjs';
import { auditFullGitWitnessHistory } from '../agent/full-git-witness-history-audit.mjs';
import { initializePostgresWalletPromptAuth } from '../agent/postgres-wallet-prompt-auth.mjs';
import { initializePostgresWalletPromptFence } from '../agent/postgres-wallet-prompt-fence.mjs';
import { initializePostgresNativeOraclePromptFence } from '../agent/postgres-native-oracle-prompt-fence.mjs';
import { provisionPostgresSetupHeadAnchor } from '../agent/postgres-setup-head-anchor.mjs';

const ROLE=process.env.BOUNCER_INFRA_ROLE, RUN=process.env.GITHUB_RUN_ID, BRANCH=process.env.GITHUB_REF_NAME;
const REPO=process.env.GITHUB_WORKSPACE, TEMP=process.env.RUNNER_TEMP;
let phase = 'configuration';
const failed=()=>new Error('testnet infrastructure provisioning is unavailable or uncertain; stop and reconcile; no wallet action is authorized');
function git(args) {
  try{return execFileSync('git',args,{cwd:REPO,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30_000,
    env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1'}}).trim()}
  catch{throw failed()}
}
function readProtected(file) {
  const s=fs.lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink() || (s.mode & 0o077)!==0 || s.nlink!==1 || s.size>2048) throw failed();
  return fs.readFileSync(file,'utf8');
}
async function connect(config,password){
  const project=config.projects[ROLE], username=`bouncer_${ROLE}.${project.ref}`;
  for(const host of testnetPoolerHosts(ROLE,config)){
    const pool=new pg.Pool({host,port:5432,database:'postgres',user:username,password,ssl:testnetPoolerSsl(),
      max:6,connectionTimeoutMillis:8_000,idleTimeoutMillis:20_000});
    try{
      const result=await pool.query('SELECT current_user AS role, current_database() AS database');
      if(result.rows.length!==1 || result.rows[0].role!==`bouncer_${ROLE}` || result.rows[0].database!=='postgres')throw failed();
      console.log(`Verified TLS and the dedicated ${ROLE} database role.`);
      return pool;
    }catch(error){
      // Report only a fixed category, never an exception message, connection
      // string, password, token or arbitrary database response.
      const code=typeof error?.code==='string' ? error.code : '';
      const category=code==='28P01' ? 'authentication' :
        (code==='XX000' && /tenant or user not found/i.test(error?.message??'')) ? 'pooler-tenant' :
        ['ECONNREFUSED','ETIMEDOUT','ENOTFOUND','EHOSTUNREACH','ECONNRESET'].includes(code) ? 'network' :
        /CERT|TLS|SSL/i.test(code) ? 'tls' : 'other';
      console.log(`::warning title=Testnet ${ROLE} database connection::${host.split('.')[0]} ${category}`);
      await pool.end().catch(()=>{});
    }
  }
  throw failed();
}
async function main(){
  if(!['coordinator','checkpoint'].includes(ROLE) || !/^[1-9][0-9]{0,19}$/.test(RUN??'') ||
      BRANCH!=='arena/0e4386ea-near-hub' || !path.isAbsolute(REPO??'') || !path.isAbsolute(TEMP??'') ||
      process.argv.length!==3 || process.argv[2]!==`bouncer/infrastructure/session-${RUN}.json`)throw failed();
  const config=validateTestnetInfraConfig(JSON.parse(fs.readFileSync(path.join(REPO,process.argv[2]),'utf8')),RUN);
  phase='session-keys';
  const directory=path.join(TEMP,`bouncer-testnet-infra-${ROLE}`), password=readProtected(path.join(directory,'postgres-password'));
  if(!/^[A-Za-z0-9_-]{43}$/.test(password))throw failed();
  const token=deriveTestnetCheckpointToken({role:ROLE,config,privateKey:readProtected(path.join(directory,'session-key.pem'))});
  const tokenFile=path.join(directory,'checkpoint-token');
  fs.writeFileSync(tokenFile,token,{mode:0o600,flag:'wx'});
  phase='checkout';
  if(git(['branch','--show-current'])!==BRANCH || git(['rev-parse','--is-shallow-repository'])!=='false' ||
     git(['status','--porcelain','--untracked-files=normal']))throw failed();
  const baseline=git(['rev-parse','HEAD']);
  if(!/^[a-f0-9]{40}$/.test(baseline) || git(['ls-remote','--heads','origin',`refs/heads/${BRANCH}`])!==`${baseline}\trefs/heads/${BRANCH}`)throw failed();
  phase='witness-history';
  await auditFullGitWitnessHistory({repo:REPO,head:baseline});
  phase='owner-witness-check';
  const ownerHash=crypto.createHash('sha256').update('great_mujey.testnet').digest('hex');
  for(const folder of ['wallet-prompt-witness-v1','native-oracle-prompt-witness-v1','buffer-order-witness-v1']){
    if(git(['ls-tree','--name-only',baseline,'--',`bouncer/evidence/${folder}/${ownerHash}.jsonl`]))throw failed();
  }
  if(git(['ls-remote','--heads','origin',`refs/heads/${BRANCH}`])!==`${baseline}\trefs/heads/${BRANCH}`)throw failed();
  phase='database-connect';
  const pool=await connect(config,password);
  try{
    phase='database-empty-check';
    // Each database is new and dedicated. Refuse implicit repair or reuse.
    const existing=await pool.query(`SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname = ANY($1::text[])`,
      [['bouncer_testnet_infra_v1','bouncer_wallet_auth_v1','bouncer_wallet_owner_fence_v1','bouncer_wallet_prompt_v1',
        'bouncer_native_wallet_prompt_v1','bouncer_setup_head_anchor_v1']]);
    if(existing.rows.length)throw failed();
    phase='database-provision';
    if(ROLE==='coordinator'){
      await initializePostgresWalletPromptAuth({pool});
      await initializePostgresWalletPromptFence({pool});
      await initializePostgresNativeOraclePromptFence({pool});
    } else {
      await provisionPostgresSetupHeadAnchor({pool,repository:'Greatmujey/Bouncer',branch:BRANCH,initialHead:baseline,
        operatorVerifiedCompleteBaseline:true});
    }
    phase='status-record';
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      await client.query(`CREATE SCHEMA bouncer_testnet_infra_v1;
        CREATE TABLE bouncer_testnet_infra_v1.status(role text PRIMARY KEY,run_id text NOT NULL,baseline text NOT NULL,phase text NOT NULL);
        GRANT USAGE ON SCHEMA bouncer_testnet_infra_v1 TO postgres;
        GRANT SELECT ON bouncer_testnet_infra_v1.status TO postgres`);
      await client.query(`INSERT INTO bouncer_testnet_infra_v1.status(role,run_id,baseline,phase) VALUES($1,$2,$3,'PROVISIONED_NO_WALLET')`,
        [ROLE,RUN,baseline]);
      await client.query('COMMIT');
    }catch(e){try{await client.query('ROLLBACK')}catch{}throw e}finally{client.release()}
    fs.writeFileSync(path.join(directory,'baseline'),baseline,{mode:0o600,flag:'wx'});
    console.log(`The ${ROLE} testnet database was provisioned; no wallet prompt is enabled.`);
    // Keep the runner-local password and key available for a separate, explicit
    // activation instruction. This loop never creates an instruction itself.
    const serveFile=`bouncer/infrastructure/session-${RUN}-serve.json`, deadline=Date.now()+25*60_000;
    while(Date.now()<deadline){
      try{
        git(['fetch','--quiet','--no-tags','origin',BRANCH]);
        const control=JSON.parse(git(['show',`refs/remotes/origin/${BRANCH}:${serveFile}`]));
        if(control?.version===1 && control.run_id===RUN && control.mode==='serve-testnet'){
          // Do not retry after this point, including a lost acknowledgement.
          git(['pull','--ff-only','--quiet','origin',BRANCH]);
          const launched=spawnSync(process.execPath,['bouncer/scripts/serve-testnet-infra-session.mjs',serveFile],
            {cwd:REPO,env:{...process.env,BOUNCER_INFRA_BASELINE:baseline},stdio:'inherit',timeout:20*60_000});
          if(launched.error || launched.signal || launched.status!==0)throw failed();
          return;
        }
      }catch(e){
        if(e?.message==='testnet infrastructure provisioning is unavailable or uncertain; stop and reconcile; no wallet action is authorized')throw e;
        // Missing future instruction is not an approval.
      }
      await delay(5_000);
    }
    console.log('No separate activation instruction was received; no wallet prompt was enabled.');
  }finally{await pool.end().catch(()=>{})}
}
main().catch(()=>{console.error(`::error title=Testnet infrastructure stopped::${ROLE ?? 'unknown'} phase=${phase}; no wallet or transaction was authorized.`);process.exitCode=1});
