# Vero

**Credibility you can prove.**

Vero is a verifiable credibility layer for people and organisations publishing
online, built on [Midnight](https://midnight.network). A source proves it holds
a credential registered by a recognised issuer — accredited journalist,
licensed professional, recognised outlet — and chooses how much of its identity
to reveal. Readers get a trust signal backed by a proof rather than by an
administrator's approval.

Built for the [Midnight Buildathon](https://akindo.io), Wave 1.
Project site and build log: **[rmarquesc.github.io/vero-website](https://rmarquesc.github.io/vero-website/)**

Vero does not decide whether a post is true. It provides evidence about the
source behind it.

---

## What the contract proves today

`contracts/vero.compact` holds a Merkle tree of credential commitments. A leaf
is the hash of three things bound together:

```
leaf = persistentHash("vero:credential:v3", secret, issuerType, expiry)
```

Calling `verifySource(postHash, issuerType, expiry)` proves, in one circuit,
that:

1. the caller knows a `secret` whose commitment is **a leaf in the registry** —
   without revealing which leaf, so the reader learns that an accredited
   journalist verified the post, not *which* journalist nor which newsroom
   credentialed them;
2. the credential **has not expired**, checked against Midnight's block time;
3. the issuer type recorded against the post is the one bound into that
   credential — a source cannot re-badge itself while reusing a secret.

The secret never leaves the prover. What reaches the ledger is the post hash
and the issuer type.

### The line that makes it sound

The registry's leaves are public, so anyone can compute a valid Merkle path for
somebody else's credential. `checkRoot` passing therefore proves nothing on its
own. What closes the hole:

```compact
assert(path.leaf == commitment, "Merkle path does not belong to this credential");
```

binding the path to the commitment derived from the prover's own secret.
`npm run test:forgery` is the regression test for exactly this: it holds an
unregistered secret while supplying a genuine path to a registered leaf, and
fails if that is ever accepted.

### Who can register

`registerCredential` is gated on a registrar secret whose commitment is set at
deploy time. It is deliberately **not** gated on `ownPublicKey()` — that value
is supplied by the prover and any caller can set it to anything, so it cannot
carry authority.

The subject derives its own commitment off-chain and hands over only that, so
the credential secret never reaches the registrar.

---

## Quick start

Requirements: Node 22, Docker with Compose v2, and the Compact compiler.

```bash
npm install
npm run setup      # devnet up, compile, deploy, register the demo credential
npm run test:e2e   # reconnect, read the ledger back
npm run cli        # verify a post, then check it
```

`npm run setup` runs without prompts: it brings up a local Midnight devnet
(node, indexer, proof server), compiles the contract, derives the genesis-seed
wallet, deploys, and registers a freshly generated demo credential so there is
something to prove against.

| Script | What it does |
|---|---|
| `npm run compile` | Compile `contracts/vero.compact` |
| `npm run setup` | Devnet + compile + deploy + register, end to end |
| `npm run cli` | Interactive: verify a post, check a post, check balance |
| `npm run test:e2e` | Reconnect, decode the ledger, assert the credential is registered |
| `npm run test:forgery` | Security regression on the leaf-binding assert |
| `npm run check-balance` | NIGHT / DUST balance |
| `npm run clean` | Remove build artefacts and local state |

### The credential

`.vero-credential` (JSON, mode `0600`, gitignored) holds the credential secret,
issuer type, expiry and the registrar secret. It must be identical at deploy
time and at proof time — all four fields feed the commitment. Environment
overrides: `VERO_CREDENTIAL_SECRET`, `VERO_ISSUER_TYPE`,
`VERO_CREDENTIAL_EXPIRY` (unix **seconds**), `VERO_REGISTRAR_SECRET`.

Two details worth knowing before changing anything here:

**Expiry is in seconds, and getting it wrong fails silently open.** Block time
is around `1.8e9`; a millisecond timestamp is around `1.8e12`, so
`blockTimeLessThan` returns true forever and expired credentials sail through
with no error anywhere. Credential loading rejects any expiry past the year
2100 for this reason.

**Expiries are rounded up to a quarter boundary.** Verification discloses the
expiry, and an exact per-credential timestamp behaves like a serial number —
two posts verified by the same credential would share it, letting an observer
group a pseudonymous source's posts without ever identifying them. Rounding
makes the whole quarter's cohort indistinguishable.

---

## What is verified, and what is not

Everything below marked *observed* was watched running against the local
devnet. Nothing has been exercised on a public network.

| Behaviour | Status |
|---|---|
| Deploy, credential registration, membership proof accepted | observed |
| Expired credential refused on the expiry assert | observed |
| Merkle path for a foreign leaf refused | observed |
| Issuer type read back from the ledger | observed |
| Fresh clone runs from scratch | observed |
| Behaviour on `preview` / `preprod` | **untested** |
| Credential revocation | not implemented |
| Multiple registrars, issuer governance | out of scope for Wave 1 |

### The demo surface

`ui/` is a Next.js app with two views, added as an npm workspace so there is
one `node_modules` and one copy of each SDK package.

**Reader view (`/`)** — works, and needs no wallet. Checking a verification is
a GraphQL query to the indexer plus the contract's own `ledger()` decoder, both
server-side. That asymmetry is the product: proving is work for the source,
checking is free for everyone else.

**Publisher view (`/publish`)** — connects to a browser wallet and holds a
credential, but cannot yet complete a proof. Browser wallets speak the DApp
Connector API v4, which passes transactions as serialized strings; midnight-js
4.1.1 expects objects. An official bridge exists for the proving half, none for
the wallet half, and writing that adapter is deliberately **Wave 2** work —
specified in [docs/wave2-wallet-bridge.md](./docs/wave2-wallet-bridge.md).

Until then, proving is done from the CLI and the reader view shows the result.

```bash
npm --workspace ui run sync:assets   # after every compile
npm --workspace ui run dev           # http://localhost:3100
```

### Honest limitations

- **The registrar is the trust anchor.** Vero proves that a credential was
  registered. It does not prove the registrar checked anything before
  registering it. `issuerType` is a label the registrar asserts.
- **The disclosed expiry narrows the anonymity set** to everyone credentialed
  in the same quarter with the same issuer type. Removing the disclosure
  entirely means making validity mean "present in the current tree", with a
  shared deadline read from the ledger — that compiles, and is the intended
  direction once the registry has real issuers.
- **Scope is not implemented.** The circuit checks registry membership and
  expiry, nothing finer.
- **Proving from the browser does not work yet** — see the demo surface above.
  The mechanism is proven from the CLI; the browser reads the result.

---

## Project structure

```
contracts/
  vero.compact              the credential circuit
  hello-world.compact       create-mn-app scaffold, kept for reference
docs/
  wave3-issuer-keys-draft.txt   fuller design: issuer keys, scope, signatures
                                (specification — does not compile)
docs/
  wave2-wallet-bridge.md    the connector/midnight-js gap, specified
scripts/
  e2e-check.ts              smoke test + ledger read-back
  forgery-check.ts          security regression on the leaf binding
  fund-wallet.ts            fund a browser wallet on the local devnet
src/
  vero-credential.ts        credential material, private state, witnesses
  deploy.ts                 deploy and register
  cli.ts                    interactive verification
  network.ts                network selection and state
  wallet.ts                 wallet construction and sync cache
docker-compose.yml          node + indexer + proof server
```

## Why Midnight

Selective disclosure is the primitive this problem needs: prove that a
publisher is credentialed without exposing the credential. Compact puts that
behind TypeScript-like contract code, which matters for a project built by a
design-led author rather than a cryptography team. The dual-ledger model keeps
the private witness local while anchoring only the verified outcome.

## Team

Built solo by **Rafaela Costa** — strategic UX/UI designer and product builder.
Non-cryptography background; the Compact implementation was developed with
AI-assisted tooling (Midnight Expert, Claude Code) and community guidance via
the Midnight Discord.

## License

Apache License 2.0 — see [LICENSE](./LICENSE).
