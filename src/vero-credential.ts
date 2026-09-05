/**
 * Credential secret, private state and witness wiring for the Vero contract.
 *
 * The Vero circuit proves that the prover holds a secret whose commitment
 * matches the one stored on-chain, without the secret ever leaving this
 * process. That secret therefore has to survive between `npm run deploy`
 * (which derives the commitment from it) and `npm run cli` (which proves
 * against it) — hence the on-disk file.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Gitignored: this is the demo issuer's credential secret. */
const SECRET_FILE = path.resolve(__dirname, '..', '.vero-credential');

const SECRET_BYTES = 32;

/** Private state the witness reads from. */
export type VeroPrivateState = {
  readonly credentialSecret: Uint8Array;
};

export const createPrivateState = (credentialSecret: Uint8Array): VeroPrivateState => ({
  credentialSecret,
});

/**
 * Implements the contract's `witness credentialSecret(): Bytes<32>`.
 *
 * Compact witnesses return [nextPrivateState, value]. Reading the secret
 * doesn't mutate anything, so the state is passed straight back.
 */
export const witnesses = {
  credentialSecret: ({ privateState }: { privateState: VeroPrivateState }): [VeroPrivateState, Uint8Array] => [
    privateState,
    privateState.credentialSecret,
  ],
};

function parseHexSecret(hex: string, source: string): Uint8Array {
  const clean = hex.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length !== SECRET_BYTES * 2) {
    throw new Error(
      `Invalid credential secret in ${source}: expected ${SECRET_BYTES * 2} hex characters, got ${clean.length}.`,
    );
  }
  return Uint8Array.from(Buffer.from(clean, 'hex'));
}

/**
 * Resolution order: VERO_CREDENTIAL_SECRET env var, then the local file,
 * then a freshly generated secret written to that file.
 *
 * Deploy and CLI must agree on the secret or every proof fails the
 * commitment assertion, so generation happens exactly once.
 */
export function loadOrCreateCredentialSecret(): { secret: Uint8Array; source: 'env' | 'file' | 'generated' } {
  const fromEnv = process.env.VERO_CREDENTIAL_SECRET?.trim();
  if (fromEnv) {
    return { secret: parseHexSecret(fromEnv, 'VERO_CREDENTIAL_SECRET'), source: 'env' };
  }

  if (fs.existsSync(SECRET_FILE)) {
    return { secret: parseHexSecret(fs.readFileSync(SECRET_FILE, 'utf8'), SECRET_FILE), source: 'file' };
  }

  const secret = Uint8Array.from(crypto.randomBytes(SECRET_BYTES));
  fs.writeFileSync(SECRET_FILE, Buffer.from(secret).toString('hex') + '\n', { mode: 0o600 });
  return { secret, source: 'generated' };
}

/** Hash arbitrary post content into the Bytes<32> the circuit expects. */
export function hashPost(content: string): Uint8Array {
  return Uint8Array.from(crypto.createHash('sha256').update(content, 'utf8').digest());
}

export const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
