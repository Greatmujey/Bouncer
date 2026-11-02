/** Verify that the public fixed original and retained funding result name the
 * same funded V11/Circle testnet vault. This checks trusted-RPC evidence and
 * signed bytes, not a consensus proof or an off-device owner-key backup. */
import { validateOwnerBootstrapPlan } from './testnet-owner-bootstrap.mjs';
import { verifySignedVaultCircle } from './keyless-vault-circle.mjs';
import { V11_NEAR_CODE_HASH } from './keyless-vault-bootstrap.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
export function verifyTestnetResourceAgentFundingAnchor({ownerPlan,envelope:e,proof:r}={}){
 const owner=validateOwnerBootstrapPlan(ownerPlan);verifySignedVaultCircle(e,owner);
 if(e.kind!=='fund'||e.amount_atoms!=='6907'||r?.status!=='VAULT_FUNDED_CIRCLE_TEST_USDC_AT_FINAL'||
  r.owner!==owner.account_id||r.vault!==e.vault||r.tx_hash!==e.tx_hash||r.receipt?.tx_hash!==e.tx_hash||
  !isTransactionHash(r.receipt?.root_receipt_id)||r.receipt?.funding?.amount_atoms!=='6907'||
  !isTransactionHash(r.receipt?.funding?.vault_hook_receipt)||!isTransactionHash(r.receipt?.funding?.token_resolver_receipt)||
  r.receipt?.funding?.transfer_event_verified!==true||r.receipt?.funding?.full_amount_accepted!==true||
  r.state?.owner!==owner.account_id||r.state?.vault!==e.vault||r.state?.circle_token!==e.token||r.state?.owner_circle_atoms!=='0'||
  r.state?.vault_code_hash!==V11_NEAR_CODE_HASH||r.state?.vault_key_count!==0||r.state?.vault_actual_circle_atoms!=='6907'||
  r.state?.vault_tracked_circle_atoms!=='6907'||r.state?.circle_code_hash!==e.expected_circle_code_hash||
  r.circle_funding_verified!==true||r.do_not_resend!==true)throw new Error('original Circle vault funding is not verified');
 return {owner:owner.account_id,vault:e.vault,tx_hash:e.tx_hash,circle_code_hash:e.expected_circle_code_hash,
  amount_atoms:'6907',do_not_resend:true};
}
