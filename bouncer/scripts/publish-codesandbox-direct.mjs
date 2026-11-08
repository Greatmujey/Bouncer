// Publish only the reviewed, public website to a fresh anonymous static
// sandbox. No journal capability, wallet key, account session, or transaction
// is included. The exact hosted bytes must be checked before any link is used.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {PUBLIC_WEB_FILES,validatePublicWeb} from './stage-public-web.mjs';
const root=fileURLToPath(new URL('../web/',import.meta.url));
validatePublicWeb(root);
const binary=new Set(['hero-orbit.jpg','manrope-latin.woff2','intear-wallet-source.zip']);
const files={};
for(const name of PUBLIC_WEB_FILES){if(!binary.has(name))files[name]={content:fs.readFileSync(path.join(root,name),'utf8'),isBinary:false};}
const data=(name,mime)=>`data:${mime};base64,${fs.readFileSync(path.join(root,name)).toString('base64')}`;
function replaceOnce(text,from,to){assert.equal(text.split(from).length,2);return text.replace(from,to);}
files['styles.css'].content=replaceOnce(files['styles.css'].content,"url('./hero-orbit.jpg?v=4')",`url('${data('hero-orbit.jpg','image/jpeg')}')`);
files['styles.css'].content=replaceOnce(files['styles.css'].content,"url('./manrope-latin.woff2')",`url('${data('manrope-latin.woff2','font/woff2')}')`);
files['index.html'].content=replaceOnce(files['index.html'].content,
  '<link rel="preload" href="./manrope-latin.woff2" as="font" type="font/woff2" crossorigin>',
  '<meta name="referrer" content="no-referrer">');
files['index.html'].content=replaceOnce(files['index.html'].content,'href="./intear-wallet-source.zip"',
  `download="intear-wallet-source.zip" href="${data('intear-wallet-source.zip','application/zip')}"`);
files['sandbox.config.json']={content:'{"template":"static"}',isBinary:false};
const response=await fetch('https://codesandbox.io/api/v1/sandboxes/define?json=1',{
  method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify({files}),
  signal:AbortSignal.timeout(60000)});
if(!response.ok)throw Error(`Sandbox publish failed: HTTP ${response.status}`);
const {sandbox_id:id}=await response.json();assert.match(id,/^[a-z0-9]{4,20}$/);
console.log(`::notice title=Public Bouncer candidate (no capability)::${id}`);
if(process.env.BOUNCER_CSB_ID_FILE)fs.writeFileSync(process.env.BOUNCER_CSB_ID_FILE,id,{flag:'wx'});
const metaResponse=await fetch(`https://codesandbox.io/api/v1/sandboxes/${id}`,{signal:AbortSignal.timeout(30000)});
const meta=await metaResponse.json();assert.equal(meta.data?.authorization,'read');assert.equal(meta.data?.template,'static');
assert.equal(meta.data?.owned,false);console.log(`Anonymous API authorization: ${meta.data.authorization}; draft: ${meta.data.draft}`);
const origin=`https://${id}.csb.app`,digest=s=>createHash('sha256').update(s).digest('hex');
let exact=true;
for(const name of Object.keys(files).filter(x=>x!=='sandbox.config.json')){
  const url=name==='index.html'?`${origin}/`:`${origin}/${name}`;
  const asset=await fetch(url,{signal:AbortSignal.timeout(60000)});const actual=await asset.text(),expected=files[name].content;
  if(!asset.ok || actual!==expected){
    exact=false;let at=0;while(at<Math.min(actual.length,expected.length)&&actual[at]===expected[at])at++;
    console.log(`Mismatch ${name}: HTTP ${asset.status}, expected ${expected.length}/${digest(expected)}, actual ${actual.length}/${digest(actual)}, first difference ${at}`);
    if(name==='index.html')console.log(`Hosted HTML scripts: ${JSON.stringify([...actual.matchAll(/<script\b[^>]*>/gi)].map(m=>m[0]))}`);
  }
}
const rpc=await fetch('https://rpc.testnet.near.org',{method:'POST',headers:{origin,'content-type':'application/json'},
  body:JSON.stringify({jsonrpc:'2.0',id:'candidate-cors-check',method:'status',params:[]}),signal:AbortSignal.timeout(20000)});
const cors=rpc.headers.get('access-control-allow-origin'),json=await rpc.json();
assert.ok(rpc.ok&&(cors==='*'||cors===origin)&&json?.result?.chain_id==='testnet');
console.log(`Exact public website assets: ${exact}; read-only testnet RPC CORS: true. No wallet or transaction.`);
if(!exact)process.exitCode=1;
