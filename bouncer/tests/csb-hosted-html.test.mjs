import test from 'node:test';
import assert from 'node:assert/strict';
import {CSB_INJECTED_SCRIPTS as tags,htmlOnlyKnownAdditions} from '../scripts/csb-hosted-html.mjs';
const expected='<!doctype html>\n<meta csp="fixed">\n<html><head>\n  <meta charset="utf-8">\n</head><body><p>hello</p>\n</body></html>';
const actual=expected.replace('<meta charset',`${tags[0]}\n  ${tags[1]}\n  <meta charset`).replace('</body>',`${tags[2]}\n</body>`);
test('hosted HTML accepts only the three byte-exact known additions and whitespace',()=>{
  assert.equal(htmlOnlyKnownAdditions(actual,expected),true);
  assert.equal(htmlOnlyKnownAdditions(actual.replace('hello','changed'),expected),false);
  assert.equal(htmlOnlyKnownAdditions(actual+tags[0],expected),false);
  assert.equal(htmlOnlyKnownAdditions(actual.replace(tags[0],tags[0].replace('sse-hooks','other')),expected),false);
  assert.equal(htmlOnlyKnownAdditions(actual.replace(tags[0],''),expected),false);
  assert.equal(htmlOnlyKnownAdditions(actual.replace('</body>','<script>alert(1)</script></body>'),expected),false);
});
