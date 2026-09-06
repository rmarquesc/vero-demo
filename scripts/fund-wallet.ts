/**
 * Send NIGHT from the devnet's genesis wallet to another address.
 *
 * On the local devnet all NIGHT is pre-minted to the genesis seed, and the
 * genesis seed is raw hex rather than a mnemonic — so a browser wallet cannot
 * import it. A freshly installed browser wallet therefore has nothing, and
 * nothing means no DUST, and no DUST means it cannot submit a transaction.
 *
 * This bridges that: it funds any address from the genesis wallet so the
 * browser half of the demo can run entirely offline, without the public
 * faucet.
 *
 *   npx tsx scripts/fund-wallet.ts mn_addr_undeployed1...  [amount]
 *
 * Only useful on `undeployed`. On public networks, use the faucet.
 */
import { WebSocket } from 'ws';
import * as Rx from 'rxjs';
import { MidnightBech32m, UnshieldedAddress } from '@midnight-ntwrk/wallet-sdk-address-format';
import { resolveNetwork, getOrCreateWallet } from '../src/network';
import { createWallet, persistWalletState, unshieldedToken } from '../src/wallet';

// @ts-expect-error the wallet SDK expects a global WebSocket
globalThis.WebSocket = WebSocket;

const recipient = process.argv[2];
const requested = process.argv[3];

if (!recipient || !recipient.startsWith('mn_addr_')) {
  console.error('\n  Usage: npx tsx scripts/fund-wallet.ts <mn_addr_...> [amount]');
  console.error('  Pass the wallet\'s UNSHIELDED address — that is what holds NIGHT.\n');
  process.exit(1);
}

const { network, config } = resolveNetwork();

if (network !== 'undeployed') {
  console.error(`\n  Refusing to run on ${network}.`);
  console.error('  This script spends from the genesis wallet, which only exists on the local');
  console.error(`  devnet. On ${network}, fund from the faucet instead:`);
  console.error(`    ${config.faucet ?? '(no faucet configured)'}\n`);
  process.exit(1);
}

/** Enough to register for DUST generation and pay fees for a good while. */
const AMOUNT = BigInt(requested ?? '1000000000000');

console.log(`\n  network:   ${network}`);
console.log(`  recipient: ${recipient}`);
console.log(`  amount:    ${AMOUNT.toLocaleString()} NIGHT\n`);

const walletCtx = await createWallet({
  network,
  networkConfig: config,
  seed: getOrCreateWallet(network).seed,
});

console.log('  Syncing the genesis wallet...');
const state = await walletCtx.wallet.waitForSyncedState();
await persistWalletState(network, walletCtx);

const token = unshieldedToken();
const balance = state.unshielded.balances[token.raw] ?? 0n;
console.log(`  Genesis balance: ${balance.toLocaleString()} NIGHT`);

if (balance < AMOUNT) {
  console.error(`\n  Not enough NIGHT to send ${AMOUNT.toLocaleString()}.`);
  console.error('  Check the devnet minted to the genesis seed: docker compose logs node\n');
  await walletCtx.wallet.stop();
  process.exit(1);
}

// The address arrives bech32-encoded; the SDK wants the decoded key bytes.
// Passing the bech32 string straight through fails with "Invalid character
// 'm' at position 0", which reads like a parser bug and is not one.
const receiverAddress = MidnightBech32m.parse(recipient).decode(UnshieldedAddress, network);

console.log('  Building the transfer...');
const recipe = await walletCtx.wallet.transferTransaction(
  [
    {
      type: 'unshielded',
      outputs: [{ type: token.raw, receiverAddress, amount: AMOUNT }],
    },
  ],
  {
    shieldedSecretKeys: walletCtx.shieldedSecretKeys,
    dustSecretKey: walletCtx.dustSecretKey,
  },
  { ttl: new Date(Date.now() + 30 * 60 * 1000), payFees: true },
);

// Spending unshielded UTXOs needs a signature per input, and
// transferTransaction returns the recipe unsigned. Skipping this step is
// rejected by the chain as "Custom error: 192" —
// InputsSignaturesLengthMismatch — which names the count, not the cause.
console.log('  Signing the inputs...');
const signed = await walletCtx.wallet.signRecipe(recipe, (payload: Uint8Array) =>
  walletCtx.unshieldedKeystore.signData(payload),
);

console.log('  Finalising and submitting...');
const finalized = await walletCtx.wallet.finalizeRecipe(signed);
const txId = await walletCtx.wallet.submitTransaction(finalized);

console.log(`\n  ✅ Sent. Transaction: ${txId}`);
console.log('\n  In the wallet, the NIGHT has to be registered for DUST generation before it');
console.log('  can pay fees — most wallets do this on their own, but it takes a few blocks.\n');

// Give the transaction a moment to land before tearing the wallet down.
await Rx.firstValueFrom(
  walletCtx.wallet.state().pipe(Rx.filter((s: any) => s.isSynced), Rx.take(1)),
).catch(() => undefined);

await persistWalletState(network, walletCtx);
await walletCtx.wallet.stop();
process.exit(0);
