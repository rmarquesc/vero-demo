'use client';

/**
 * Publisher side: connect a Midnight wallet, prove a credential in the
 * browser, and record a post as verified.
 *
 * This is the half that needs a wallet. The reader half deliberately does not
 * — see lib/vero.ts — so a failure here never takes the reader view down with
 * it.
 */

import type { ConnectedAPI } from '@midnight-ntwrk/dapp-connector-api';

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
 * Methods this app will call, announced up front so a wallet that asks for
 * permission per method can ask once, at connect time, rather than halfway
 * through a proof.
 */
const WALLET_METHODS = [
  'getShieldedAddresses',
  'getUnshieldedAddress',
  'getProvingProvider',
  'balanceUnsealedTransaction',
  'submitTransaction',
] as const;

export type ConnectedWallet = {
  api: ConnectedAPI;
  name: string;
  address: string;
};

/**
 * Any injected Midnight wallet will do — the connector API is what matters,
 * not the brand. The bridge picks whichever speaks connector v4.
 */
export async function connectWallet(networkId: string): Promise<ConnectedWallet> {
  const { selectWallet, connectToWallet, connectorWalletProvider } = await import(
    './wallet-bridge'
  );
  const wallet = selectWallet((globalThis as any).midnight);
  const api = await connectToWallet(wallet, networkId);

  try {
    await api.hintUsage([...WALLET_METHODS]);
  } catch {
    // A hint, not a requirement: wallets that do not implement it still work.
  }

  // Built once here and thrown away, so that keys the bridge cannot read fail
  // at connect time — next to the button that caused it — and not after the
  // proof has already been generated.
  await connectorWalletProvider(api, networkId);

  const { unshieldedAddress } = await api.getUnshieldedAddress();
  return { api, name: wallet.name, address: unshieldedAddress };
}

// ─── Proving ───────────────────────────────────────────────────────────────────

const ZK_BASE = '/zk/vero';

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

/**
 * Who generates the proof. `wallet` hands it to the wallet through the
 * connector, so the page needs nothing running locally — the only option for
 * a hosted deployment. `proof-server` uses a proof server at a URL the app
 * chooses, which is what the CLI does and the easier one to debug.
 */
export type Proving = 'wallet' | 'proof-server';

export type VerifyArgs = {
  walletApi: ConnectedAPI;
  contractAddress: string;
  indexerUri: string;
  indexerWsUri: string;
  proving: Proving;
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
    { dappConnectorProofProvider },
    { indexerPublicDataProvider },
    { FetchZkConfigProvider },
    { CostModel },
    { connectorWalletProvider },
  ] = await Promise.all([
    import('@midnight-ntwrk/midnight-js-network-id'),
    import('@midnight-ntwrk/midnight-js-protocol/compact-js'),
    import('@midnight-ntwrk/midnight-js-contracts'),
    import('@midnight-ntwrk/midnight-js-http-client-proof-provider'),
    import('@midnight-ntwrk/midnight-js-dapp-connector-proof-provider'),
    import('@midnight-ntwrk/midnight-js-indexer-public-data-provider'),
    import('@midnight-ntwrk/midnight-js-fetch-zk-config-provider'),
    import('@midnight-ntwrk/midnight-js-protocol/ledger'),
    import('./wallet-bridge'),
  ]);

  setNetworkId(args.networkId as never);

  // Bundled, not fetched: the generated module imports compact-runtime by bare
  // specifier, which only the bundler can resolve. `npm run sync:assets` copies
  // it into lib/generated after every compile.
  const Vero: any = await import('@/lib/generated/vero/index.js');

  const secret = fromHex(args.credential.secretHex);
  const issuerType = encodeIssuerType(args.credential.issuerType);
  const expiry = BigInt(args.credential.expirySeconds);
  // Publishers hold a credential and nothing else: no registrar authority, no
  // governance authority.
  const privateState = {
    credentialSecret: secret,
    registrarSecret: new Uint8Array(32),
    governanceSecret: new Uint8Array(32),
  };

  const witnesses = {
    credentialSecret: ({ privateState: ps }: any) => [ps, ps.credentialSecret],
    registrarSecret: ({ privateState: ps }: any) => [ps, ps.registrarSecret],
    governanceSecret: ({ privateState: ps }: any) => [ps, ps.governanceSecret],
    credentialPath: ({ ledger, privateState: ps }: any) => {
      // The leaf is derived here rather than carried in private state, because
      // it depends on which registrar the contract currently recognises for
      // this issuer type — and that is ledger state, readable only from inside
      // the witness.
      if (!ledger.registrars.member(issuerType)) {
        throw new Error(
          `No registrar is appointed on-chain for "${args.credential.issuerType}", so ` +
            'nothing of that kind can be proven yet.',
        );
      }
      const leaf: Uint8Array = Vero.pureCircuits.deriveCredentialLeaf(
        Vero.pureCircuits.deriveSubjectCommitment(ps.credentialSecret),
        ledger.registrars.lookup(issuerType),
        issuerType,
        expiry,
      );
      const found = ledger.credentialRegistry.findPathForLeaf(leaf);
      if (!found) {
        throw new Error(
          'This credential is not in the on-chain registry. A registrar has to grant it ' +
            'before it can prove anything — and note that the granting registrar, the ' +
            'issuer type and the expiry are all bound into the leaf, so a mismatch in ' +
            'any of them produces a different one.',
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

  // callTx proves, balances, submits and waits in one call, so the stages are
  // reported from inside the providers — otherwise the page would say
  // "generating the proof" while the wallet is already asking for a signature.
  const bridge = await connectorWalletProvider(args.walletApi, args.networkId);
  const walletProvider = {
    ...bridge,
    balanceTx: (tx: Parameters<typeof bridge.balanceTx>[0], ttl?: Date) => {
      say('submitting', 'approve the transaction in your wallet');
      return bridge.balanceTx(tx, ttl);
    },
    submitTx: async (tx: Parameters<typeof bridge.submitTx>[0]) => {
      const txId = await bridge.submitTx(tx);
      say('submitting', 'submitted — waiting for it to land in a block');
      return txId;
    },
  };

  const proofProvider =
    args.proving === 'wallet'
      ? await dappConnectorProofProvider(
          args.walletApi,
          zkConfigProvider,
          CostModel.initialCostModel(),
        )
      : httpClientProofProvider(args.proofServerUri, zkConfigProvider);

  const providers = {
    privateStateProvider: createPrivateStateProvider(),
    publicDataProvider: createPublicDataProvider(
      args.indexerUri,
      args.indexerWsUri,
      indexerPublicDataProvider(args.indexerUri, args.indexerWsUri),
    ),
    zkConfigProvider,
    proofProvider,
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

  say(
    'proving',
    args.proving === 'wallet'
      ? 'your wallet is generating the zero-knowledge proof'
      : 'generating the zero-knowledge proof',
  );

  const postHash = await hashPost(args.postContent);
  const tx = await deployed.callTx.verifySource(postHash, issuerType, expiry);

  return { txId: tx.public.txId, blockHeight: tx.public.blockHeight };
}
