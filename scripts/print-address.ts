/**
 * Print a network's wallet address without syncing.
 *
 * `npm run check-balance` has to sync before it can show a balance, and on a
 * public network that can take many minutes — or stall. Funding from a faucet
 * only needs the address, which is derived from the seed, so this skips the
 * wait entirely.
 *
 *   npx tsx scripts/print-address.ts preview
 */
import { WebSocket } from 'ws';
import { resolveNetwork, getOrCreateWallet } from '../src/network';
import { createWallet } from '../src/wallet';

// @ts-expect-error the wallet SDK expects a global WebSocket
globalThis.WebSocket = WebSocket;

const requested = process.argv[2];
const { network, config } = resolveNetwork({
  argv: requested ? ['node', 'x', '--network', requested] : process.argv,
});

const walletCtx = await createWallet({
  network,
  networkConfig: config,
  seed: getOrCreateWallet(network).seed,
});

console.log(`\n  network:  ${network}`);
console.log(`  address:  ${walletCtx.unshieldedKeystore.getBech32Address()}`);
if (config.faucet) console.log(`  faucet:   ${config.faucet}\n`);

await walletCtx.wallet.stop();
process.exit(0);
