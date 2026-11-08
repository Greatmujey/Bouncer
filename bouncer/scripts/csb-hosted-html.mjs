// The only third-party additions allowed in a temporary CodeSandbox response.
// A CSP parsed before <head> must prevent their execution in a real browser.
export const CSB_NONCE='Qm91bmNlclRlc3RuZXQyMDI2';
export const CSB_INJECTED_SCRIPTS=Object.freeze([
  '<script  type="text/javascript" src="https://codesandbox.io/public/sse-hooks/sse-hooks.e15ace8ccace5398a721ffec81f121de.js"></script>',
  '<script  type="text/javascript" src="https://codesandbox.io/static/js/banner.d9cb10a38.js"></script>',
  '<script crossorigin type="text/javascript" src="https://codesandbox.io/static/js/watermark-button.eeb14a97b.js"></script>',
]);
export function htmlOnlyKnownAdditions(actual,expected){
  let i=0,j=0,afterAddition=false;const counts=Array(CSB_INJECTED_SCRIPTS.length).fill(0);
  while(i<expected.length || j<actual.length){
    const index=CSB_INJECTED_SCRIPTS.findIndex(s=>actual.startsWith(s,j));
    if(index>=0){counts[index]++;j+=CSB_INJECTED_SCRIPTS[index].length;afterAddition=true;continue}
    if(i<expected.length&&j<actual.length&&expected[i]===actual[j]){
      if(!/\s/.test(actual[j]))afterAddition=false;i++;j++;continue;
    }
    if(j<actual.length&&/\s/.test(actual[j])){
      let end=j;while(end<actual.length&&/\s/.test(actual[end]))end++;
      if(afterAddition||CSB_INJECTED_SCRIPTS.some(s=>actual.startsWith(s,end))){j++;continue}
    }
    return false;
  }
  return counts.every(n=>n===1);
}
