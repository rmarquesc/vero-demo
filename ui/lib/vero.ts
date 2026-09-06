/**
 * Reader-side access to the Vero ledger.
 *
 * Everything here runs on the server. Reading a verification needs no wallet,
 * no proof and no browser SDK — just the indexer's GraphQL endpoint and the
 * contract's own `ledger()` decoder. That is the whole point: a reader should
 * be able to check a source without holding anything.
 */
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

export type NetworkId = 'undeployed' | 'preview' | 'preprod';

const INDEXERS: Record<NetworkId, string> = {
  undeployed: 'http://127.0.0.1:8088/api/v4/graphql',
  preview: 'https://indexer.preview.midnight.network/api/v4/graphql',
  preprod: 'https://indexer.preprod.midnight.network/api/v4/graphql',
};

export const NETWORK = (process.env.VERO_NETWORK as NetworkId) || 'undeployed';
export const INDEXER = INDEXERS[NETWORK];

/** Contract address. Set VERO_CONTRACT, or fall back to .midnight-state.json. */
export function contractAddress(): string | null {
  if (process.env.VERO_CONTRACT) return process.env.VERO_CONTRACT;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    const statePath = path.resolve(process.cwd(), '..', '.midnight-state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return state?.deployments?.[NETWORK]?.address ?? null;
  } catch {
    return null;
  }
}

// ─── Encoding ──────────────────────────────────────────────────────────────────

export const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

const fromHex = (s: string): Uint8Array =>
  Uint8Array.from((s.replace(/^0x/, '').match(/../g) ?? []).map((b) => parseInt(b, 16)));

/** Must match hashPost() in src/vero-credential.ts, or nothing will ever match. */
export function hashPost(content: string): Uint8Array {
  return Uint8Array.from(crypto.createHash('sha256').update(content, 'utf8').digest());
}

/** Issuer types are UTF-8 right-padded to 32 bytes; strip the padding to read them. */
export const decodeIssuerType = (b: Uint8Array): string =>
  Buffer.from(b).toString('utf8').replace(/\0+$/, '');

// ─── Ledger ────────────────────────────────────────────────────────────────────

export type LedgerView = {
  contractAddress: string;
  governanceCommitment: string;
  /** issuer type → the commitment of the registrar entitled to grant it */
  registrars: Map<string, string>;
  verifiedCount: number;
  /** post hash (hex) → issuer type */
  verified: Map<string, string>;
};

/**
 * The default indexer provider sends `offset: null`, which the v4 indexer
 * rejects, so this queries the endpoint directly. It also means the reader
 * path pulls in none of the midnight-js provider stack.
 */
async function fetchContractState(address: string): Promise<string | null> {
  const res = await fetch(INDEXER, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `query ContractState($a: HexEncoded!) {
        contractAction(address: $a) {
          ... on ContractDeploy { state }
          ... on ContractCall { state }
          ... on ContractUpdate { state }
        }
      }`,
      variables: { a: address },
    }),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Indexer returned ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json?.data?.contractAction?.state ?? null;
}

let contractModule: any;

/**
 * The compiled contract lives outside ui/ and is generated, not a dependency,
 * so it has to be loaded at runtime by absolute path.
 *
 * `new Function` is the escape hatch: webpack rewrites a plain `await
 * import(variable)` and then fails to resolve it at build time — "Critical
 * dependency: the request of a dependency is an expression", followed by
 * "Cannot find module" at request time. Hiding the import behind a constructed
 * function leaves it to Node.
 */
const nodeImport: (specifier: string) => Promise<any> = new Function(
  'specifier',
  'return import(specifier)',
) as never;

async function loadContract() {
  if (contractModule) return contractModule;
  const entry = path.resolve(
    process.cwd(),
    '..',
    'contracts',
    'managed',
    'vero',
    'contract',
    'index.js',
  );
  try {
    contractModule = await nodeImport(pathToFileURL(entry).href);
  } catch (e) {
    throw new Error(
      `Compiled contract not found at ${entry}. Run \`npm run compile\` at the repository root. (${
        e instanceof Error ? e.message : e
      })`,
    );
  }
  return contractModule;
}

export async function readLedger(): Promise<LedgerView | null> {
  const address = contractAddress();
  if (!address) return null;

  const stateHex = await fetchContractState(address);
  if (!stateHex) return null;

  const { ContractState } = await nodeImport('@midnight-ntwrk/compact-runtime');
  const { setNetworkId } = await nodeImport('@midnight-ntwrk/midnight-js-network-id');
  setNetworkId(NETWORK as never);

  const Vero = await loadContract();
  const ledger = Vero.ledger(ContractState.deserialize(fromHex(stateHex)).data);

  const verified = new Map<string, string>();
  for (const [postHash, issuerType] of ledger.verifiedPosts) {
    verified.set(toHex(postHash), decodeIssuerType(issuerType));
  }

  const registrars = new Map<string, string>();
  for (const [issuerType, registrar] of ledger.registrars) {
    registrars.set(decodeIssuerType(issuerType), toHex(registrar));
  }

  return {
    contractAddress: address,
    governanceCommitment: toHex(ledger.governanceCommitment),
    registrars,
    verifiedCount: Number(ledger.verifiedPosts.size()),
    verified,
  };
}
