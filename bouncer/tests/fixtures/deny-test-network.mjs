// Preload for safety-only CLI tests: any accidental HTTP request must fail.
import http from 'node:http';
import https from 'node:https';
const deny = () => { throw new Error('unexpected network request in offline test'); };
globalThis.fetch = deny;
http.request = deny; http.get = deny;
https.request = deny; https.get = deny;
