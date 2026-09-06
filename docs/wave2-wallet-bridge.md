# Wave 2 — bridging the DApp Connector to midnight-js

**Status:** identified, specified, not built. Deliberately deferred out of
Wave 1.

The reader half of the demo works without a wallet and ships in Wave 1. The
publisher half — proving a credential from inside the browser — is blocked on
a gap between two Midnight interfaces, and closing that gap is the natural
Wave 2 engineering deliverable.

## What the gap is

Browser wallets implement the **DApp Connector API v4**
(`@midnight-ntwrk/dapp-connector-api@4.0.1`). Verified against 1AM on
2026-09-06, the injected API is:

```
getShieldedBalances   getUnshieldedBalances   getDustBalance
getShieldedAddresses  getUnshieldedAddress    getDustAddress
getTxHistory          balanceUnsealedTransaction
balanceSealedTransaction                      makeTransfer
makeIntent            signData                submitTransaction
getProvingProvider    getConfiguration        getConnectionStatus
decryptTransactionOutputs                     hintUsage
```

Two signatures decide everything:

```ts
balanceUnsealedTransaction(tx: string, options?: { payFees?: boolean })
  : Promise<{ tx: string }>

submitTransaction(tx: string): Promise<void>
```

Transactions cross the boundary as **serialized strings**, and submission
returns **nothing**.

`midnight-js` 4.1.1 — which the contract, deploy script and CLI are built on —
expects a `WalletProvider` whose `balanceTx` takes and returns transaction
**objects**, and whose `submitTx` resolves to a transaction id. The two models
do not meet.

## What already exists

Half the bridge is official:

```
@midnight-ntwrk/midnight-js-dapp-connector-proof-provider@4.1.1

dappConnectorProofProvider(api, zkConfigProvider, costModel): Promise<ProofProvider>
```

It adapts the connector's `getProvingProvider` into a midnight-js
`ProofProvider`, and it is pinned to the same 4.1.1 line as the rest of the
stack. Proving from the browser is therefore a solved problem.

There is **no** equivalent for the wallet side. The full 4.1.1 family is:

```
midnight-js  -compact  -contracts  -dapp-connector-proof-provider
-fetch-zk-config-provider  -http-client-proof-provider
-indexer-public-data-provider  -level-private-state-provider
-logger-provider  -network-id  -node-zk-config-provider  -protocol
-types  -utils
```

No `-dapp-connector-wallet-provider`. That adapter has to be written.

## What building it involves

A `WalletProvider` implementation that translates in both directions:

| midnight-js expects | connector offers | work |
|---|---|---|
| `balanceTx(tx, newCoins)` → object | `balanceUnsealedTransaction(string)` → `{ tx: string }` | serialize, call, deserialize |
| `submitTx(tx)` → txId | `submitTransaction(string)` → `void` | serialize; recover the id another way |
| `getCoinPublicKey()` | `getShieldedAddresses()` | derive, format |
| `getEncryptionPublicKey()` | `getShieldedAddresses()` | derive, format |

Serialization is `Transaction<SignatureEnabled, Proof, Binding>` from
`@midnight-ntwrk/ledger-v8`, per the connector's own documentation.

The missing transaction id is the awkward part: `submitTransaction` resolves to
`void`, so the id has to come from somewhere else — hashing the submitted
transaction, or watching the indexer for it to appear.

Two known hazards, both from the Midnight template's own troubleshooting notes:

- `balanceSealedTransaction` cannot balance contracts that use fallible
  sections; `balanceUnsealedTransaction` is the one to use.
- Wallet and DApp must agree on the network, or the wallet rejects the
  connection with an error that does not say so.

## Why this is deferred rather than dropped

The Wave 1 rubric scores *User Experience & Design* on whether the frontend
"connects to the contract as part of a functional end-to-end experience". The
reader view does exactly that: it reads the ledger, decodes it with the
contract's own `ledger()`, and renders the verification. Browser-side proving
is not required for that criterion.

Against ten days remaining, an undocumented adapter written blind is poor value
next to the *Quality Assurance & Reliability* criterion, which is worth the
same 15% and where the project currently has less.

It is also a good Wave 2 deliverable on its own terms. The Buildathon rewards
"meaningful new progress completed during that Wave" over one-time polish, and
this is a self-contained piece of engineering with a clear before and after: a
demo that reads verifications becomes a demo where a source produces one,
end to end, in the browser.

## Where the groundwork already is

Not starting from nothing in Wave 2:

- `ui/lib/publish-client.ts` — wallet detection, credential handling, witness
  wiring and provider construction, all written. Only the `walletProvider`
  object needs replacing with the adapter.
- `ui/app/publish/PublishClient.tsx` — the three-step flow, wired and rendering.
- `ui/scripts/sync-zk-assets.mjs` — the ZK assets and contract module are
  already served and bundled for the browser.
- `ui/next.config.mjs` — the webpack fights (isomorphic-ws, stream, WASM) are
  fought and won.
- `scripts/fund-wallet.ts` — a browser wallet can be funded on the local devnet,
  so testing needs no faucet.

The connect step works against 1AM today. What fails is the first call that
crosses into midnight-js.
