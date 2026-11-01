# Draft: private Svalin security report and collaboration request

**Draft only. Nothing has been sent.** Svalin's
[security policy](https://github.com/noobshole/svalin-agent/blob/7ebfb14f35630dfc1665b04993e684b5444133fb/SECURITY.md)
requests that reports be made **privately**, not as public issues; follow it.
GitHub reported private vulnerability reporting enabled on 1 November 2026.
With the owner's approval, one API submission was attempted that day; GitHub
returned **HTTP 403, resource not accessible by integration**, so no report was
created or delivered. The attempt is recorded outside the repository and must
not be automatically retried. The GitHub connection/permissions need attention;
reconnecting may not grant reporting access to a repository owned by someone
else. This draft contains no Bouncer secrets, private repository URLs, bearer
codes, real transaction IDs or payment authorization. It does not assume a CVE
or severity.

## Suggested summary

NEAR Pro exact-amount matching cannot independently attribute the credited payment

## Suggested private report body

### Summary

Hi! We're building Bouncer, a testnet-only NEAR agent that buys resources under
owner-defined on-chain spending limits. We inspected Svalin Pro's NEAR checkout
in source commit
[`7ebfb14f35630dfc1665b04993e684b5444133fb`](https://github.com/noobshole/svalin-agent/tree/7ebfb14f35630dfc1665b04993e684b5444133fb).
The source appears to match a reservation by exact amount, network and payment
time, without checking its sender or memo; the activation response gives a
count and status but no credited transaction hash. This may be intentional
for the current payment UX. It prevents a buyer needing payer-specific
attribution from independently determining which transaction funded its pass.
Source inspection does not establish what is deployed.

### Local reproduction

We ran Svalin's `createApp`, `KeyStoreCore`/`MemoryStorage`,
`nearPaymentsReceived` and risk engine in-process with Bouncer's buyer. All
chain data, the indexer, elapsed time and portfolio were **simulated**. No
live seller reservation, activation, paid endpoint, or testnet payment was made.

1. Create a local Pro code and reserve a monthly NEAR amount using the local
   `/v1/pro/near` implementation. Use an in-memory seller store.
2. Simulate a buyer's FINAL payment A and a separate successful Circle-token
   event B for the same reserved amount, with `old_owner_id` set to a different
   account. Give the seller's injected FastNEAR reader an index containing B,
   but not A; let the buyer independently inspect its simulated A receipt.
3. Call the local `/v1/pro/activate` with the original code. In this test the
   seller store records B as the pass payment and reports an active pass with
   `found: 1`, while the buyer has only the separate A receipt and the response
   doesn't identify B. It cannot infer that A was credited. This demonstrates
   attribution ambiguity, not theft or proof of a deployed vulnerability.
4. Separately, reserve two local codes, simulate a payment for only the second,
   and call activation for the first: the source's global `claimNear` can credit
   the second code as part of that lookup. This is why Bouncer treats reservation
   recovery via activation as a seller-state mutation requiring approval.

### Impact and possible collaboration

If an integration assumes that active status or `found: 1` proves its own
transfer funded the pass, it can make a false attribution when another sender
pays the reserved amount or the seller's index differs from the buyer's view.
We have **not** established a real-world attack, financial loss, deployed
version or severity. The buyer now reports attribution as unverified and never
retries ambiguous payments automatically.

Would an optional, separately versioned profile be of interest that:

- records an expected payer/vault and public, non-secret memo or reservation
  commitment alongside the token, seller, amount and payment window;
- checks the successful **FINAL** token-receipt event's actual `old_owner_id`,
  payee, amount and memo, supports a nested transfer, and handles relevant
  refunds and indexer lag;
- atomically claims each transaction and reservation once in a shared durable
  store, with documented handling of late or ambiguous payments; and
- returns the credited transaction hash and reservation commitment through an
  authenticated status or receipt so the buyer can compare it with its own
  original FINAL transaction? A seller signature authenticates a statement,
  not the accuracy of the report or future service availability.

The Pro bearer should never appear in a memo, URL or public log. We'd welcome
your guidance and, if you agree, a separately approved **testnet-only**
interoperability test. Circle testnet USDC has no real-world value. No payment
or provider request is authorized by this report. AI assistance was used to
research, test and prepare this draft.
