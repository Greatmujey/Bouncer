import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Loopback-only fake backend; no wallet, public network or transaction.
async function unusedPort() {
  const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}
async function startSite(port,backendPort,enabled) {
  const script=fileURLToPath(new URL('../scripts/dev-web.mjs',import.meta.url));
  const child=spawn(process.execPath,[script],{env:{...process.env,PORT:String(port),BOUNCER_READONLY_PREVIEW:enabled?'1':'0',
    BOUNCER_READONLY_PREVIEW_PORT:String(backendPort)},stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{
    let output='';const timer=setTimeout(()=>reject(Error('preview startup timeout')),10_000);
    child.once('exit',code=>{clearTimeout(timer);reject(Error(`preview exited ${code}: ${output}`))});
    child.stderr.on('data',chunk=>{output+=chunk});
    child.stdout.on('data',chunk=>{if(String(chunk).includes('preview listening')){clearTimeout(timer);resolve()}});
  });
  return child;
}
test('native preview routes use the same-origin proxy only when explicitly enabled',async()=>{
  const calls=[];
  const backend=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    calls.push({url:req.url,method:req.method,origin:req.headers.origin,preview:req.headers['x-bouncer-preview'],body:Buffer.concat(chunks).toString()});
    res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end('{"synthetic":true}');
  });
  await new Promise(resolve=>backend.listen(0,'127.0.0.1',resolve));const backendPort=backend.address().port;
  const port=await unusedPort();let child;
  try{
    child=await startSite(port,backendPort,false);
    const url=`http://127.0.0.1:${port}/api/native-oracle-setup/config`;
    assert.equal((await fetch(url)).status,404);assert.equal(calls.length,0);
    child.kill();await new Promise(resolve=>child.once('exit',resolve));child=await startSite(port,backendPort,true);
    const headers={origin:'https://phone.example','x-bouncer-preview':'native-oracle-setup-v1','content-type':'application/json'};
    const response=await fetch(url,{headers});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal((await response.json()).synthetic,true);
    const posted=await fetch(`http://127.0.0.1:${port}/api/native-oracle-setup/claim`,{method:'POST',headers,body:'{"id":"synthetic"}'});
    assert.equal(posted.status,200);assert.deepEqual(calls.map(c=>c.url),['/api/native-oracle-setup/config','/api/native-oracle-setup/claim']);
    assert.equal(calls[1].origin,headers.origin);assert.equal(calls[1].preview,headers['x-bouncer-preview']);
    assert.equal(calls[1].body,'{"id":"synthetic"}');
  }finally{
    if(child && child.exitCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}
    await new Promise(resolve=>backend.close(resolve));
  }
});
