# The wallet bridge — DApp Connector to midnight-js

**Status:** built and tested in process. The run through a real browser wallet
against the devnet is the step still outstanding; the checklist for it is at
the end.

The reader half of the demo has worked without a wallet since Wave 1. The
publisher half — proving a credential from inside the browser — was blocked on
a gap between two Midnight interfaces. This is how that gap is closed.

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

Three signatures decide everything:

```ts
connect(networkId: string): Promise<ConnectedAPI>

balanceUnsealedTransaction(tx: string, options?: { payFees?: boolean })
  : Promise<{ tx: string }>

submitTransaction(tx: string): Promise<void>
```

Transactions cross the boundary as **serialized strings**, keys come back as
**Bech32m**, and submission returns **nothing**.

`midnight-js` 4.1.1 — which the contract, deploy script and CLI are built on —
expects a `WalletProvider` whose `balanceTx` takes and returns transaction
**objects** and whose keys are **hex**, and a `MidnightProvider` whose
`submitTx` resolves to a **transaction id**.

As of 2026-10-28, midnight-js 4.1.1 is still the latest release, and there is
still no `-dapp-connector-wallet-provider` package — only the proof provider.

## How it is bridged

[`ui/lib/wallet-bridge.ts`](../ui/lib/wallet-bridge.ts), about a hundred lines
with no React and no contract in it:

| midnight-js expects | connector offers | the bridge |
|---|---|---|
| `balanceTx(tx)` → `FinalizedTransaction` | `balanceUnsealedTransaction(string)` → `{ tx: string }` | `toHex(tx.serialize())`, call, `Transaction.deserialize('signature', 'proof', 'binding', fromHex(…))` |
| `submitTx(tx)` → `TransactionId` | `submitTransaction(string)` → `void` | submit the hex; return `tx.identifiers()[0]` |
| `getCoinPublicKey()` → hex | `getShieldedAddresses().shieldedCoinPublicKey` → Bech32m | decoded once, at connect time |
| `getEncryptionPublicKey()` → hex | `getShieldedAddresses().shieldedEncryptionPublicKey` → Bech32m | decoded once, at connect time |

Four decisions worth knowing:

**The string is hex.** Neither the connector's README nor its specification
says so. Midnight's own example DApp (`example-bboard`) does it this way, and
the tests confirm that a wallet reading hex gets back exactly the bytes sent.

**The transaction id comes from the transaction.** The Wave 1 version of this
document called the missing id "the awkward part", and expected to hash the
transaction or watch the indexer for it. Neither is needed: a transaction's
`identifiers()` are what the indexer is watched by, and the wallet SDK's own
`submitTransaction` returns one of them the same way.

**`balanceUnsealedTransaction`, not `balanceSealedTransaction`.** A contract
call reaches `balanceTx` proven but not yet bound — unsealed. The sealed
variant cannot balance contracts that use fallible sections. The bridge reads
the wallet's reply back as a *bound* transaction, so a reply that is still
unsealed is refused before anything is submitted.

**The network is checked at connect time.** A wallet on the wrong network
otherwise fails later, with an error that does not say so. The bridge asks for
the app's network, compares it with what `getConnectionStatus()` reports, and
names both if they differ. The keys are decoded at the same moment, so a
problem with them also shows next to the Connect button, not after a proof.

### Who proves

[`ui/lib/publish-client.ts`](../ui/lib/publish-client.ts) supports both:

- **The wallet** (default) — through Midnight's `dappConnectorProofProvider`,
  so the page needs nothing running locally. This is the only option for a
  hosted deployment, where a visitor has no proof server of their own.
- **A proof server** — `VERO_PROVING=proof-server` sends proofs to
  `http://127.0.0.1:6300`, as the CLI does. Easier to debug, and the fallback if
  a wallet's proving turns out not to work.

### One more thing the browser needed

`compact-runtime`'s `fromHex`/`toHex` call the Node global `Buffer` without
importing it. Webpack 5 no longer provides it, and nothing fails until a
contract call is under way, so `ui/next.config.mjs` now provides it.

## What has been verified

| What | How | Result |
|---|---|---|
| The bridge against the connector contract | `test/wallet-bridge.test.ts` — 12 tests, real ledger transactions, a stand-in wallet that only accepts what a real one would | passes |
| The tests catch a broken bridge | sending base64 instead of hex fails 3 tests; returning a made-up id fails 1 | confirmed |
| The publisher view in a production build | `next build`, then Chromium with a stand-in wallet injected: connects, decodes the Bech32m keys, shows the address; a wallet on `preprod` is refused with both networks named | observed |
| A proof generated and submitted through 1AM | — | **not yet observed** |

## Checklist for the first real run

Against the local devnet, with 1AM installed:

1. `npm run setup` — devnet, compile, deploy, register the demo credential.
2. `npm --workspace ui run sync:assets` — copy the fresh circuit into the UI.
3. `npm run fund -- <1AM's unshielded address>` — the wallet needs NIGHT, and
   the DUST generated from it, to pay fees.
4. Set 1AM to the **undeployed** network, pointed at the local node, indexer
   and proof server.
5. `npm --workspace ui run dev`, and open `http://localhost:3100/publish`.
6. Connect. Paste the credential from `.vero-credential` (secret, issuer type,
   expiry in seconds). Pick a post. Prove.
7. Approve in the wallet. The page should report a transaction id and block.
8. Open the reader view — the post should carry the badge.

If step 6 fails while the wallet is proving, retry with
`VERO_PROVING=proof-server npm --workspace ui run dev`: that separates a
proving problem from a balancing one. Whatever happens, record it in the table
above.
