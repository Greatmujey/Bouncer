import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createRailwayNativeStandby,STANDBY_STATUS} from '../scripts/start-railway-native.mjs';
import {createRailwayStandbyWeb,RAILWAY_WEB_ORIGIN} from '../agent/railway-standby-web.mjs';

const host=new URL(RAILWAY_WEB_ORIGIN).host;
const request=(server,path,{method='GET',headers={}}={})=>new Promise((resolve,reject)=>{
  const req=http.request({host:'127.0.0.1',port:server.address().port,path,method,headers},res=>{
    const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));
  });req.on('error',reject);req.end();
});

test('Railway hosts only the public workspace at its exact dedicated host; backend remains standby',async()=>{
  const server=createRailwayNativeStandby({webHandler:createRailwayStandbyWeb()});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const page=await request(server,'/workspace',{headers:{host,'x-forwarded-proto':'https'}});
    assert.equal(page.status,200);assert.match(page.headers['content-type'],/^text\/html/);
    assert.match(page.body,/Temporary Railway testnet site/);
    assert.ok(page.body.includes(`name="bouncer-wallet-origin" content="${RAILWAY_WEB_ORIGIN}"`));
    assert.match(page.body,/Vault setup and Bouncer missions are not enabled/);
    assert.equal(page.headers['x-content-type-options'],'nosniff');
    assert.match(page.headers['content-security-policy'],/object-src 'none'/);
    assert.equal((await request(server,'/workspace',{headers:{host:'attacker.example'}})).status,421);
    assert.equal((await request(server,'/workspace',{headers:{host,'x-forwarded-proto':'http'}})).status,421);
    assert.equal((await request(server,'/workspace',{method:'POST',headers:{host}})).status,405);
    for(const asset of ['/styles.css?v=18','/wallet.bundle.js?v=38','/app.mjs?v=7'])
      assert.equal((await request(server,asset,{headers:{host}})).status,200);
    const artifact=await request(server,'/v14-bootstrap-artifact-v1.json',{headers:{host}});
    assert.equal(artifact.status,200);assert.match(artifact.headers['content-type'],/^application\/json/);
    assert.equal(JSON.parse(artifact.body).format,'bouncer-v14-compressed-artifact-v1');
    const health=await request(server,'/healthz',{headers:{host}});
    assert.deepEqual(JSON.parse(health.body),STANDBY_STATUS);
    for(const hidden of ['/api/native-mission/config','/api/native-mission/execute','/.env','/artifacts/v14-research-loader.wasm','/artifacts/v14-research.deflate'])
      assert.equal((await request(server,hidden,{headers:{host}})).status,404);
  } finally {await new Promise(resolve=>server.close(resolve))}
});
