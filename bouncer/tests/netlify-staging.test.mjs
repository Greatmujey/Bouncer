import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PUBLIC_WEB_FILES } from '../scripts/stage-public-web.mjs';
import { stageNetlifyPublicWeb } from '../scripts/stage-netlify-public-web.mjs';

const realRoot = fileURLToPath(new URL('../', import.meta.url));
const opts = {walletOrigin:'https://bouncer-near.netlify.app',walletConnectProjectId:''};
function fixture(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-netlify-stage-'));
  t.after(() => fs.rmSync(tmp,{recursive:true,force:true}));
  const root = path.join(tmp,'project');
  fs.mkdirSync(root); fs.mkdirSync(path.join(root,'web')); fs.mkdirSync(path.join(root,'scripts'));
  for (const name of PUBLIC_WEB_FILES) fs.copyFileSync(path.join(realRoot,'web',name),path.join(root,'web',name));
  for (const name of ['stage-public-web.mjs','stage-netlify-public-web.mjs']) {
    fs.copyFileSync(path.join(realRoot,'scripts',name),path.join(root,'scripts',name));
  }
  return {tmp,root,dist:path.join(root,'dist'),web:path.join(root,'web')};
}
function checkOutput(root,dist) {
  assert.deepEqual(fs.readdirSync(dist).sort(),[...PUBLIC_WEB_FILES].sort());
  assert.match(fs.readFileSync(path.join(dist,'index.html'),'utf8'),/<meta name="bouncer-wallet-origin" content="https:\/\/bouncer-near\.netlify\.app">/);
  assert.deepEqual(fs.readdirSync(root).filter(name=>name.startsWith('.netlify-stage-')),[]);
}

test('Netlify staging replaces a cached dist with only the reviewed files and can run repeatedly',t=>{
  const {root,dist} = fixture(t);
  fs.mkdirSync(dist); fs.writeFileSync(path.join(dist,'stale-private.txt'),'must never be published');
  assert.deepEqual(stageNetlifyPublicWeb(root,opts),[...PUBLIC_WEB_FILES]);
  checkOutput(root,dist);
  fs.writeFileSync(path.join(dist,'stale-after-first-build'),'must be removed');
  assert.deepEqual(stageNetlifyPublicWeb(root,opts),[...PUBLIC_WEB_FILES]);
  checkOutput(root,dist);
});

test('Netlify staging preserves existing output if source or origin validation fails',t=>{
  const {root,dist,web} = fixture(t);
  fs.mkdirSync(dist); fs.writeFileSync(path.join(dist,'keep.txt'),'untouched');
  assert.throws(()=>stageNetlifyPublicWeb(root,{...opts,walletOrigin:'http://not-https.example'}),/dedicated HTTPS/);
  assert.equal(fs.readFileSync(path.join(dist,'keep.txt'),'utf8'),'untouched');
  fs.unlinkSync(path.join(web,'styles.css'));
  assert.throws(()=>stageNetlifyPublicWeb(root,opts));
  assert.equal(fs.readFileSync(path.join(dist,'keep.txt'),'utf8'),'untouched');
  assert.deepEqual(fs.readdirSync(root).filter(name=>name.startsWith('.netlify-stage-')),[]);
});

test('Netlify staging unlinks output symlinks without deleting their targets',t=>{
  const {tmp,root,dist} = fixture(t), outside=path.join(tmp,'outside');
  fs.mkdirSync(outside); fs.writeFileSync(path.join(outside,'keep.txt'),'untouched');
  fs.symlinkSync(outside,dist,'dir');
  stageNetlifyPublicWeb(root,opts);
  checkOutput(root,dist);
  assert.equal(fs.readFileSync(path.join(outside,'keep.txt'),'utf8'),'untouched');
  fs.symlinkSync(outside,path.join(dist,'nested-link'),'dir');
  stageNetlifyPublicWeb(root,opts);
  checkOutput(root,dist);
  assert.equal(fs.readFileSync(path.join(outside,'keep.txt'),'utf8'),'untouched');
});

test('Netlify staging refuses a symlinked project root',t=>{
  const {tmp,root} = fixture(t), link=path.join(tmp,'root-link');
  fs.symlinkSync(root,link,'dir');
  assert.throws(()=>stageNetlifyPublicWeb(link,opts),/Project root must be a real directory/);
  assert.equal(fs.existsSync(path.join(root,'dist')),false);
});

test('Netlify config invokes the replacement helper and the CLI handles an existing dist',t=>{
  const config=fs.readFileSync(path.join(realRoot,'..','netlify.toml'),'utf8');
  assert.match(config,/publish\s*=\s*"dist"/);
  assert.match(config,/npm run build:web && node scripts\/stage-netlify-public-web\.mjs/);
  const {root,dist} = fixture(t);
  fs.mkdirSync(dist); fs.writeFileSync(path.join(dist,'from-build-cache.txt'),'stale');
  const env={...process.env,NETLIFY:'true',URL:opts.walletOrigin};
  delete env.BOUNCER_WALLET_ORIGIN; delete env.BOUNCER_WALLETCONNECT_PROJECT_ID;
  const output=execFileSync(process.execPath,[path.join(root,'scripts','stage-netlify-public-web.mjs')],{cwd:os.tmpdir(),env,encoding:'utf8'});
  assert.match(output,/Replaced Netlify dist with 19 reviewed public website files/);
  checkOutput(root,dist);
});
