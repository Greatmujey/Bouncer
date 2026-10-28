/**
 * Check the FINAL response from a trusted NEAR RPC. FINAL is requested by the
 * caller; require the node to report it rather than treating an optimistic or
 * incomplete response as a completed payment. This is not a light-client
 * proof and assumes the configured RPC, contract and token are trustworthy.
 */
export function assertFinalPaymentReceipts(result, token) {
  if (result?.final_execution_status !== 'FINAL') throw new Error('transaction did not report FINAL execution');
  if (result.status?.Failure !== undefined) throw new Error('transaction failed');
  if (typeof result.status?.SuccessValue !== 'string') throw new Error('transaction did not return a successful final status');
  if (!Array.isArray(result.receipts_outcome) || result.receipts_outcome.length === 0) throw new Error('no transaction receipt outcomes returned');
  const isSuccess = status => status && typeof status === 'object' && !Array.isArray(status) &&
    status.Failure === undefined && typeof status.SuccessValue === 'string' && status.SuccessReceiptId === undefined;
  const isForward = status => status && typeof status === 'object' && !Array.isArray(status) &&
    status.Failure === undefined && status.SuccessValue === undefined &&
    typeof status.SuccessReceiptId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(status.SuccessReceiptId);
  if (result.receipts_outcome.some(receipt => !isSuccess(receipt?.outcome?.status) && !isForward(receipt?.outcome?.status))) {
    throw new Error('transaction contains a failed, unknown or incomplete receipt');
  }
  if (!result.receipts_outcome.some(receipt => receipt.outcome?.executor_id === token && isSuccess(receipt.outcome.status))) {
    throw new Error('no successful receipt from the expected token contract');
  }
}
