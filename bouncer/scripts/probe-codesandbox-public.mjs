// Creates only an innocuous public test page. Never includes project files,
// credentials, account details, wallet code, or transactions.
import fs from 'node:fs';

const files={
  'index.html':{content:'<!doctype html><meta charset="utf-8"><title>Bouncer hosting probe</title><p id="result">Public hosting test; no wallet.</p><script src="/probe.js"></script>',isBinary:false},
  'probe.js':{content:'document.documentElement.dataset.hostingProbe="ok";',isBinary:false},
  'sandbox.config.json':{content:'{"template":"static"}',isBinary:false},
};
const report={defined:false,id:null,root_status:null,html_matches:false,script_status:null,script_matches:false,
  rpc_cors:false,signed:false,transaction_sent:false};
let error;
try {
  const response=await fetch('https://codesandbox.io/api/v1/sandboxes/define?json=1',{
    method:'POST',headers:{'content-type':'application/json','accept':'application/json'},
    body:JSON.stringify({files}),signal:AbortSignal.timeout(45000),
  });
  if(!response.ok)throw Error(`Define API HTTP ${response.status}`);
  const json=await response.json();
  if(!/^[a-z0-9]{4,20}$/i.test(json?.sandbox_id || ''))throw Error('Invalid sandbox identifier');
  report.id=json.sandbox_id;report.defined=true;
  // This ID is a public identifier, not a credential. Record it before trying
  // the standalone host so an independent reader can also inspect it.
  console.log(`::notice title=Public harmless CodeSandbox probe ID::${report.id}`);
  const origin=`https://${report.id}.csb.app`;
  const html=await fetch(`${origin}/`,{signal:AbortSignal.timeout(45000)});
  report.root_status=html.status;const body=await html.text();
  report.html_matches=html.ok && body.includes('Bouncer hosting probe') && body.includes('/probe.js');
  const js=await fetch(`${origin}/probe.js`,{signal:AbortSignal.timeout(45000)});
  report.script_status=js.status;report.script_matches=js.ok && (await js.text()).includes('hostingProbe');
  const rpc=await fetch('https://rpc.testnet.near.org',{
    method:'POST',headers:{'content-type':'application/json',origin},
    body:JSON.stringify({jsonrpc:'2.0',id:'public-cors-probe',method:'status',params:[]}),signal:AbortSignal.timeout(20000),
  });
  const cors=rpc.headers.get('access-control-allow-origin');
  const result=await rpc.json();
  report.rpc_cors=rpc.ok && (cors==='*'||cors===origin) && result?.result?.chain_id==='testnet';
} catch(e) {error=e?.message || 'probe failed';}
const result={...report,error};
console.log(`::notice title=Public CodeSandbox hosting probe::${JSON.stringify(result).replaceAll('%','%25').replaceAll('\n','%0A').replaceAll('\r','%0D')}`);
if(process.env.GITHUB_STEP_SUMMARY)fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,`\n## Public hosting probe\n\nHarmless page only; no wallet or transaction.\n\n\`\`\`json\n${JSON.stringify(result,null,2)}\n\`\`\`\n`);
if(error || !report.html_matches || !report.script_matches || !report.rpc_cors)process.exitCode=1;
