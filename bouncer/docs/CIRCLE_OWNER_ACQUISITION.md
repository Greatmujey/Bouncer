# Bounded owner acquisition of Circle test USDC

This is **testnet owner setup**, not an agent purchase. The objective is to
convert at most **0.01 test NEAR** into Circle test USDC using `wrap.testnet`
and the reviewed Ref testnet pools `1845` or `2206`. No mainnet, real money,
provider endpoint or live seller is involved. The owner remains a plain account;
no keyless vault is deployed or funded by these actions.

The [read-only snapshot](https://github.com/Greatmujey/Bouncer/actions/runs/41479714800)
at block `9Y34V5cDwTH7JTQjDvXv78m5dtn64w9UpSLdvjbANtnB` on 2 November 2026
observed the owner registered with Circle and holding **zero** test USDC. It
also observed Ref registered with both tokens, a wNEAR storage minimum of
0.00125 test NEAR, and pool 1845 indicating 6,917 USDC atomic units for 0.01
wNEAR. This is a stale, point-in-time indication, not a reserved price or proof
of Circle funding; fresh checks were mandatory before the swap.

The [one-shot wrap](https://github.com/Greatmujey/Bouncer/actions/runs/41480629786)
subsequently verified original testnet transaction
[`BF84QZFMFRuUSWkNWueUBQRD1yvtM6diL2yUGoHaeKpd`](https://testnet.nearblocks.io/txns/BF84QZFMFRuUSWkNWueUBQRD1yvtM6diL2yUGoHaeKpd),
its FINAL receipt and a fresh 0.01 wNEAR owner balance. Circle balance was
still zero at that stage. The original hash is journaled; **do not resend it**.

The subsequent [one-shot swap](https://github.com/Greatmujey/Bouncer/actions/runs/41481206186)
verified original testnet transaction
[`ENLCEW8R2DDtxeQL72hzyZrKaRkvepH5GDvfUoQvhQtW`](https://testnet.nearblocks.io/txns/ENLCEW8R2DDtxeQL72hzyZrKaRkvepH5GDvfUoQvhQtW),
its linked FINAL Ref hook, Circle transfer receipt `VjWUAvy8zYC5fR82J3ggM6wLQj2BKUae61fJtqedHai`,
NEP-141 event and fresh owner balance: **6,917 atoms = 0.006917 test USDC**.
The wNEAR input balance became zero. This is funding of the *owner*, not a
vault or a seller. The original swap is journaled; **do not resend it**.

## Two narrowly fixed actions

1. `wrap`: if needed, register only this owner with wNEAR, at no more than
   0.01 test NEAR storage cost, then deposit exactly 0.01 test NEAR to mint
   wNEAR. Both calls target only `wrap.testnet` in one owner transaction.
2. `swap`: call `wrap.testnet.ft_transfer_call` with exactly 0.01 wNEAR,
   1 yocto and a fixed Ref/Circle route. The quote is capped at 100,000 test
   USDC atomic units (0.1 test USDC), with a floor of at least 3,000 atoms
   (0.003 test USDC) and 5% slippage protection. The recipient and action list
   cannot be changed by the agent.

Both signatures are produced locally from the testnet-only owner key, and the
original signed hash is durably journaled before public export. A verified
Circle registration journal is required before wrapping; the exact verified
wrap journal is required before signing the swap. Each broadcaster rereads
fresh FINAL account, nonce, code, registration, balances and price, records a
public fence, sends at most once, and verifies the original linked receipt and
subsequent balances. A swap additionally requires the exact Ref swap hook,
its full-input-used result, one linked successful Circle `ft_transfer` receipt
from Ref to the owner, and its matching NEP-141 event. A lost response or failed receipt
check is **unknown**, not permission to repeat: retain and reconcile the
original hash. These checks trust the selected RPC and are not consensus proofs.

**Bearer warning:** public signed bytes can be relayed by anyone *before* the
CI preflight, though they can execute only the exact fixed, capped action and
nonce. They do not reveal the private key. Ref, token code, liquidity and
prices can change; none of these checks guarantee execution or delivery. The
local backup is not proof that the user has exported it. Keyless vault funding
still requires a safely retained backup and the separately reviewed risk gates.
