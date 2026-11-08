/**
 * Fail-closed compatibility check for the current pinned V9 deployment.
 *
 * Bouncer's pinned Meteor executor (53a8b39...) sends DeployContract bytes as
 * base64 through its mobile-app bridge. That bridge rejects canonical action
 * requests above 400,000 bytes. V9's base64 code alone exceeds that limit,
 * before any other actions or envelope are included. The connector manifest
 * does not tell Bouncer whether this Meteor session uses mobile or web, so the
 * existing large-deploy setup is conservatively stopped for all Meteor sessions.
 * Other wallets and smaller artifacts remain unverified; this does not claim
 * that a request below the limit will work.
 *
 * This check only blocks a known-incompatible new setup. It does not alter or
 * block original-hash inspection, recovery, or a previously retained trial.
 */
export const NATIVE_ORACLE_V9_BYTES = 452_675;
export const METEOR_MOBILE_ACTION_LIMIT_BYTES = 400_000;
export const NATIVE_METEOR_DEPLOY_TOO_LARGE = 'NATIVE_METEOR_DEPLOY_TOO_LARGE';

export function assertNativeOracleWalletDeployAvailable(wallet) {
  const base64Length = 4 * Math.ceil(NATIVE_ORACLE_V9_BYTES / 3);
  if (wallet?.manifest?.id === 'meteor-wallet' && base64Length > METEOR_MOBILE_ACTION_LIMIT_BYTES) {
    throw Object.assign(new Error(NATIVE_METEOR_DEPLOY_TOO_LARGE), { code: NATIVE_METEOR_DEPLOY_TOO_LARGE });
  }
  return undefined; // no compatibility guarantee for any other route
}
