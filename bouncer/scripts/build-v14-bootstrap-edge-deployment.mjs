#!/usr/bin/env node
/** Rebuild the self-contained, default-off Supabase Edge entry from reviewed
 * source. It contains no secrets. Deployment is a separate manual operation;
 * building this file neither changes the feature flag nor sends transactions.
 * The gzip/data URL is packaging for the server runtime, NOT the disabled
 * on-chain V14 research loader. */
import {build} from 'esbuild';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const directory=fileURLToPath(new URL('../',import.meta.url));
const output=process.argv[2];
if(!output||process.argv.length!==3)throw new Error('Usage: node scripts/build-v14-bootstrap-edge-deployment.mjs OUTPUT_FILE');
const result=await build({absWorkingDir:directory,entryPoints:['infrastructure/v14-bootstrap-checkpoint-edge.mjs'],
  outfile:'v14-bootstrap-edge.mjs',bundle:true,format:'esm',platform:'neutral',target:'es2022',minify:true,write:false});
if(result.outputFiles.length!==1)throw new Error('unexpected Edge build output');
const source=result.outputFiles[0].contents,digest=createHash('sha256').update(source).digest('hex');
const packed=gzipSync(source,{level:9,mtime:0}).toString('base64');
const wrapper=`// Self-contained pinned default-off V14 bootstrap checkpoint; server packaging only.\n`+
  `const packed = Uint8Array.from(atob('${packed}'), c => c.charCodeAt(0));\n`+
  `const stream = new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip'));\n`+
  `const source = new Uint8Array(await new Response(stream).arrayBuffer());\n`+
  `const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', source)), n => n.toString(16).padStart(2, '0')).join('');\n`+
  `if (digest !== '${digest}') throw new Error('Pinned Edge bundle mismatch');\n`+
  `await import('data:text/javascript;base64,' + btoa(String.fromCharCode(...source)));\n`;
await writeFile(output,wrapper,{flag:'wx',mode:0o600});
console.log(JSON.stringify({bundle_sha256:digest,bundle_bytes:source.length,wrapper_bytes:Buffer.byteLength(wrapper),
  path:output,feature_enabled:false,transaction_sent:false}));
