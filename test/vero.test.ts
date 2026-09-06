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
  deriveGovernanceCommitment,
  deriveRegistrarCommitment,
  deriveSubjectCommitment,
  deriveCredentialLeaf,
  leafFor,
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
const SURGEON = encodeIssuerType('surgeon:licensed');
const UNCLAIMED = encodeIssuerType('sommelier:certified');

/** 2025-10-09, and 2026-01-01T00:00:00Z — a quarter boundary, as issued expiries are. */
const NOW = 1_760_000_000;
const EXPIRY = 1_767_225_600n;

const GOVERNANCE_SECRET = secretFor('governance');
const GOVERNANCE_COMMITMENT = deriveGovernanceCommitment(GOVERNANCE_SECRET);

/** Two institutions, each authoritative over its own profession and nothing else. */
const PRESS_COUNCIL_SECRET = secretFor('press-council');
const PRESS_COUNCIL = deriveRegistrarCommitment(PRESS_COUNCIL_SECRET);
const MEDICAL_BOARD_SECRET = secretFor('medical-board');
const MEDICAL_BOARD = deriveRegistrarCommitment(MEDICAL_BOARD_SECRET);

const SOURCE_SECRET = secretFor('source');
const SOURCE_SUBJECT = deriveSubjectCommitment(SOURCE_SECRET);
/** Where the source's credential lands once the press council grants it. */
const SOURCE_LEAF = leafFor(SOURCE_SECRET, PRESS_COUNCIL, JOURNALIST, EXPIRY);

const POST = hashPost('https://exemplo.pt/reportagem');
const OTHER_POST = hashPost('https://exemplo.pt/segunda-reportagem');

const NONE = new Uint8Array(32);

type Actor = VeroPrivateState;

const actor = (over: Partial<Actor> = {}): Actor => ({
  credentialSecret: NONE,
  credentialLeaf: NONE,
  registrarSecret: NONE,
  governanceSecret: NONE,
  ...over,
});

const GOVERNANCE = actor({ governanceSecret: GOVERNANCE_SECRET });
const PRESS = actor({ registrarSecret: PRESS_COUNCIL_SECRET });
const MEDICAL = actor({ registrarSecret: MEDICAL_BOARD_SECRET });
const SOURCE = actor({ credentialSecret: SOURCE_SECRET, credentialLeaf: SOURCE_LEAF });

const deploy = (overrides: Partial<ConstructorParameters<typeof VeroSimulator>[0]> = {}) =>
  new VeroSimulator({
    governanceCommitment: GOVERNANCE_COMMITMENT,
    privateState: GOVERNANCE,
    time: NOW,
    ...overrides,
  });

/** Governance has appointed the press council, which has granted the source a credential. */
function withCredentialedSource(): VeroSimulator {
  const vero = deploy();
  vero.as(GOVERNANCE).appointRegistrar(JOURNALIST, PRESS_COUNCIL);
  vero.as(PRESS).registerCredential(SOURCE_SUBJECT, JOURNALIST, EXPIRY);
  return vero;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('the commitment scheme', () => {
  it('separates the three roles a single secret could otherwise fill', () => {
    // Without distinct domain tags, a registrar secret would double as a
    // governance secret and appoint its own peers.
    const one = secretFor('reused-everywhere');
    const commitments = new Set([
      toHex(deriveGovernanceCommitment(one)),
      toHex(deriveRegistrarCommitment(one)),
      toHex(deriveSubjectCommitment(one)),
    ]);
    expect(commitments.size).toEqual(3);
  });

  it('binds the holder, the granting registrar, the issuer type and the expiry into the leaf', () => {
    const base = deriveCredentialLeaf(SOURCE_SUBJECT, PRESS_COUNCIL, JOURNALIST, EXPIRY);

    expect(toHex(deriveCredentialLeaf(deriveSubjectCommitment(secretFor('someone else')), PRESS_COUNCIL, JOURNALIST, EXPIRY))).not.toEqual(toHex(base));
    expect(toHex(deriveCredentialLeaf(SOURCE_SUBJECT, MEDICAL_BOARD, JOURNALIST, EXPIRY))).not.toEqual(toHex(base));
    expect(toHex(deriveCredentialLeaf(SOURCE_SUBJECT, PRESS_COUNCIL, SURGEON, EXPIRY))).not.toEqual(toHex(base));
    expect(toHex(deriveCredentialLeaf(SOURCE_SUBJECT, PRESS_COUNCIL, JOURNALIST, EXPIRY + 1n))).not.toEqual(toHex(base));
  });

  it('is deterministic', () => {
    expect(toHex(leafFor(SOURCE_SECRET, PRESS_COUNCIL, JOURNALIST, EXPIRY))).toEqual(toHex(SOURCE_LEAF));
  });
});

describe('appointRegistrar', () => {
  let vero: VeroSimulator;

  beforeEach(() => {
    vero = deploy();
  });

  afterEach(() => {
    // Nothing in the contract may move the root of trust.
    expect(toHex(vero.ledger.governanceCommitment)).toEqual(toHex(GOVERNANCE_COMMITMENT));
  });

  it('starts with no registrars', () => {
    expect(vero.ledger.registrars.size()).toEqual(0n);
    expect(vero.ledger.registrars.member(JOURNALIST)).toBe(false);
  });

  it('appoints a registrar for an issuer type', () => {
    vero.as(GOVERNANCE).appointRegistrar(JOURNALIST, PRESS_COUNCIL);

    expect(vero.ledger.registrars.size()).toEqual(1n);
    expect(toHex(vero.ledger.registrars.lookup(JOURNALIST))).toEqual(toHex(PRESS_COUNCIL));
  });

  it('appoints a different registrar for each issuer type', () => {
    vero.as(GOVERNANCE).appointRegistrar(JOURNALIST, PRESS_COUNCIL);
    vero.as(GOVERNANCE).appointRegistrar(SURGEON, MEDICAL_BOARD);

    expect(vero.ledger.registrars.size()).toEqual(2n);
    expect(toHex(vero.ledger.registrars.lookup(SURGEON))).toEqual(toHex(MEDICAL_BOARD));
  });

  it('rejects anyone who does not hold the governance secret', () => {
    expect(() => {
      vero.as(actor({ governanceSecret: secretFor('impostor') })).appointRegistrar(JOURNALIST, PRESS_COUNCIL);
    }).toThrow('Caller is not governance');

    expect(vero.ledger.registrars.size()).toEqual(0n);
  });

  it('rejects a registrar appointing its own peers — granting is not appointing', () => {
    expect(() => {
      vero.as(PRESS).appointRegistrar(SURGEON, MEDICAL_BOARD);
    }).toThrow('Caller is not governance');
  });
});

describe('registerCredential', () => {
  let vero: VeroSimulator;

  beforeEach(() => {
    vero = deploy();
    vero.as(GOVERNANCE).appointRegistrar(JOURNALIST, PRESS_COUNCIL);
    vero.as(GOVERNANCE).appointRegistrar(SURGEON, MEDICAL_BOARD);
  });

  it('lets the appointed registrar grant a credential of its own type', () => {
    vero.as(PRESS).registerCredential(SOURCE_SUBJECT, JOURNALIST, EXPIRY);

    expect(vero.ledger.credentialRegistry.firstFree()).toEqual(1n);
    const path = vero.ledger.credentialRegistry.findPathForLeaf(SOURCE_LEAF);
    expect(path).toBeDefined();
    expect(toHex(path!.leaf)).toEqual(toHex(SOURCE_LEAF));
  });

  it('stops a registrar granting a credential of somebody else’s type', () => {
    // The point of the whole change. A medical board is authoritative about
    // surgeons and has no standing to accredit journalists — and now cannot,
    // whatever the subject asks it for.
    expect(() => {
      vero.as(MEDICAL).registerCredential(SOURCE_SUBJECT, JOURNALIST, EXPIRY);
    }).toThrow('Caller is not the registrar for this issuer type');

    expect(vero.ledger.credentialRegistry.firstFree()).toEqual(0n);
  });

  it('rejects a registrar that was never appointed', () => {
    expect(() => {
      vero.as(actor({ registrarSecret: secretFor('self-appointed') })).registerCredential(SOURCE_SUBJECT, JOURNALIST, EXPIRY);
    }).toThrow('Caller is not the registrar for this issuer type');
  });

  it('rejects an issuer type nobody has been appointed for', () => {
    expect(() => {
      vero.as(PRESS).registerCredential(SOURCE_SUBJECT, UNCLAIMED, EXPIRY);
    }).toThrow('No registrar for this issuer type');
  });

  it('puts the credential where the registrar said, not where the subject asked', () => {
    // The subject contributes a commitment to a secret and nothing else. The
    // issuer type and expiry come from the registrar, so a subject cannot
    // shop around for the registrar easiest to convince and still land a leaf
    // that reads "journalist".
    vero.as(MEDICAL).registerCredential(SOURCE_SUBJECT, SURGEON, EXPIRY);

    expect(vero.ledger.credentialRegistry.findPathForLeaf(SOURCE_LEAF)).toBeUndefined();
    expect(
      vero.ledger.credentialRegistry.findPathForLeaf(leafFor(SOURCE_SECRET, MEDICAL_BOARD, SURGEON, EXPIRY)),
    ).toBeDefined();
  });
});

describe('verifySource', () => {
  describe('with a registered, unexpired credential', () => {
    let vero: VeroSimulator;

    beforeEach(() => {
      vero = withCredentialedSource();
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
      expect(toHex(vero.ledger.verifiedPosts.lookup(POST))).not.toEqual(toHex(SOURCE_LEAF));
    });
  });

  describe('rejections', () => {
    let vero: VeroSimulator;

    beforeEach(() => {
      vero = withCredentialedSource();
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

    it('rejects an issuer type nobody has been appointed for', () => {
      expect(() => {
        vero.as(SOURCE).at(NOW).verifySource(POST, UNCLAIMED, EXPIRY);
      }).toThrow('No registrar for this issuer type');
    });

    it('rejects a surgeon claiming to be a journalist', () => {
      // A real credential, granted by a real registrar, proven under a type it
      // was not granted for. The issuer type is in the leaf, so the claim
      // derives a leaf that is not the one in the tree.
      const vero = deploy();
      vero.as(GOVERNANCE).appointRegistrar(JOURNALIST, PRESS_COUNCIL);
      vero.as(GOVERNANCE).appointRegistrar(SURGEON, MEDICAL_BOARD);
      vero.as(MEDICAL).registerCredential(SOURCE_SUBJECT, SURGEON, EXPIRY);

      const surgeon = actor({
        credentialSecret: SOURCE_SECRET,
        credentialLeaf: leafFor(SOURCE_SECRET, MEDICAL_BOARD, SURGEON, EXPIRY),
      });

      expect(() => {
        vero.as(surgeon).at(NOW).verifySource(POST, JOURNALIST, EXPIRY);
      }).toThrow('Merkle path does not belong to this credential');
    });

    it('rejects a valid path presented by someone who does not know the secret', () => {
      // The registry's leaves are public, so anyone can compute a genuine path
      // for someone else's credential. Only `assert(path.leaf == leaf)` stops
      // that path being enough on its own. This is the forgery guard.
      const impostor = actor({ credentialSecret: secretFor('impostor'), credentialLeaf: SOURCE_LEAF });

      expect(() => {
        vero.as(impostor).at(NOW).verifySource(POST, JOURNALIST, EXPIRY);
      }).toThrow('Merkle path does not belong to this credential');
    });

    it('rejects a credential registered somewhere else', () => {
      // A path that is internally consistent — its leaf is the prover's own —
      // but was built against a different registry. Only `checkRoot` catches
      // this one.
      const elsewhere = withCredentialedSource();
      const foreignPath = elsewhere.ledger.credentialRegistry.findPathForLeaf(SOURCE_LEAF)!;

      const here = deploy({
        witnesses: {
          credentialPath: ({ privateState }: { privateState: VeroPrivateState }): [VeroPrivateState, MerklePath] => [
            privateState,
            foreignPath,
          ],
        },
      });
      here.as(GOVERNANCE).appointRegistrar(JOURNALIST, PRESS_COUNCIL);
      here.as(PRESS).registerCredential(deriveSubjectCommitment(secretFor('somebody else')), JOURNALIST, EXPIRY);

      expect(() => {
        here.as(SOURCE).at(NOW).verifySource(POST, JOURNALIST, EXPIRY);
      }).toThrow('Credential is not in the registry');

      expect(here.ledger.verifiedPosts.size()).toEqual(0n);
    });

    it('rejects a credential that was never granted at all', () => {
      const unregistered = actor({
        credentialSecret: secretFor('never-granted'),
        credentialLeaf: leafFor(secretFor('never-granted'), PRESS_COUNCIL, JOURNALIST, EXPIRY),
      });

      // The witness cannot even produce a path — there is no leaf to find. The
      // failure surfaces before the circuit runs, with an explanation rather
      // than a bare assert.
      expect(() => {
        vero.as(unregistered).at(NOW).verifySource(POST, JOURNALIST, EXPIRY);
      }).toThrow('not in the on-chain registry');
    });
  });

  describe('when governance replaces a registrar', () => {
    it('stops honouring the credentials the previous registrar granted', () => {
      // Governance replaces a registrar for one reason: the old one should no
      // longer be trusted. Binding the granting registrar into the leaf is
      // what makes that stick — the alternative would silently transfer every
      // credential the compromised body issued to its replacement.
      const vero = withCredentialedSource();
      vero.as(SOURCE).at(NOW).verifySource(POST, JOURNALIST, EXPIRY);
      expect(vero.ledger.verifiedPosts.size()).toEqual(1n);

      vero.as(GOVERNANCE).appointRegistrar(JOURNALIST, MEDICAL_BOARD);

      expect(() => {
        vero.as(SOURCE).at(NOW).verifySource(OTHER_POST, JOURNALIST, EXPIRY);
      }).toThrow('Merkle path does not belong to this credential');

      // Posts verified while the old registrar stood are left as they were.
      expect(vero.ledger.verifiedPosts.size()).toEqual(1n);
    });
  });

  describe('the expiry boundary', () => {
    let vero: VeroSimulator;

    beforeEach(() => {
      vero = withCredentialedSource();
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

      const vero = deploy();
      vero.as(GOVERNANCE).appointRegistrar(JOURNALIST, PRESS_COUNCIL);
      vero.as(PRESS).registerCredential(deriveSubjectCommitment(secret), JOURNALIST, expiryInMillis);

      // Twenty years after the credential was meant to lapse.
      const longAfter = Number(EXPIRY) + 20 * 365 * 24 * 60 * 60;
      const holder = actor({
        credentialSecret: secret,
        credentialLeaf: leafFor(secret, PRESS_COUNCIL, JOURNALIST, expiryInMillis),
      });
      vero.as(holder).at(longAfter).verifySource(POST, JOURNALIST, expiryInMillis);

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
