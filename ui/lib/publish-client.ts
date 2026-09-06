'use client';

/**
 * Publisher side: connect a Midnight wallet, prove a credential in the
 * browser, and record a post as verified.
 *
 * This is the half that needs a wallet. The reader half deliberately does not
 * — see lib/vero.ts — so a failure here never takes the reader view down with
 * it.
 */

export type Stage =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'loading-contract'
  | 'proving'
  | 'submitting'
  | 'done'
  | 'error';

export type VerifyResult = { txId: string; blockHeight?: string | number };

/** 32-byte credential secret, hex. Kept per-browser; never sent anywhere. */
const SECRET_KEY = 'vero.credentialSecret';
const ISSUER_KEY = 'vero.issuerType';
const EXPIRY_KEY = 'vero.expirySeconds';

export type StoredCredential = {
  secretHex: string;
  issuerType: string;
  expirySeconds: number;
};

export function loadCredential(): StoredCredential | null {
  try {
    const secretHex = localStorage.getItem(SECRET_KEY);
    const issuerType = localStorage.getItem(ISSUER_KEY);
    const expiry = localStorage.getItem(EXPIRY_KEY);
    if (!secretHex || !issuerType || !expiry) return null;
    return { secretHex, issuerType, expirySeconds: Number(expiry) };
  } catch {
    return null;
  }
}

export function saveCredential(c: StoredCredential): void {
  localStorage.setItem(SECRET_KEY, c.secretHex.trim().replace(/^0x/, ''));
  localStorage.setItem(ISSUER_KEY, c.issuerType.trim());
  localStorage.setItem(EXPIRY_KEY, String(c.expirySeconds));
}

export function clearCredential(): void {
  [SECRET_KEY, ISSUER_KEY, EXPIRY_KEY].forEach((k) => localStorage.removeItem(k));
}

// ─── Encoding — must match src/vero-credential.ts exactly ──────────────────────

export const fromHex = (s: string): Uint8Array =>
  Uint8Array.from((s.replace(/^0x/, '').match(/../g) ?? []).map((b) => parseInt(b, 16)));

export const toHex = (b: Uint8Array): string =>
  Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');

/** UTF-8, right-padded with zeros to 32 bytes. */
export function encodeIssuerType(label: string): Uint8Array {
  const bytes = new TextEncoder().encode(label);
  if (bytes.length > 32) throw new Error(`Issuer type is ${bytes.length} bytes; the field holds 32.`);
  const padded = new Uint8Array(32);
  padded.set(bytes);
  return padded;
}

/** SHA-256 of the post text, via SubtleCrypto — the browser's equivalent of hashPost(). */
export async function hashPost(content: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return new Uint8Array(digest);
}

// ─── Wallet ────────────────────────────────────────────────────────────────────

/**
 * Any injected Midnight wallet will do — the connector API is what matters,
 * not the brand. 1AM is preferred because the Midnight template docs target
 * it, but Lace and anything else injecting into window.midnight work the same.
 */
export async function detectWallet(): Promise<any> {
  const injected = (globalThis as any).midnight;
  if (!injected) {
    throw new Error(
      'No Midnight wallet found. Install one (1AM or Lace), unlock it, and reload this page.',
    );
  }
  const preferred = injected['1am'] ?? injected.mnLace ?? Object.values(injected)[0];
  if (!preferred) throw new Error('window.midnight exists but exposes no wallet.');
  return preferred;
}

/**
 * Wallets disagree on the handshake. 1AM exposes `connect()`; the CAIP-style
 * connectors expose `enable()`; some inject the API directly with neither.
 * Trying each in turn is cheaper than special-casing brands, and the errors
 * name what was actually found rather than what was expected.
 */
async function openSession(connector: any): Promise<any> {
  for (const method of ['connect', 'enable'] as const) {
    if (typeof connector[method] === 'function') {
      const api = await connector[method]();
      return api ?? connector;
    }
  }
  if (typeof connector.state === 'function') return connector;
  const surface = Object.keys(connector).join(', ') || '(nothing enumerable)';
  throw new Error(
    `This wallet exposes no way to connect. It offers: ${surface}. ` +
      'Expected connect(), enable(), or a ready API with state().',
  );
}

export async function connectWallet(): Promise<{ api: any; address: string }> {
  const connector = await detectWallet();
  const api = await openSession(connector);

  if (typeof api.state !== 'function') {
    throw new Error(
      `Connected, but the wallet API has no state(). It offers: ${Object.keys(api).join(', ')}`,
    );
  }

  const state = await api.state();
  const address: string =
    state.address ?? state.unshieldedAddress ?? state.addresses?.unshielded ?? '(unknown address)';
  return { api, address };
}

// ─── Proving ───────────────────────────────────────────────────────────────────

const ZK_BASE = '/zk/vero';

function coinPublicKeyToBytes(pk: unknown): Uint8Array {
  if (pk instanceof Uint8Array) return pk.length === 32 ? pk : pk.slice(0, 32);
  if (typeof pk === 'string') return fromHex(pk);
  if (pk && typeof pk === 'object' && 'bytes' in (pk as object)) {
    return coinPublicKeyToBytes((pk as { bytes: unknown }).bytes);
  }
  return new Uint8Array(32);
}

/** In-memory private state. The browser has no LevelDB, and a demo needs none. */
function createPrivateStateProvider() {
  const store = new Map<string, unknown>();
  const signingKeys = new Map<string, unknown>();
  let currentAddress: string | null = null;
  return {
    async get(id: string) { return store.get(id) ?? null; },
    async set(id: string, state: unknown) { store.set(id, state); },
    async remove(id: string) { store.delete(id); },
    async clear() { store.clear(); },
    async setContractAddress(address: string) { currentAddress = address; },
    async getContractAddress() { return currentAddress; },
    async setSigningKey(address: string, key: unknown) { signingKeys.set(address, key); },
    async getSigningKey(address: string) { return signingKeys.get(address) ?? null; },
    async removeSigningKey(address: string) { signingKeys.delete(address); },
    async clearSigningKeys() { signingKeys.clear(); },
  };
}

/**
 * The stock indexer provider sends `offset: null`, which the v4 indexer
 * rejects, so contract-state reads go through a direct query instead.
 */
function createPublicDataProvider(indexerUri: string, indexerWsUri: string, base: any) {
  return {
    ...base,
    async queryContractState(contractAddress: string) {
      const res = await fetch(indexerUri, {
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
          variables: { a: contractAddress },
        }),
      });
      const json = await res.json();
      const stateHex = json?.data?.contractAction?.state;
      if (!stateHex) return null;
      const { ContractState } = await import('@midnight-ntwrk/compact-runtime');
      return ContractState.deserialize(fromHex(stateHex));
    },
  };
}

export type VerifyArgs = {
  walletApi: any;
  contractAddress: string;
  indexerUri: string;
  indexerWsUri: string;
  proofServerUri: string;
  networkId: string;
  credential: StoredCredential;
  postContent: string;
  onStage?: (s: Stage, detail?: string) => void;
};

export async function verifyPost(args: VerifyArgs): Promise<VerifyResult> {
  const say = args.onStage ?? (() => {});

  say('loading-contract');

  const [
    { setNetworkId },
    { CompiledContract },
    { findDeployedContract },
    { httpClientProofProvider },
    { indexerPublicDataProvider },
    { FetchZkConfigProvider },
  ] = await Promise.all([
    import('@midnight-ntwrk/midnight-js-network-id'),
    import('@midnight-ntwrk/midnight-js-protocol/compact-js'),
    import('@midnight-ntwrk/midnight-js-contracts'),
    import('@midnight-ntwrk/midnight-js-http-client-proof-provider'),
    import('@midnight-ntwrk/midnight-js-indexer-public-data-provider'),
    import('@midnight-ntwrk/midnight-js-fetch-zk-config-provider'),
  ]);

  setNetworkId(args.networkId as never);

  // Bundled, not fetched: the generated module imports compact-runtime by bare
  // specifier, which only the bundler can resolve. `npm run sync:assets` copies
  // it into lib/generated after every compile.
  const Vero: any = await import('@/lib/generated/vero/index.js');

  const secret = fromHex(args.credential.secretHex);
  const issuerType = encodeIssuerType(args.credential.issuerType);
  const expiry = BigInt(args.credential.expirySeconds);
  const commitment: Uint8Array = Vero.pureCircuits.deriveCredentialCommitment(
    secret,
    issuerType,
    expiry,
  );

  const privateState = {
    credentialSecret: secret,
    credentialCommitment: commitment,
    registrarSecret: new Uint8Array(32), // publishers are not registrars
  };

  const witnesses = {
    credentialSecret: ({ privateState: ps }: any) => [ps, ps.credentialSecret],
    registrarSecret: ({ privateState: ps }: any) => [ps, ps.registrarSecret],
    credentialPath: ({ ledger, privateState: ps }: any) => {
      const found = ledger.credentialRegistry.findPathForLeaf(ps.credentialCommitment);
      if (!found) {
        throw new Error(
          'This credential is not in the on-chain registry. It has to be registered ' +
            'before it can prove anything — and note that the issuer type and expiry ' +
            'are bound into the commitment, so a mismatch in either produces a ' +
            'different leaf.',
        );
      }
      return [ps, found];
    },
  };

  const compiledContract = (CompiledContract.make('vero', Vero.Contract) as any).pipe(
    (CompiledContract.withWitnesses as any)(witnesses),
    (CompiledContract.withCompiledFileAssets as any)(ZK_BASE),
  );

  const zkConfigProvider = new FetchZkConfigProvider(ZK_BASE, fetch.bind(globalThis));
  const state = await args.walletApi.state();

  const walletProvider = {
    getCoinPublicKey: () => coinPublicKeyToBytes(state.coinPublicKey),
    getEncryptionPublicKey: () => state.encryptionPublicKey,
    balanceTx: (tx: unknown, ttl?: Date) => args.walletApi.balanceTransaction(tx, ttl),
    submitTx: (tx: unknown) => args.walletApi.submitTransaction(tx),
  };

  const providers = {
    privateStateProvider: createPrivateStateProvider(),
    publicDataProvider: createPublicDataProvider(
      args.indexerUri,
      args.indexerWsUri,
      indexerPublicDataProvider(args.indexerUri, args.indexerWsUri),
    ),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(args.proofServerUri, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };

  say('proving', 'connecting to the deployed contract');

  const deployed: any = await findDeployedContract(providers as any, {
    compiledContract: compiledContract as any,
    contractAddress: args.contractAddress,
    privateStateId: 'veroPrivateState',
    initialPrivateState: privateState,
  });

  say('proving', 'generating the zero-knowledge proof');

  const postHash = await hashPost(args.postContent);
  const tx = await deployed.callTx.verifySource(postHash, issuerType, expiry);

  say('submitting');

  return { txId: tx.public.txId, blockHeight: tx.public.blockHeight };
}
