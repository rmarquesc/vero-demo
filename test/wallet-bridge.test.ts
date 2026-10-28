/**
 * The wallet bridge, tested against real ledger transactions and a stand-in
 * wallet that holds it to the DApp Connector v4 contract: transactions arrive
 * as hex strings, an unsealed one must deserialize as unsealed, and submission
 * resolves to nothing.
 *
 * No contract, devnet or browser is involved. What this cannot show is that a
 * real wallet accepts what the bridge sends; that is checked by hand against
 * 1AM, as written down in docs/wave2-wallet-bridge.md.
 */
import { describe, expect, it } from 'vitest';
import type { ConnectedAPI, InitialAPI } from '@midnight-ntwrk/dapp-connector-api';
import {
  CostModel,
  Intent,
  Transaction,
  type ProvingProvider,
} from '@midnight-ntwrk/midnight-js-protocol/ledger';
import type { UnboundTransaction } from '@midnight-ntwrk/midnight-js-types';
import { ShieldedCoinPublicKey, ShieldedEncryptionPublicKey } from '@midnight-ntwrk/wallet-sdk';

import {
  connectToWallet,
  connectorWalletProvider,
  selectWallet,
  type ConnectorWallet,
} from '../ui/lib/wallet-bridge';

const NETWORK = 'undeployed';
const COIN_KEY_HEX = '11'.repeat(32);
const ENC_KEY_HEX = '22'.repeat(32);

const fromHex = (s: string) => Buffer.from(s, 'hex');
const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/**
 * A proven but unbound transaction — the shape a contract call is in when
 * midnight-js hands it to `balanceTx`. It carries an intent so it has an
 * identifier, and no calls, so proving it needs no circuit.
 */
async function unboundTransaction(): Promise<UnboundTransaction> {
  const unproven = Transaction.fromParts(NETWORK, undefined, undefined, Intent.new(new Date(Date.now() + 3_600_000)));
  const noCircuits: ProvingProvider = {
    check: async () => [],
    prove: async () => {
      throw new Error('this transaction has no circuits to prove');
    },
  };
  return unproven.prove(noCircuits, CostModel.initialCostModel());
}

const coinKeyBech32 = (hex: string) =>
  ShieldedCoinPublicKey.codec.encode(NETWORK, new ShieldedCoinPublicKey(fromHex(hex))).asString();
const encKeyBech32 = (hex: string) =>
  ShieldedEncryptionPublicKey.codec
    .encode(NETWORK, new ShieldedEncryptionPublicKey(fromHex(hex)))
    .asString();

/**
 * Stands in for a browser wallet. It only accepts what a real one would: a
 * hex string that deserializes as an unsealed transaction. Balancing is
 * reduced to sealing, which is the one part of it the bridge depends on.
 */
function standInWallet(overrides: Partial<ConnectorWallet> = {}) {
  const received: { balance: string[]; submit: string[] } = { balance: [], submit: [] };
  const wallet: ConnectorWallet = {
    getShieldedAddresses: async () => ({
      shieldedAddress: 'unused by the bridge',
      shieldedCoinPublicKey: coinKeyBech32(COIN_KEY_HEX),
      shieldedEncryptionPublicKey: encKeyBech32(ENC_KEY_HEX),
    }),
    balanceUnsealedTransaction: async (tx) => {
      received.balance.push(tx);
      const unsealed = Transaction.deserialize('signature', 'proof', 'pre-binding', fromHex(tx));
      return { tx: toHex(unsealed.bind().serialize()) };
    },
    submitTransaction: async (tx) => {
      received.submit.push(tx);
    },
    ...overrides,
  };
  return { wallet, received };
}

function injected(name: string, apiVersion: string, connected?: Partial<ConnectedAPI>): InitialAPI {
  return {
    name,
    apiVersion,
    rdns: `test.${name.toLowerCase()}`,
    icon: '',
    connect: async () => connected as ConnectedAPI,
  };
}

describe('choosing a wallet', () => {
  it('reports that no wallet is installed when nothing is injected', () => {
    expect(() => selectWallet(undefined)).toThrow(/No Midnight wallet found/);
  });

  it('picks the entry that speaks connector v4 when a wallet injects several versions', () => {
    const v4 = injected('1AM', '4.0.1');
    expect(selectWallet({ legacy: injected('1AM', '3.2.0'), current: v4 })).toBe(v4);
  });

  it('names what it found when no wallet speaks v4, rather than failing on the first call', () => {
    expect(() => selectWallet({ old: injected('Lace', '3.2.0') })).toThrow(
      /Found Lace \(API 3\.2\.0\), but this app needs DApp Connector API 4\.x/,
    );
  });
});

describe('connecting', () => {
  const status = (s: Awaited<ReturnType<ConnectedAPI['getConnectionStatus']>>) => ({
    getConnectionStatus: async () => s,
  });

  it('refuses a wallet on another network, naming both', async () => {
    const wallet = injected('1AM', '4.0.1', status({ status: 'connected', networkId: 'preprod' }));
    await expect(connectToWallet(wallet, NETWORK)).rejects.toThrow(
      /1AM is on "preprod", but this app is on "undeployed"/,
    );
  });

  it('refuses a wallet that reports itself disconnected', async () => {
    const wallet = injected('1AM', '4.0.1', status({ status: 'disconnected' }));
    await expect(connectToWallet(wallet, NETWORK)).rejects.toThrow(/did not stay connected/);
  });

  it('asks the wallet for the network the app is on', async () => {
    let asked: string | undefined;
    const wallet: InitialAPI = {
      ...injected('1AM', '4.0.1'),
      connect: async (networkId) => {
        asked = networkId;
        return status({ status: 'connected', networkId }) as unknown as ConnectedAPI;
      },
    };
    await connectToWallet(wallet, NETWORK);
    expect(asked).toBe(NETWORK);
  });
});

describe('the wallet provider', () => {
  it('turns the Bech32m keys the connector returns into the hex midnight-js expects', async () => {
    const provider = await connectorWalletProvider(standInWallet().wallet, NETWORK);
    expect(provider.getCoinPublicKey()).toBe(COIN_KEY_HEX);
    expect(provider.getEncryptionPublicKey()).toBe(ENC_KEY_HEX);
  });

  it('passes keys through when a wallet already returns hex', async () => {
    const { wallet } = standInWallet({
      getShieldedAddresses: async () => ({
        shieldedAddress: '',
        shieldedCoinPublicKey: COIN_KEY_HEX,
        shieldedEncryptionPublicKey: ENC_KEY_HEX,
      }),
    });
    const provider = await connectorWalletProvider(wallet, NETWORK);
    expect(provider.getCoinPublicKey()).toBe(COIN_KEY_HEX);
  });

  it('sends the transaction as an unsealed hex string and reads back a sealed one', async () => {
    const { wallet, received } = standInWallet();
    const provider = await connectorWalletProvider(wallet, NETWORK);
    const tx = await unboundTransaction();

    const balanced = await provider.balanceTx(tx);

    expect(received.balance).toEqual([toHex(tx.serialize())]);
    expect(received.balance[0]).toMatch(/^[0-9a-f]+$/);
    // Reading it back as bound is the check that matters: an unsealed
    // transaction carries a different header and is refused.
    expect(() =>
      Transaction.deserialize('signature', 'proof', 'binding', balanced.serialize()),
    ).not.toThrow();
    expect(balanced.identifiers()).toEqual(tx.identifiers());
  });

  it('refuses a wallet reply that is still unsealed, instead of submitting it', async () => {
    const { wallet } = standInWallet({
      balanceUnsealedTransaction: async (tx) => ({ tx }),
    });
    const provider = await connectorWalletProvider(wallet, NETWORK);
    await expect(provider.balanceTx(await unboundTransaction())).rejects.toThrow(
      /Unable to deserialize Transaction/,
    );
  });
});

describe('the midnight provider', () => {
  it('submits the exact bytes it was given and returns an id the indexer can watch for', async () => {
    const { wallet, received } = standInWallet();
    const provider = await connectorWalletProvider(wallet, NETWORK);
    const balanced = await provider.balanceTx(await unboundTransaction());

    const txId = await provider.submitTx(balanced);

    expect(received.submit).toEqual([toHex(balanced.serialize())]);
    expect(balanced.identifiers()).toContain(txId);
  });

  it('lets a rejected submission fail the call, with no id returned', async () => {
    const { wallet } = standInWallet({
      submitTransaction: async () => {
        throw new Error('User rejected the transaction');
      },
    });
    const provider = await connectorWalletProvider(wallet, NETWORK);
    const balanced = await provider.balanceTx(await unboundTransaction());
    await expect(provider.submitTx(balanced)).rejects.toThrow(/User rejected/);
  });
});
