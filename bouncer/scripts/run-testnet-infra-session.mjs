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
import { initializePostgresWalletPromptAuth,inspectPostgresWalletPromptAuthSchema } from '../agent/postgres-wallet-prompt-auth.mjs';
import { initializePostgresWalletPromptFence,inspectPostgresWalletPromptFenceSchema } from '../agent/postgres-wallet-prompt-fence.mjs';
import { initializePostgresNativeOraclePromptFence,inspectPostgresNativeOraclePromptFenceSchema } from '../agent/postgres-native-oracle-prompt-fence.mjs';
import { provisionPostgresSetupHeadAnchor,createPostgresSetupHeadAnchor } from '../agent/postgres-setup-head-anchor.mjs';
import { createGitWitnessRangeAudit } from '../agent/git-witness-range-audit.mjs';
import { waitForTestnetInfraActivation } from '../agent/testnet-infra-activation.mjs';

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
  // Supavisor may briefly cache a previous SCRAM verifier after rotation. Only
  // bounded, read-only connection handshakes are repeated, never wallet calls.
  for(let attempt=0;attempt<3;attempt++){
    let sawAuthenticationFailure=false;
    for(const host of testnetPoolerHosts(ROLE,config)){
      const pool=new pg.Pool({host,port:5432,database:'postgres',user:username,password,ssl:testnetPoolerSsl(),
        max:6,connectionTimeoutMillis:8_000,idleTimeoutMillis:20_000});
      try{
        const result=await pool.query('SELECT current_user AS role, current_database() AS database');
        if(result.rows.length!==1 || result.rows[0].role!==`bouncer_${ROLE}` || result.rows[0].database!=='postgres')throw failed();
        console.log(`Verified TLS and the dedicated ${ROLE} database role.`);
        return pool;
      }catch(error){
        // Report only fixed categories, never driver messages or credentials.
        const code=typeof error?.code==='string' ? error.code : '';
        const category=code==='28P01' ? 'authentication' :
          (code==='XX000' && /tenant or user not found/i.test(error?.message??'')) ? 'pooler-tenant' :
          ['ECONNREFUSED','ETIMEDOUT','ENOTFOUND','EHOSTUNREACH','ECONNRESET'].includes(code) ? 'network' :
          /CERT|TLS|SSL/i.test(code) ? 'tls' : 'other';
        if(category==='authentication')sawAuthenticationFailure=true;
        console.log(`::warning title=Testnet ${ROLE} database connection::${host.split('.')[0]} ${category}`);
        await pool.end().catch(()=>{});
      }
    }
    if(!sawAuthenticationFailure || attempt===2)break;
    await delay(20_000);
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
    let initialHead=baseline;
    if(config.mode==='provision-only'){
      phase='database-empty-check';
      // Fresh provisioning is permitted only once, never as implicit repair.
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
    }else{
      // A resume is strictly limited to a verified, prompt-free provisioning
      // session. Existing schemas are inspected, never recreated or repaired.
      phase='resume-status';
      initialHead=config.resume_from.initial_head;
      const status=await pool.query('SELECT role,run_id,baseline,phase FROM bouncer_testnet_infra_v1.status');
      const row=status.rows[0];
      if(status.rows.length!==1 || row.role!==ROLE || row.run_id!==config.resume_from.run_id ||
          row.baseline!==initialHead || row.phase!=='PROVISIONED_NO_WALLET')throw failed();
      if(ROLE==='coordinator'){
        phase='resume-schema-check';
        await inspectPostgresWalletPromptAuthSchema({pool});
        await inspectPostgresWalletPromptFenceSchema({pool});
        await inspectPostgresNativeOraclePromptFenceSchema({pool});
        const count=await pool.query(`SELECT
          (SELECT count(*) FROM bouncer_wallet_auth_v1.challenges) AS challenges,
          (SELECT count(*) FROM bouncer_wallet_owner_fence_v1.holders) AS holders,
          (SELECT count(*) FROM bouncer_wallet_prompt_v1.prompts) AS prompts,
          (SELECT count(*) FROM bouncer_wallet_prompt_v1.claims) AS claims,
          (SELECT count(*) FROM bouncer_wallet_prompt_v1.setup_stages) AS wallet_stages,
          (SELECT count(*) FROM bouncer_native_wallet_prompt_v1.plans) AS plans,
          (SELECT count(*) FROM bouncer_native_wallet_prompt_v1.stages) AS native_stages`);
        if(count.rows.length!==1 || Object.values(count.rows[0]).some(value=>value!=='0'))throw failed();
      }else{
        phase='resume-checkpoint';
        const anchor=createPostgresSetupHeadAnchor({pool,repository:'Greatmujey/Bouncer',branch:BRANCH,initialHead});
        const before=await anchor.read();
        if(before.head!==initialHead || before.revision!=='0' || baseline===initialHead ||
           await createGitWitnessRangeAudit({repo:REPO})(initialHead,baseline)!==true)throw failed();
        // One attempt only. A lost acknowledgement is a stop, not a retry.
        const advanced=await anchor.compareAndSet({expected:before,nextHead:baseline});
        const after=await anchor.read();
        if(advanced.confirmed!==true || advanced.head!==baseline || after.head!==baseline || after.revision!==advanced.revision)throw failed();
      }
      phase='resume-status-advance';
      const changed=await pool.query(`UPDATE bouncer_testnet_infra_v1.status SET run_id=$1,baseline=$2
        WHERE role=$3 AND run_id=$4 AND baseline=$5 AND phase='PROVISIONED_NO_WALLET'`,
        [RUN,baseline,ROLE,config.resume_from.run_id,initialHead]);
      if(changed.rowCount!==1)throw failed();
    }
    fs.writeFileSync(path.join(directory,'baseline'),baseline,{mode:0o600,flag:'wx'});
    fs.writeFileSync(path.join(directory,'initial-head'),initialHead,{mode:0o600,flag:'wx'});
    console.log(`The ${ROLE} testnet database was provisioned or inspected; no wallet prompt is enabled.`);
    // Keep the runner-local password and key available for a separate, explicit
    // activation instruction. This loop never creates an instruction itself.
    const serveFile=`bouncer/infrastructure/session-${RUN}-serve.json`;
    const activated=await waitForTestnetInfraActivation({runId:RUN,deadline:Date.now()+25*60_000,
      readControl:()=>{git(['fetch','--quiet','--no-tags','origin',BRANCH]);
        return JSON.parse(git(['show',`refs/remotes/origin/${BRANCH}:${serveFile}`]))},
      wait:()=>delay(5_000),activate:()=>{
        phase='activation';
        git(['pull','--ff-only','--quiet','origin',BRANCH]);
        const launched=spawnSync(process.execPath,['bouncer/scripts/serve-testnet-infra-session.mjs',serveFile],
          {cwd:REPO,env:{...process.env,BOUNCER_INFRA_BASELINE:baseline,BOUNCER_INFRA_INITIAL_HEAD:initialHead},
            stdio:'inherit',timeout:20*60_000});
        if(launched.error || launched.signal || launched.status!==0)throw failed();
      }});
    if(!activated)console.log('No separate activation instruction was received; no wallet prompt was enabled.');
  }finally{await pool.end().catch(()=>{})}
}
main().catch(()=>{console.error(`::error title=Testnet infrastructure stopped::${ROLE ?? 'unknown'} phase=${phase}; no wallet or transaction was authorized.`);process.exitCode=1});
