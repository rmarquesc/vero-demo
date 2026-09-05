# vero-demo

A Midnight Network smart contract scaffolded with create-mn-app.

## Quick start

Requirements: Node 22, Docker (with Compose v2), and the Compact compiler at the version pinned in `.compact-version` at the create-mn-app repo root (the version this project was scaffolded against).

> **On Windows:** the npm scripts in this project run natively (PowerShell or cmd.exe), but the Compact compiler publishes no native Windows binary — so `npm run compile`, and `npm run setup` which calls it, need to run inside WSL. See Midnight's [installation docs](https://docs.midnight.network/getting-started/installation).

```bash
npm install
npm run setup
npm run test:e2e
```

`npm run setup` runs end-to-end with no prompts:

1. `docker compose up -d --wait` — starts a local Midnight devnet (node, indexer, proof-server) and blocks until all three pass their healthchecks.
2. `npm run compile` — compiles `contracts/vero.compact` to `contracts/managed/vero/` (two circuits: `registerCredential` and `verifySource`).
3. `npm run deploy` — derives the genesis-seed wallet (NIGHT pre-minted), registers UTXOs for DUST generation, deploys the contract, writes `.midnight-state.json`.

`npm run test:e2e` reconnects to the deployed contract, decodes its ledger as a Vero ledger, and checks the credential commitment is present. Exits 0 if the contract is live and indexable.

## The credential registry

The contract holds a Merkle tree of credential commitments. A source proves
that **one of the registered credentials is theirs**, without revealing which —
so the reader learns that an accredited journalist verified the post, not
*which* accredited journalist, nor which newsroom credentialed them.

```
leaf = persistentHash("vero:credential:v3", secret, issuerType, expiry)
```

Three fields bound into one leaf: a source cannot re-badge itself as a
different kind of issuer, or extend its own validity, while reusing a secret.

### Who can register

`registerCredential` is gated on a registrar secret whose commitment is set at
deploy time. It is deliberately **not** gated on `ownPublicKey()` — that value
is prover-supplied and any caller can set it to anything, so it cannot carry
authority. This is the manually-maintained allowlist stage: one registrar,
adding credentials by hand.

The subject derives their own commitment off-chain and hands over only that,
so the credential secret never reaches the registrar.

### Why a plain MerkleTree

`HistoricMerkleTree` keeps older roots valid, which sounds useful until you
want revocation: a proof against a pre-revocation root would still pass. The
docs say as much — historic trees are "not suitable if items are frequently
removed or replaced". Membership paths here are derived from current ledger
state at proof time, so nothing is gained by keeping history, and revocation
via `insertIndexDefault` stays possible.

### The leaf-binding assert

The tree's contents are public. Anyone can compute a valid Merkle path for
somebody else's leaf, so `checkRoot` passing proves nothing on its own. What
makes the circuit sound is:

```compact
assert(path.leaf == commitment, "Merkle path does not belong to this credential");
```

binding the path to the commitment derived from the prover's own secret.
`npm run test:forgery` is the regression test: it supplies a genuine path for a
registered leaf while holding an unregistered secret, and fails if that is
accepted.

### Expiry is measured in seconds

Midnight's block time is in seconds, and this detail fails silently open. A
millisecond timestamp (~1.8e12) is trivially greater than block time (~1.8e9),
so `blockTimeLessThan` returns true forever and expired credentials are
accepted with no error anywhere. Verified on the local devnet: a past expiry in
milliseconds was accepted; the same instant in seconds was rejected with
`failed assert: Credential has expired`. `loadOrCreateCredential` rejects any
expiry past the year 2100 for this reason.

### What is public and what is not

| Field | On-chain | Why |
|---|---|---|
| `secret` | never leaves the prover | it is the credential |
| which leaf | hidden | the point of the Merkle proof |
| `issuerType` | public, stored per post | it *is* the trust signal a reader needs |
| `expiry` | public | forced: see below |
| `postHash` | public | the thing being verified |

`kernel.blockTimeLessThan` is a ledger operation, so its bound lands in the
transaction's validity window and is public either way. Compact's disclosure
analysis refuses to compile the private version:

> ledger operation might disclose the lower bound of the time being checked

Circuit parameters are private by default in Compact — that is why even an
intentionally public expiry needs an explicit `disclose()`.

**A caveat worth knowing:** disclosing `issuerType` and an exact `expiry`
narrows the anonymity set. With few registered credentials, that pair may
identify the leaf even though the path does not. A coarse expiry bound (prove
`validUntil <= expiry` privately, check block time against the coarse value)
compiles and would widen it — the obvious next refinement.

### Where the credential comes from

`.vero-credential` (JSON, mode `0600`, gitignored) holds the credential secret,
issuer type, expiry and the registrar secret, and must be identical at deploy
time and at proof time. Resolution order:

1. `VERO_CREDENTIAL_SECRET`, `VERO_ISSUER_TYPE`, `VERO_CREDENTIAL_EXPIRY`
   (unix **seconds**), `VERO_REGISTRAR_SECRET` — environment wins per field.
2. `.vero-credential`.
3. Freshly generated on first deploy, then registered automatically so a fresh
   clone has something to prove against.

## Local devnet

The project ships its own devnet via `docker-compose.yml`:

| Service        | Port | Purpose                                         |
| -------------- | ---- | ----------------------------------------------- |
| `node`         | 9944 | Midnight node, `dev` chain preset               |
| `indexer`      | 8088 | GraphQL indexer for chain state                 |
| `proof-server` | 6300 | Generates ZK proofs for contract transactions   |

State lives in container-managed volumes. Tear everything down with:

```bash
docker compose down -v
```

That removes all containers, networks, and volumes. The next `npm run setup` starts from a clean slate.

## ⚠️ LOCAL DEVNET ONLY

The deploy script uses a well-known genesis seed (`0000…0001`) so the
pre-minted NIGHT in the `dev` chain preset is immediately available. **Do
not use this seed against Preprod, mainnet, or any environment that
handles real value** — anyone running this devnet has full access to
funds at this seed.

## Networks

This DApp supports three networks:

| Network | When to use | Default? |
|---|---|---|
| `undeployed` | Local devnet bundled in `docker-compose.yml`. Genesis seed is hardcoded; no funding needed. | yes |
| `preview` | Public preview testnet. Faucet at `https://midnight-tmnight-preview.nethermind.dev`. |  |
| `preprod` | Public preprod testnet. Faucet at `https://midnight-tmnight-preprod.nethermind.dev`. |  |

The active network is **sticky**: whichever network you last interacted
with stays active until you switch. Any command run with `--network <name>`
also sets that network active for subsequent commands. The default on a
fresh project is `undeployed` (local devnet).

```sh
npm run setup -- --network preview   # runs on preview AND makes it active
npm run cli                          # still uses preview
npm run check-balance                # still uses preview
```

You can also switch without running anything else:

```sh
npm run network preview         # active network is now preview
npm run network                 # prints current active network
npm run network undeployed      # switch back to local devnet
```

### How wallets work across networks

- `undeployed` uses a hardcoded genesis seed. Local devnet pre-funds it.
- `preview` and `preprod` generate a fresh wallet on first use: a 24-word
  BIP-39 recovery phrase (printed once) plus its derived seed, both stored
  in `.midnight-state.json` (gitignored). The wallet survives switching
  networks — switch back later and your funded wallet returns.
- **Back up your recovery phrase** if you fund a public-network wallet you
  care about. It is printed when the wallet is created and kept in
  `.midnight-state.json` under `wallets.<network>.mnemonic`. Anyone holding
  the phrase controls the wallet.
- Wallets created before mnemonic support keep working from their stored
  `seed`; they just have no phrase to import into Lace.

### Using the same wallet as Lace

Seeds are derived with the standard BIP-39 `mnemonicToSeed` step — the same
convention Lace uses — so identity is portable in both directions:

- **Bring your Lace wallet here**: pass your recovery phrase via the
  `MIDNIGHT_WALLET_MNEMONIC` env var — the derived addresses match Lace.
  To keep the phrase out of your shell history, enter it with a hidden
  prompt instead of typing it inline:

  ```bash
  read -s MIDNIGHT_WALLET_MNEMONIC && export MIDNIGHT_WALLET_MNEMONIC
  npm run deploy
  ```
- **Take a scaffold wallet to Lace**: restore Lace from the 24-word phrase
  in `.midnight-state.json`.

### Funding a public-network wallet

On the first run with `--network preview` (or `preprod`):

1. `setup` will print your wallet address and the faucet URL.
2. Open the faucet URL, paste the address, request tNIGHT.
3. `setup` polls the wallet balance every 10 s and continues automatically
   once funds arrive.
4. The default poll budget is 10 minutes. Override with
   `MIDNIGHT_FAUCET_TIMEOUT_MS=1800000` (30 min) for unattended runs.

If the faucet is slow or the script times out, your seed is preserved.
Re-run `npm run setup -- --network preview` once the funds land.

### Environment overrides

These env vars override the active network's config (no per-network
suffix — they apply to whichever network is active for the run):

| Variable | Effect |
|---|---|
| `MIDNIGHT_WALLET_SEED` | Use this hex seed (32-128 hex chars; a Lace-compatible BIP-39 seed is 128) instead of generating/persisting one. Useful for CI with a pre-funded wallet. |
| `MIDNIGHT_WALLET_MNEMONIC` | Use this BIP-39 recovery phrase instead of generating a wallet — e.g. your Lace phrase, for the same addresses as Lace. Not persisted. Set only one of seed/mnemonic. |
| `MIDNIGHT_INDEXER_URL` | Override the indexer GraphQL URL. |
| `MIDNIGHT_INDEXER_WS_URL` | Override the indexer WS URL. |
| `MIDNIGHT_NODE_URL` | Override the node RPC URL. |
| `MIDNIGHT_FAUCET_URL` | Override the faucet URL printed during setup. |
| `MIDNIGHT_PROOF_SERVER_URL` | Override the proof server URL — set to a public proof server (e.g. `https://lace-proof-pub.preview.midnight.network`) to skip running one locally. |
| `MIDNIGHT_FAUCET_TIMEOUT_MS` | Faucet poll budget in milliseconds (default 600000 = 10 min). |

By default all networks use the **local** proof server. Public proof
servers exist (see the env override above) but the local default keeps
your witness data on your machine and avoids depending on a remote
service for the deploy hot path.

### Switching back to local devnet

```sh
npm run network undeployed     # or: npm run setup -- --network undeployed
```

Your preview/preprod wallet seeds and deploy addresses stay in
`.midnight-state.json`. Switch back later, and they're still there.

### Wallet sync cache

After each `deploy`, `cli`, or `check-balance` run, the scripts serialize the
wallet's synced state to `.midnight-wallet-state/<network>/` (gitignored).
The next run on the same network restores from that snapshot and only catches
up to the latest block instead of replaying from genesis — meaningful on
`preview` / `preprod` where a from-seed sync takes minutes.

If the cache is stale or corrupt (e.g. after an SDK upgrade with an
incompatible state format) the wallet falls back to a fresh from-seed sync
with a one-line warning. `npm run clean` removes the cache along with other
generated state.

## Available scripts

| Script                  | Description                                                    |
| ----------------------- | -------------------------------------------------------------- |
| `npm run setup`         | One-shot: start devnet, compile, deploy.                       |
| `npm run compile`       | Compile the Compact contract.                                  |
| `npm run deploy`        | Deploy the compiled contract (requires devnet up + compiled).  |
| `npm run cli`           | Interactive CLI to call circuits on the deployed contract.     |
| `npm run check-balance` | Print the genesis-seed wallet's NIGHT and DUST balances.       |
| `npm run test:e2e`      | Smoke + read-back check against the deployed contract.         |
| `npm run clean`         | Remove `contracts/managed/`, `.midnight-state.json`, and `.midnight-wallet-state/`. |
| `npm run proof-server:start` / `:stop` | Compose lifecycle for just the proof-server service. |

## Project structure

```
vero-demo/
├── contracts/
│   ├── vero.compact            # Compact source — the credential circuit
│   └── hello-world.compact     # original create-mn-app scaffold, kept for reference
├── scripts/
│   └── e2e-check.ts            # smoke + read-back
├── src/
│   ├── network.ts              # network selection + state file management
│   ├── wallet.ts               # wallet construction + sync-state cache
│   ├── setup.ts                # orchestrator for `npm run setup`
│   ├── deploy.ts               # deploy the contract
│   ├── cli.ts                  # interact with deployed contract
│   ├── vero-credential.ts      # credential secret, private state, witness
│   └── check-balance.ts        # NIGHT / DUST balance
├── docker-compose.yml          # node + indexer + proof-server
├── .vero-credential            # demo credential secret (gitignored)
├── .midnight-state.json        # written by deploy (gitignored)
├── .midnight-wallet-state/     # serialized sync state per network (gitignored)
├── package.json
└── tsconfig.json
```

## Compact compiler version

`.compact-version` at the create-mn-app repo root pinned the compiler
version this project was scaffolded against. To upgrade your local
compiler to that version:

```bash
compact update <version>
compact use <version>
```
