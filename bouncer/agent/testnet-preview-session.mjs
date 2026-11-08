/** Strict, public-only metadata for a temporary testnet preview. A tunnel
 * address or instruction is not wallet approval or a transaction record. */
const originPattern=/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$/;
export function isQuickTunnelOrigin(value){return typeof value==='string' && originPattern.test(value)}
export function findQuickTunnelOrigin(log){
  if(typeof log!=='string' || log.length>131072)throw Error('invalid tunnel log');
  const matches=[...new Set(log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com(?![a-zA-Z0-9.:-])/g)??[])].filter(isQuickTunnelOrigin);
  if(matches.length>1)throw Error('ambiguous tunnel origin');
  return matches[0]??null;
}
export function validatePreviewEndpoints(value,runId,siteOrigin){
  if(!value || Object.getPrototypeOf(value)!==Object.prototype ||
     Object.keys(value).sort().join(',')!=='checkpoint_origin,mode,run_id,site_origin,version' || value.version!==1 ||
     value.run_id!==runId || value.mode!=='connect-testnet-preview' || !isQuickTunnelOrigin(value.site_origin) ||
     !isQuickTunnelOrigin(value.checkpoint_origin) || value.site_origin!==siteOrigin || value.site_origin===value.checkpoint_origin) {
    throw Error('invalid preview endpoints');
  }
  return value;
}
/** The preview's server-side RPC is direct and read-only. Its legacy relay
 * bridge never receives work or accepts results and cannot authorize anything. */
export function emptyReadOnlyBridge(){
  return Object.freeze({pending:()=>[],take:()=>null,submit:()=>false,takeForBrowser:()=>null,submitEncrypted:()=>false});
}
