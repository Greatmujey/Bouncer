// Test-only emulation of the pinned Meteor mobile adapter; no wallet or send.
import nearConnect from '@hot-labs/near-connect';
import { act_impl_near } from '@meteorwallet/connect-shared/internal';

export function syntheticV14MeteorRequest(batch) {
  const actions=nearConnect.nearActionsToConnectorActions(batch.actions).map(action=>{
    if(action.type==='CreateAccount')return {...action,params:{}};
    if(action.type==='DeployContract')return {...action,params:{...action.params,
      code:Buffer.from(action.params.code).toString('base64'),codeEncoding:'base64'}};
    if(action.type==='FunctionCall' && action.params.args instanceof Uint8Array)return {...action,params:{...action.params,
      args:Buffer.from(action.params.args).toString('base64'),argsEncoding:'base64'}};
    return action;
  });
  return act_impl_near.action.sign_and_send_transaction.request({network:'testnet',signerId:batch.signerId,
    receiverId:batch.receiverId,actions}).toJsonObject();
}
