/**
 * Contract-level tests for vero.compact, run in-process.
 *
 * There is one test per `assert` in the contract, plus the boundaries around
 * them. The rejections matter more than the happy path here: a credential
 * system that verifies valid credentials but also verifies invalid ones is
 * worse than no credential system, because it looks like it works.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  VeroSimulator,
  secretFor,
  deriveCredentialCommitment,
  deriveRegistrarCommitment,
  type MerklePath,
} from './vero-simulator';
import {
  encodeIssuerType,
  decodeIssuerType,
  hashPost,
  toHex,
  nextQuarterBoundary,
  isQuarterBoundary,
  type VeroPrivateState,
} from '../src/vero-credential';

const JOURNALIST = encodeIssuerType('journalist:accredited');
const EDITOR = encodeIssuerType('editor:newsroom');

/** 2025-10-09, and 2026-01-01T00:00:00Z — a quarter boundary, as issued expiries are. */
const NOW = 1_760_000_000;
const EXPIRY = 1_767_225_600n;

const REGISTRAR_SECRET = secretFor('registrar');
const REGISTRAR_COMMITMENT = deriveRegistrarCommitment(REGISTRAR_SECRET);

const SOURCE_SECRET = secretFor('source');
const SOURCE_COMMITMENT = deriveCredentialCommitment(SOURCE_SECRET, JOURNALIST, EXPIRY);

const OTHER_SECRET = secretFor('other-source');
const OTHER_COMMITMENT = deriveCredentialCommitment(OTHER_SECRET, JOURNALIST, EXPIRY);

const POST = hashPost('https://exemplo.pt/reportagem');
const OTHER_POST = hashPost('https://exemplo.pt/segunda-reportagem');

const NO_SECRET = new Uint8Array(32);

const stateOf = (
  credentialSecret: Uint8Array,
  credentialCommitment: Uint8Array,
  registrarSecret: Uint8Array = NO_SECRET,
): VeroPrivateState => ({ credentialSecret, credentialCommitment, registrarSecret });

/** Whoever holds the registrar secret. Holds no credential of their own. */
const REGISTRAR = stateOf(NO_SECRET, new Uint8Array(32), REGISTRAR_SECRET);
/** The accredited journalist. */
const SOURCE = stateOf(SOURCE_SECRET, SOURCE_COMMITMENT);

const deploy = (overrides: Partial<ConstructorParameters<typeof VeroSimulator>[0]> = {}) =>
  new VeroSimulator({
    registrarCommitment: REGISTRAR_COMMITMENT,
    privateState: REGISTRAR,
    time: NOW,
    ...overrides,
  });

/** A contract with the source's credential already in the registry. */
function withRegisteredSource(): VeroSimulator {
  const vero = deploy();
  vero.as(REGISTRAR).registerCredential(SOURCE_COMMITMENT);
  return vero;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('deriveCredentialCommitment', () => {
  it('binds the secret, the issuer type and the expiry together', () => {
    const base = deriveCredentialCommitment(SOURCE_SECRET, JOURNALIST, EXPIRY);

    // Change any one of the three and the leaf moves. This is what stops a
    // credential issued as one thing being proven as another.
    expect(toHex(deriveCredentialCommitment(OTHER_SECRET, JOURNALIST, EXPIRY))).not.toEqual(toHex(base));
    expect(toHex(deriveCredentialCommitment(SOURCE_SECRET, EDITOR, EXPIRY))).not.toEqual(toHex(base));
    expect(toHex(deriveCredentialCommitment(SOURCE_SECRET, JOURNALIST, EXPIRY + 1n))).not.toEqual(toHex(base));
  });

  it('is deterministic', () => {
    expect(toHex(deriveCredentialCommitment(SOURCE_SECRET, JOURNALIST, EXPIRY))).toEqual(
      toHex(deriveCredentialCommitment(SOURCE_SECRET, JOURNALIST, EXPIRY)),
    );
  });

  it('is domain-separated from the registrar commitment', () => {
    // Both hash a 32-byte secret; only the domain tag keeps a registrar secret
    // from doubling as a credential secret.
    expect(toHex(deriveRegistrarCommitment(SOURCE_SECRET))).not.toEqual(
      toHex(deriveCredentialCommitment(SOURCE_SECRET, JOURNALIST, EXPIRY)),
    );
  });
});

describe('registerCredential', () => {
  let vero: VeroSimulator;

  beforeEach(() => {
    vero = deploy();
  });

  afterEach(() => {
    // Nothing in the contract may move the root of trust.
    expect(toHex(vero.ledger.registrarCommitment)).toEqual(toHex(REGISTRAR_COMMITMENT));
  });

  it('starts with an empty registry', () => {
    expect(vero.ledger.credentialRegistry.firstFree()).toEqual(0n);
    expect(vero.ledger.credentialRegistry.findPathForLeaf(SOURCE_COMMITMENT)).toBeUndefined();
  });

  it('inserts a leaf when the registrar registers a credential', () => {
    vero.as(REGISTRAR).registerCredential(SOURCE_COMMITMENT);

    expect(vero.ledger.credentialRegistry.firstFree()).toEqual(1n);
    const path = vero.ledger.credentialRegistry.findPathForLeaf(SOURCE_COMMITMENT);
    expect(path).toBeDefined();
    expect(toHex(path!.leaf)).toEqual(toHex(SOURCE_COMMITMENT));
  });

  it('rejects a caller who does not hold the registrar secret', () => {
    expect(() => {
      vero.as(stateOf(NO_SECRET, new Uint8Array(32), secretFor('impostor'))).registerCredential(SOURCE_COMMITMENT);
    }).toThrow('Caller is not the registrar');

    expect(vero.ledger.credentialRegistry.firstFree()).toEqual(0n);
  });

  it('rejects the source themselves — holding a credential is not authority to grant one', () => {
    expect(() => {
      vero.as(SOURCE).registerCredential(SOURCE_COMMITMENT);
    }).toThrow('Caller is not the registrar');
  });

  it('accepts several credentials', () => {
    vero.as(REGISTRAR).registerCredential(SOURCE_COMMITMENT);
    vero.as(REGISTRAR).registerCredential(OTHER_COMMITMENT);

    expect(vero.ledger.credentialRegistry.firstFree()).toEqual(2n);
    expect(vero.ledger.credentialRegistry.findPathForLeaf(SOURCE_COMMITMENT)).toBeDefined();
    expect(vero.ledger.credentialRegistry.findPathForLeaf(OTHER_COMMITMENT)).toBeDefined();
  });
});

describe('verifySource', () => {
  describe('with a registered, unexpired credential', () => {
    let vero: VeroSimulator;

    beforeEach(() => {
      vero = withRegisteredSource();
    });

    it('records the post against the issuer type', () => {
      vero.as(SOURCE).at(NOW).verifySource(POST, JOURNALIST, EXPIRY);

      expect(vero.ledger.verifiedPosts.size()).toEqual(1n);
      expect(vero.ledger.verifiedPosts.member(POST)).toBe(true);
      expect(decodeIssuerType(vero.ledger.verifiedPosts.lookup(POST))).toEqual('journalist:accredited');
    });

    it('verifies several posts from one credential', () => {
      vero.as(SOURCE).at(NOW).verifySource(POST, JOURNALIST, EXPIRY);
      vero.as(SOURCE).at(NOW).verifySource(OTHER_POST, JOURNALIST, EXPIRY);

      expect(vero.ledger.verifiedPosts.size()).toEqual(2n);
    });

    it('does not record the credential, only what it attests to', () => {
      vero.as(SOURCE).at(NOW).verifySource(POST, JOURNALIST, EXPIRY);

      // The ledger learns the issuer type, never the leaf that proved it.
      expect(toHex(vero.ledger.verifiedPosts.lookup(POST))).toEqual(toHex(JOURNALIST));
      expect(toHex(vero.ledger.verifiedPosts.lookup(POST))).not.toEqual(toHex(SOURCE_COMMITMENT));
    });
  });

  describe('rejections', () => {
    let vero: VeroSimulator;

    beforeEach(() => {
      vero = withRegisteredSource();
    });

    afterEach(() => {
      // No rejected proof may leave a trace on the ledger.
      expect(vero.ledger.verifiedPosts.size()).toEqual(0n);
    });

    it('rejects a credential that has expired', () => {
      expect(() => {
        vero.as(SOURCE).at(Number(EXPIRY) + 1).verifySource(POST, JOURNALIST, EXPIRY);
      }).toThrow('Credential has expired');
    });

    it('rejects a credential proven with a different issuer type than it was issued for', () => {
      // The issuer type is bound into the leaf, so claiming a different one
      // derives a commitment that is not in the tree — and the path, which is
      // derived from the real leaf, no longer matches it.
      expect(() => {
        vero.as(SOURCE).at(NOW).verifySource(POST, EDITOR, EXPIRY);
      }).toThrow('Merkle path does not belong to this credential');
    });

    it('rejects a valid path presented by someone who does not know the secret', () => {
      // The registry's leaves are public, so anyone can compute a genuine path
      // for someone else's credential. Only `assert(path.leaf == commitment)`
      // stops that path being enough on its own. This is the forgery guard.
      const impostor = stateOf(secretFor('impostor'), SOURCE_COMMITMENT);

      expect(() => {
        vero.as(impostor).at(NOW).verifySource(POST, JOURNALIST, EXPIRY);
      }).toThrow('Merkle path does not belong to this credential');
    });

    it('rejects a credential registered somewhere else', () => {
      // A path that is internally consistent — its leaf is the prover's own
      // commitment — but was built against a different registry. Only
      // `checkRoot` catches this one.
      const elsewhere = withRegisteredSource();
      const foreignPath = elsewhere.ledger.credentialRegistry.findPathForLeaf(SOURCE_COMMITMENT)!;

      const here = deploy({
        witnesses: {
          credentialPath: ({ privateState }: { privateState: VeroPrivateState }): [VeroPrivateState, MerklePath] => [
            privateState,
            foreignPath,
          ],
        },
      });
      here.as(REGISTRAR).registerCredential(OTHER_COMMITMENT);

      expect(() => {
        here.as(SOURCE).at(NOW).verifySource(POST, JOURNALIST, EXPIRY);
      }).toThrow('Credential is not in the registry');

      expect(here.ledger.verifiedPosts.size()).toEqual(0n);
    });

    it('rejects a credential that was never registered at all', () => {
      const unregistered = stateOf(OTHER_SECRET, OTHER_COMMITMENT);

      // The real witness cannot even produce a path — there is no leaf to
      // find. The failure surfaces before the circuit runs, with an
      // explanation rather than a bare assert.
      expect(() => {
        vero.as(unregistered).at(NOW).verifySource(POST, JOURNALIST, EXPIRY);
      }).toThrow('not in the on-chain registry');
    });
  });

  describe('the expiry boundary', () => {
    let vero: VeroSimulator;

    beforeEach(() => {
      vero = withRegisteredSource();
    });

    it('accepts the credential one second before it expires', () => {
      vero.as(SOURCE).at(Number(EXPIRY) - 1).verifySource(POST, JOURNALIST, EXPIRY);
      expect(vero.ledger.verifiedPosts.size()).toEqual(1n);
    });

    it('rejects the credential at the instant it expires', () => {
      // blockTimeLessThan is strict: at exactly the expiry the credential is
      // already gone.
      expect(() => {
        vero.as(SOURCE).at(Number(EXPIRY)).verifySource(POST, JOURNALIST, EXPIRY);
      }).toThrow('Credential has expired');
    });
  });

  describe('the millisecond trap', () => {
    it('accepts an expiry expressed in milliseconds long after that instant has passed', () => {
      // This is a regression test for a mistake, not for a feature.
      //
      // Block time is compared in SECONDS. An expiry given in milliseconds is
      // ~1000x too large, so `blockTimeLessThan` is true until the year 58000
      // and the credential never expires — silently, with no error anywhere.
      // Nothing in the contract can catch this; the guard lives in
      // src/vero-credential.ts, and this test is what keeps it honest.
      const expiryInMillis = EXPIRY * 1000n;
      const secret = secretFor('millisecond-victim');
      const commitment = deriveCredentialCommitment(secret, JOURNALIST, expiryInMillis);

      const vero = deploy();
      vero.as(REGISTRAR).registerCredential(commitment);

      // Twenty years after the credential was meant to lapse.
      const longAfter = Number(EXPIRY) + 20 * 365 * 24 * 60 * 60;
      vero.as(stateOf(secret, commitment)).at(longAfter).verifySource(POST, JOURNALIST, expiryInMillis);

      expect(vero.ledger.verifiedPosts.size()).toEqual(1n);
    });
  });
});

describe('quarter-boundary expiry bucketing', () => {
  // verifySource discloses the expiry. Exact per-credential timestamps would
  // act as serial numbers linking every post one source verifies; rounding to
  // a shared boundary makes the disclosed value a cohort rather than an
  // identifier.
  it('rounds up to the start of the next quarter', () => {
    const midQuarter = Math.floor(Date.UTC(2026, 1, 14, 9, 30, 0) / 1000); // 14 Feb 2026
    const bucketed = nextQuarterBoundary(midQuarter);

    expect(new Date(bucketed * 1000).toISOString()).toEqual('2026-04-01T00:00:00.000Z');
    expect(isQuarterBoundary(bucketed)).toBe(true);
  });

  it('rolls into the next year from the fourth quarter', () => {
    const q4 = Math.floor(Date.UTC(2026, 10, 3, 0, 0, 0) / 1000); // 3 Nov 2026
    expect(new Date(nextQuarterBoundary(q4) * 1000).toISOString()).toEqual('2027-01-01T00:00:00.000Z');
  });

  it('leaves a value that is already on a boundary alone', () => {
    const boundary = Math.floor(Date.UTC(2026, 6, 1, 0, 0, 0) / 1000);
    expect(nextQuarterBoundary(boundary)).toEqual(boundary);
  });

  it('puts every credential issued in one quarter on the same disclosed value', () => {
    const days = [1, 17, 44, 80].map((d) => Math.floor(Date.UTC(2026, 0, d, 12, 0, 0) / 1000));
    const bucketed = new Set(days.map(nextQuarterBoundary));

    // Four credentials issued across a quarter, one disclosed expiry between them.
    expect(bucketed.size).toEqual(1);
  });
});
