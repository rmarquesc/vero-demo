/**
 * Credential material, private state and witness wiring for the Vero contract.
 *
 * The commitment stored on-chain binds three things together — the secret, the
 * issuer type and the expiry — so all three have to be identical at deploy
 * time (which derives the commitment) and at proof time (which proves against
 * it). They are kept together in one file for that reason.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Gitignored: this is the demo issuer's credential. */
const CREDENTIAL_FILE = path.resolve(__dirname, '..', '.vero-credential');

const SECRET_BYTES = 32;
const DEFAULT_ISSUER_TYPE = 'journalist:accredited';
const DEFAULT_VALIDITY_SECONDS = 365 * 24 * 60 * 60;

/**
 * Expiry is in SECONDS, because that is the unit Midnight's block time uses.
 *
 * This is worth stating loudly: getting it wrong fails silently open. Pass a
 * millisecond timestamp and every comparison against block time (~1.8e9)
 * trivially succeeds against a ~1.8e12 bound, so `blockTimeLessThan` returns
 * true forever and an expired credential sails through. Verified on the local
 * devnet — a past expiry in milliseconds was accepted, the same instant
 * expressed in seconds was rejected with "Credential has expired".
 */
const MAX_PLAUSIBLE_EXPIRY_SECONDS = 4_102_444_800; // 2100-01-01

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export type VeroCredential = {
  readonly secret: Uint8Array;
  readonly issuerType: string;
  /** Unix timestamp in SECONDS — see the note above. */
  readonly expirySeconds: number;
  /**
   * Authority to add credentials to the registry. Held by whoever runs the
   * demo issuer; a real deployment would not keep this next to a subject's
   * credential, but the demo plays both roles from one machine.
   */
  readonly registrarSecret: Uint8Array;
};

/**
 * Guards against the millisecond mistake, which otherwise disables expiry
 * checking without any visible symptom.
 */
function assertPlausibleExpiry(value: number, source: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`Expiry from ${source} is not a number: ${value}`);
  }
  if (value > MAX_PLAUSIBLE_EXPIRY_SECONDS) {
    throw new Error(
      `Expiry from ${source} is ${value}, which is past the year 2100 — this is almost\n` +
        `certainly a millisecond timestamp. Block time is compared in seconds, and a\n` +
        `millisecond value makes every expiry check pass. Divide by 1000.`,
    );
  }
  return value;
}

/**
 * Private state behind the three witnesses. It carries the derived commitment
 * as well as the secret, because credentialPath has to look the leaf up in the
 * on-chain tree and the circuit's arguments are not visible to a witness.
 */
export type VeroPrivateState = {
  readonly credentialSecret: Uint8Array;
  readonly credentialCommitment: Uint8Array;
  readonly registrarSecret: Uint8Array;
};

export const createPrivateState = (
  credentialSecret: Uint8Array,
  credentialCommitment: Uint8Array,
  registrarSecret: Uint8Array,
): VeroPrivateState => ({ credentialSecret, credentialCommitment, registrarSecret });

type MerklePath = { leaf: Uint8Array; path: { sibling: { field: bigint }; goes_left: boolean }[] };

/**
 * Implements the contract's three witnesses.
 *
 * credentialPath reads the live registry out of the witness context and
 * derives the membership path from it, so the path is always against the
 * current root — which is why the contract can use a plain MerkleTree instead
 * of a HistoricMerkleTree.
 */
export const witnesses = {
  credentialSecret: ({ privateState }: { privateState: VeroPrivateState }): [VeroPrivateState, Uint8Array] => [
    privateState,
    privateState.credentialSecret,
  ],

  registrarSecret: ({ privateState }: { privateState: VeroPrivateState }): [VeroPrivateState, Uint8Array] => [
    privateState,
    privateState.registrarSecret,
  ],

  credentialPath: ({ ledger, privateState }: { ledger: any; privateState: VeroPrivateState }): [VeroPrivateState, MerklePath] => {
    const found = ledger.credentialRegistry.findPathForLeaf(privateState.credentialCommitment);
    if (!found) {
      throw new Error(
        'This credential is not in the on-chain registry, so no membership path exists.\n' +
          'Register it first (npm run register) — or, if it was registered under a different\n' +
          'issuer type or expiry, those are bound into the commitment and produce a different leaf.',
      );
    }
    return [privateState, found];
  },
};

// ─── Encoding ──────────────────────────────────────────────────────────────────

/**
 * Encode a label as the Bytes<32> the circuit takes. The circuit treats these
 * as opaque bytes — it only hashes and stores them — so the sole requirement
 * is that deploy and CLI encode identically.
 */
export function encodeIssuerType(label: string): Uint8Array {
  const bytes = Buffer.from(label, 'utf8');
  if (bytes.length > 32) {
    throw new Error(`Issuer type "${label}" is ${bytes.length} bytes; the field holds 32.`);
  }
  const padded = Buffer.alloc(32);
  bytes.copy(padded);
  return Uint8Array.from(padded);
}

export function decodeIssuerType(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8').replace(/\0+$/, '');
}

export const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/** Hash arbitrary post content into the Bytes<32> the circuit expects. */
export function hashPost(content: string): Uint8Array {
  return Uint8Array.from(crypto.createHash('sha256').update(content, 'utf8').digest());
}

// ─── Loading ───────────────────────────────────────────────────────────────────

function parseHexSecret(hex: string, source: string): Uint8Array {
  const clean = hex.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length !== SECRET_BYTES * 2) {
    throw new Error(
      `Invalid credential secret in ${source}: expected ${SECRET_BYTES * 2} hex characters, got ${clean.length}.`,
    );
  }
  return Uint8Array.from(Buffer.from(clean, 'hex'));
}

function readFromFile(): VeroCredential | null {
  if (!fs.existsSync(CREDENTIAL_FILE)) return null;
  const raw = fs.readFileSync(CREDENTIAL_FILE, 'utf8').trim();

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // v1 wrote a bare hex secret. The commitment scheme has changed shape
    // since (it now binds issuer type and expiry too), so an old file cannot
    // be upgraded into a working credential — the deployed contract it
    // matches is on the old scheme.
    throw new Error(
      `${CREDENTIAL_FILE} is in the old bare-secret format. The commitment now binds\n` +
        `the issuer type and expiry as well, so this credential cannot satisfy the current\n` +
        `contract. Delete the file and redeploy to start over.`,
    );
  }

  return {
    secret: parseHexSecret(parsed.secret ?? '', CREDENTIAL_FILE),
    issuerType: parsed.issuerType ?? DEFAULT_ISSUER_TYPE,
    expirySeconds: assertPlausibleExpiry(Number(parsed.expirySeconds), CREDENTIAL_FILE),
    registrarSecret: parseHexSecret(parsed.registrarSecret ?? '', `${CREDENTIAL_FILE} (registrarSecret)`),
  };
}

function writeToFile(credential: VeroCredential): void {
  const body = {
    secret: toHex(credential.secret),
    issuerType: credential.issuerType,
    expirySeconds: credential.expirySeconds,
    registrarSecret: toHex(credential.registrarSecret),
    _note:
      'Demo credential and registrar authority. The credential commitment binds secret, ' +
      'issuerType and expiry; expiry is in SECONDS.',
  };
  fs.writeFileSync(CREDENTIAL_FILE, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 });
}

/**
 * Resolution order: environment, then the local file, then freshly generated.
 * Environment values override individual fields so CI can pin an expiry
 * without also having to pin the secret.
 */
export function loadOrCreateCredential(): { credential: VeroCredential; source: 'env' | 'file' | 'generated' } {
  const envSecret = process.env.VERO_CREDENTIAL_SECRET?.trim();
  const envIssuer = process.env.VERO_ISSUER_TYPE?.trim();
  const envExpiry = process.env.VERO_CREDENTIAL_EXPIRY?.trim();

  const fromFile = envSecret ? null : readFromFile();

  if (envSecret || envIssuer || envExpiry) {
    const secret = envSecret ? parseHexSecret(envSecret, 'VERO_CREDENTIAL_SECRET') : fromFile?.secret;
    if (!secret) {
      throw new Error('VERO_ISSUER_TYPE/VERO_CREDENTIAL_EXPIRY set without a secret to go with them.');
    }
    const expirySeconds = envExpiry
      ? assertPlausibleExpiry(Number(envExpiry), 'VERO_CREDENTIAL_EXPIRY')
      : (fromFile?.expirySeconds ?? nowSeconds() + DEFAULT_VALIDITY_SECONDS);
    const registrarSecret =
      process.env.VERO_REGISTRAR_SECRET?.trim()
        ? parseHexSecret(process.env.VERO_REGISTRAR_SECRET.trim(), 'VERO_REGISTRAR_SECRET')
        : fromFile?.registrarSecret;
    if (!registrarSecret) {
      throw new Error('No registrar secret available — set VERO_REGISTRAR_SECRET or keep .vero-credential.');
    }
    return {
      credential: {
        secret,
        issuerType: envIssuer ?? fromFile?.issuerType ?? DEFAULT_ISSUER_TYPE,
        expirySeconds,
        registrarSecret,
      },
      source: 'env',
    };
  }

  if (fromFile) return { credential: fromFile, source: 'file' };

  const credential: VeroCredential = {
    secret: Uint8Array.from(crypto.randomBytes(SECRET_BYTES)),
    issuerType: DEFAULT_ISSUER_TYPE,
    expirySeconds: nowSeconds() + DEFAULT_VALIDITY_SECONDS,
    registrarSecret: Uint8Array.from(crypto.randomBytes(SECRET_BYTES)),
  };
  writeToFile(credential);
  return { credential, source: 'generated' };
}

/** Human-readable summary for the deploy and CLI banners. */
export function describeCredential(c: VeroCredential): string {
  const when = new Date(c.expirySeconds * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const state = c.expirySeconds > nowSeconds() ? 'valid until' : 'EXPIRED since';
  return `${c.issuerType} — ${state} ${when} UTC`;
}
