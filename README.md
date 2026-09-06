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

## For judges

**Five minutes.** `npm install && npm test`. Thirty contract tests run in under
a second with no Docker, no wallet and no node — they execute the compiled
circuits directly through the Compact runtime, so every `assert` in
`vero.compact` fires exactly as it would on-chain. The rejections are the half
worth reading: [test/vero.test.ts](./test/vero.test.ts).

**Twenty minutes.** `npm run setup` brings up a local devnet, compiles, deploys,
appoints a registrar and grants a credential. `npm run test:e2e` reads the
result back off the chain; `npm run test:forgery` attempts a forgery against it
and fails if the forgery succeeds. Then `npm run cli` proves a credential
against a post, and `npm --workspace ui run dev` renders the badge from live
ledger state.

**Where the Midnight-specific work is.** The contract is one file,
[contracts/vero.compact](./contracts/vero.compact) — a Merkle registry, three
domain-separated authorities, and one circuit that proves membership without
revealing which leaf. Private state and the witness implementations are in
[src/vero-credential.ts](./src/vero-credential.ts); that pair is where the
dual-ledger model actually shows up.

**What is deliberately unfinished**, and why, is written down rather than
omitted: [What is verified, and what is not](#what-is-verified-and-what-is-not),
[Honest limitations](#honest-limitations), and
[docs/wave2-wallet-bridge.md](./docs/wave2-wallet-bridge.md).

---

## What the contract proves today

`contracts/vero.compact` holds a Merkle tree of credential leaves and a map of
who may grant them. A leaf binds four things:

```
leaf = persistentHash("vero:credential:v4", subject, registrar, issuerType, expiry)
```

where `subject = persistentHash("vero:subject:v4", secret)` is all the holder
ever hands over.

Calling `verifySource(postHash, issuerType, expiry)` proves, in one circuit,
that:

1. the caller knows a `secret` whose leaf is **in the registry** — without
   revealing which leaf, so the reader learns that an accredited journalist
   verified the post, not *which* journalist nor which newsroom credentialed
   them;
2. the credential **has not expired**, checked against Midnight's block time;
3. the issuer type recorded against the post is the one bound into that
   credential — a source cannot re-badge itself while reusing a secret;
4. the credential was granted by **the registrar the contract currently
   recognises** for that issuer type.

The secret never leaves the prover. What reaches the ledger is the post hash
and the issuer type.

### The line that makes it sound

The registry's leaves are public, so anyone can compute a valid Merkle path for
somebody else's credential. `checkRoot` passing therefore proves nothing on its
own. What closes the hole:

```compact
assert(path.leaf == leaf, "Merkle path does not belong to this credential");
```

binding the path to the leaf derived from the prover's own secret.
Two tests guard it: `npm test` proves the rejection in process, and
`npm run test:forgery` proves it again through a real devnet. Both hold an
unregistered secret while supplying a genuine path to a registered leaf, and
fail if that is ever accepted.

### Who can grant what

There are three roles, each with its own domain-separated commitment, so no
secret can be replayed as another role's authority:

| Role | Can do | Set by |
|---|---|---|
| Governance | `appointRegistrar(issuerType, registrar)` | The constructor, at deploy |
| Registrar | `registerCredential(subject, issuerType, expiry)` for **its own** issuer type | Governance |
| Holder | `verifySource(postHash, issuerType, expiry)` | A registrar |

**One registrar per issuer type**, because the body that grants a credential is
the only one that can say whether it still holds. A press council may accredit
journalists; it has no standing to certify surgeons, and `registrars` is what
stops it doing so.

All three are gated on a secret rather than on `ownPublicKey()` — that value is
supplied by the prover and any caller can set it to anything, so it cannot
carry authority.

### Why the registrar is in the leaf

The subject hands a registrar one thing: a commitment to a secret it never
reveals. The issuer type and the expiry come from the registrar, and the
contract builds the leaf.

Earlier versions took the finished leaf from the subject, which meant the
registrar signed off on 32 opaque bytes. With a single trusted registrar that
was survivable. With several it is not — a subject could take a commitment
built with `issuerType = "journalist:accredited"` to whichever registrar was
easiest to convince, and the registry would have accepted it.

Binding the granting registrar into the leaf has a second consequence worth
stating: when governance replaces a registrar, every credential the old one
granted stops verifying. That is the intended behaviour. Governance replaces a
registrar precisely when it should no longer be trusted, and the alternative
would silently transfer its credentials to the replacement.

---

## Quick start

Requirements: Node 22 and the Compact compiler. Docker with Compose v2 is
needed for the devnet flow below; `npm test` does not use it.

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
| `npm test` | Contract tests, in process — no Docker, no wallet, under a second |
| `npm run test:e2e` | Reconnect, decode the ledger, assert the credential is registered |
| `npm run test:forgery` | Security regression on the leaf-binding assert |
| `npm run check-balance` | NIGHT / DUST balance |
| `npm run clean` | Remove build artefacts and local state |

---

## Tests

```bash
npm test
```

30 tests, under a second, **and no Docker**. They drive the compiled circuits
directly through the Compact runtime, so every `assert` in `vero.compact` fires
exactly as it would on-chain — only the proving is skipped. If the contract has
not been compiled yet the command compiles it first, without proving keys, so a
fresh clone needs nothing but Node and the Compact compiler.

There is a test for each rejection the contract can make, because those are the
ones that decide whether any of this is worth anything:

| What is tested | Why it is there |
|---|---|
| A registrar granting a credential of somebody else's issuer type | A medical board must not be able to accredit journalists |
| A registrar that governance never appointed | Authority comes from the appointment, not from asking |
| A credential proven after its registrar was replaced | Replacing a registrar must not transfer its credentials |
| A genuine Merkle path belonging to somebody else | The forgery. Leaves are public, so the path alone must not be enough |
| A path built against a different registry | `checkRoot` is the only thing that catches this one |
| A credential proven under an issuer type it was not issued for | The issuer type is bound into the leaf |
| Appointing a registrar without the governance secret | Authority cannot come from `ownPublicKey()` |
| Expiry, one second either side of the boundary | Block time is the one thing a live devnet cannot rewind |
| An expiry expressed in milliseconds | Regression for a bug that has no symptom — see below |

The devnet scripts stay and are not replaced. `npm run test:e2e` and
`npm run test:forgery` prove the same properties through a real node, proof
server, indexer and wallet: they test the wiring, where `npm test` tests the
contract.

### The credential

`.vero-credential` (JSON, mode `0600`, gitignored) holds the credential secret,
issuer type and expiry, plus the registrar and governance secrets. In a real
deployment those three belong to three different parties; the demo plays all of
them from one machine, which is why one file holds the lot.

Every field feeds the leaf, directly or through the registrar's commitment, so
they must be identical at deploy time and at proof time. Environment overrides:
`VERO_CREDENTIAL_SECRET`, `VERO_ISSUER_TYPE`, `VERO_CREDENTIAL_EXPIRY`
(unix **seconds**), `VERO_REGISTRAR_SECRET`, `VERO_GOVERNANCE_SECRET`.

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
| Deploy, registrar appointment, credential grant, membership proof accepted | observed |
| Expired credential refused on the expiry assert | observed |
| Merkle path for a foreign leaf refused | observed |
| Registrar refused a credential of another registrar's issuer type | observed |
| Issuer type read back from the ledger | observed |
| Fresh clone runs from scratch | observed |
| Behaviour on `preview` / `preprod` | **untested** |
| Credential revocation | not implemented |
| Governance beyond one commitment (multisig, on-chain vote) | not implemented |

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

- **The registrar is the trust anchor.** Vero proves that the registrar the
  contract recognises for an issuer type granted this credential. It does not
  prove that registrar checked anything before granting it. `issuerType` is a
  label the registrar asserts.
- **Governance is one commitment.** Whoever holds the governance secret can
  appoint any registrar for any issuer type, including replacing one. A real
  deployment needs a multisig of institutions or an on-chain vote; this is the
  most obvious next thing to replace.
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
  ensure-compiled.mjs       compiles the contract for `npm test` if needed
test/
  vero-simulator.ts         drives the circuits in process, with a settable clock
  vero.test.ts              one test per rejection the contract can make
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
