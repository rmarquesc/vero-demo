/**
 * The wallet half of the bridge between a browser wallet and midnight-js.
 *
 * Browser wallets speak the DApp Connector API v4: transactions cross the
 * boundary as hex-serialized strings, keys come back as Bech32m, and
 * `submitTransaction` resolves to nothing. midnight-js 4.1.1 expects a
 * `WalletProvider` and a `MidnightProvider` that take and return transaction
 * objects, keys as hex, and a transaction id from submission. Midnight ships
 * an adapter for the proving half (midnight-js-dapp-connector-proof-provider)
 * and none for this half, so this file is it.
 *
 * Kept free of React and of the contract so it can be tested in Node against
 * real ledger transactions — see test/wallet-bridge.test.ts.
 */
import type { ConnectedAPI, InitialAPI } from '@midnight-ntwrk/dapp-connector-api';
import {
  Transaction,
  type Binding,
  type FinalizedTransaction,
  type Proof,
  type SignatureEnabled,
  type TransactionId,
} from '@midnight-ntwrk/midnight-js-protocol/ledger';
import type {
  MidnightProvider,
  UnboundTransaction,
  WalletProvider,
} from '@midnight-ntwrk/midnight-js-types';
import {
  fromHex,
  parseCoinPublicKeyToHex,
  parseEncPublicKeyToHex,
  toHex,
} from '@midnight-ntwrk/midnight-js-utils';

/** The connector major version this bridge is written against. */
export const CONNECTOR_API_MAJOR = 4;

// ─── Finding and connecting to a wallet ────────────────────────────────────────

/**
 * Pick a wallet that speaks connector v4 from whatever is injected under
 * `window.midnight`. A wallet may inject several entries, one per API version
 * it supports, so this goes by `apiVersion` rather than by brand.
 */
export function selectWallet(injected: unknown): InitialAPI {
  if (!injected || typeof injected !== 'object') {
    throw new Error(
      'No Midnight wallet found. Install one (1AM or Lace), unlock it, and reload this page.',
    );
  }
  const candidates = Object.values(injected as Record<string, unknown>).filter(
    (w): w is InitialAPI =>
      !!w && typeof w === 'object' && typeof (w as InitialAPI).connect === 'function',
  );
  const compatible = candidates.find(
    (w) => Number(String(w.apiVersion ?? '').split('.')[0]) === CONNECTOR_API_MAJOR,
  );
  if (compatible) return compatible;

  const found = candidates.map((w) => `${w.name ?? 'unnamed'} (API ${w.apiVersion ?? '?'})`);
  throw new Error(
    found.length
      ? `Found ${found.join(', ')}, but this app needs DApp Connector API ${CONNECTOR_API_MAJOR}.x. ` +
          'Update the wallet.'
      : 'window.midnight exists but exposes no wallet.',
  );
}

/**
 * Connect, then confirm the wallet is on the network the app expects. A
 * wallet on the wrong network otherwise fails later with an error that does
 * not say so — checking here names the actual problem.
 */
export async function connectToWallet(
  wallet: InitialAPI,
  networkId: string,
): Promise<ConnectedAPI> {
  const api = await wallet.connect(networkId);
  const status = await api.getConnectionStatus();
  if (status.status !== 'connected') {
    throw new Error(`${wallet.name} did not stay connected. Unlock it and try again.`);
  }
  if (status.networkId !== networkId) {
    throw new Error(
      `${wallet.name} is on "${status.networkId}", but this app is on "${networkId}". ` +
        'Switch the wallet to the same network and reconnect.',
    );
  }
  return api;
}

// ─── The adapter ───────────────────────────────────────────────────────────────

export type ConnectorWallet = Pick<
  ConnectedAPI,
  'getShieldedAddresses' | 'balanceUnsealedTransaction' | 'submitTransaction'
>;

/**
 * A midnight-js `WalletProvider` and `MidnightProvider` backed by a connected
 * browser wallet.
 *
 * Async because the keys have to be fetched once up front: midnight-js reads
 * them synchronously, the connector only hands them over asynchronously.
 */
export async function connectorWalletProvider(
  api: ConnectorWallet,
  networkId: string,
): Promise<WalletProvider & MidnightProvider> {
  const keys = await api.getShieldedAddresses();
  // The connector returns Bech32m; the ledger and the compact runtime want
  // hex. midnight-js normalises keys on some paths and not others, so they
  // are normalised once here rather than trusted to be.
  const coinPublicKey = parseCoinPublicKeyToHex(keys.shieldedCoinPublicKey, networkId);
  const encryptionPublicKey = parseEncPublicKeyToHex(keys.shieldedEncryptionPublicKey, networkId);

  return {
    getCoinPublicKey: () => coinPublicKey,
    getEncryptionPublicKey: () => encryptionPublicKey,

    // `ttl` has nowhere to go: the connector takes no TTL and the wallet sets
    // its own. A contract call is proven but not yet bound, which is what
    // `balanceUnsealedTransaction` expects — `balanceSealedTransaction` cannot
    // balance contracts with fallible sections.
    async balanceTx(tx: UnboundTransaction, _ttl?: Date): Promise<FinalizedTransaction> {
      const { tx: balanced } = await api.balanceUnsealedTransaction(toHex(tx.serialize()));
      return Transaction.deserialize<SignatureEnabled, Proof, Binding>(
        'signature',
        'proof',
        'binding',
        fromHex(balanced),
      );
    },

    // The connector resolves to nothing, so the id comes from the transaction
    // itself. Any of its identifiers can be watched for on the indexer; the
    // wallet SDK and Midnight's own example DApp both take one the same way.
    async submitTx(tx: FinalizedTransaction): Promise<TransactionId> {
      const [txId] = tx.identifiers();
      if (!txId) throw new Error('The balanced transaction carries no identifier to watch for.');
      await api.submitTransaction(toHex(tx.serialize()));
      return txId;
    },
  };
}
