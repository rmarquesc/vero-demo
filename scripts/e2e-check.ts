/**
 * End-to-end smoke check for vero-demo.
 *
 * Reconnects to the deployed contract, reads its ledger state, and exits 0
 * on success. Used by `npm run test:e2e` and by the project's CI workflows.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';

import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { resolveNetwork, getOrCreateWallet, formatWalletBackupNotice, getDeployment } from '../src/network';
import { createWallet, persistWalletState } from '../src/wallet';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import {
  loadOrCreateCredential,
  createPrivateState,
  witnesses,
  encodeIssuerType,
  decodeIssuerType,
  toHex,
} from '../src/vero-credential';

// @ts-expect-error wallet sync requires WebSocket
globalThis.WebSocket = WebSocket;

// Must match the privateStateId used at deploy time.
const PRIVATE_STATE_ID = 'veroPrivateState';

// ─── Network configuration ─────────────────────────────────────────────────────

const { network, config: networkConfig } = resolveNetwork();
const WALLET = getOrCreateWallet(network);
const SEED = WALLET.seed;
{
  const notice = formatWalletBackupNotice(WALLET, network);
  if (notice) console.log(notice);
}

function fail(msg: string): never {
  console.error(`❌ e2e-check failed: ${msg}`);
  process.exit(1);
}

function isHexAddress(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-fA-F]+$/.test(s) && s.length >= 32;
}

async function main() {
  // 1. Deployment sanity
  const deployment = getDeployment(network);
  if (!deployment) {
    console.error(`No deploy on file for network ${network}.`);
    process.exit(1);
  }
  if (!isHexAddress(deployment.address)) {
    fail(`Deployment address missing or invalid: ${JSON.stringify(deployment, null, 2)}`);
  }

  // 2. Build wallet and providers
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const zkConfigPath = path.resolve(__dirname, '..', 'contracts', 'managed', 'vero');
  const contractPath = path.join(zkConfigPath, 'contract', 'index.js');
  if (!fs.existsSync(contractPath)) fail('Compiled contract missing — run `npm run compile`.');
  const Vero = await import(pathToFileURL(contractPath).href);
  // Stage functions cast for the same reason as in src/deploy.ts: the contract
  // arrives from a dynamic import, so the inferred parameter types collapse.
  const compiledContract = (CompiledContract.make('vero', Vero.Contract) as any).pipe(
    (CompiledContract.withWitnesses as any)(witnesses),
    (CompiledContract.withCompiledFileAssets as any)(zkConfigPath),
  );
  const { credential } = loadOrCreateCredential();
  const credentialSecret = credential.secret;
  const credentialCommitment: Uint8Array = Vero.pureCircuits.deriveCredentialCommitment(
    credentialSecret,
    encodeIssuerType(credential.issuerType),
    BigInt(credential.expirySeconds),
  );

  const walletCtx = await createWallet({ network, networkConfig, seed: SEED });
  await walletCtx.wallet.waitForSyncedState();
  // Persist the sync state — saves time on the next e2e-check invocation in CI
  // when run against the same persistent wallet directory.
  await persistWalletState(network, walletCtx);

  const zkConfigProvider = new NodeZkConfigProvider(zkConfigPath);
  const walletProvider = {
    // Midnight.js 4.1.x returns the key objects (CoinPublicKey / EncPublicKey).
    getCoinPublicKey: () => walletCtx.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => walletCtx.shieldedSecretKeys.encryptionPublicKey,
    async balanceTx() {
      throw new Error('e2e-check is read-only and should not balance transactions');
    },
    submitTx() {
      throw new Error('e2e-check is read-only and should not submit transactions');
    },
  } as any;

  const providers = {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: 'vero-state',
      accountId: walletCtx.unshieldedKeystore.getBech32Address().toString(),
      // SDK requires ≥16 chars. e2e-check is read-only so we don't expose
      // the env-var override here — match the deploy script's local-devnet default.
      privateStoragePasswordProvider: () => 'Local-Devnet-Development-Placeholder-1',
    }),
    publicDataProvider: indexerPublicDataProvider(networkConfig.indexer, networkConfig.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(networkConfig.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };

  // 3. Reconnect to the deployed contract — proves callTx interface is wired
  try {
    await findDeployedContract(providers, {
      contractAddress: deployment.address,
      compiledContract: compiledContract as any,
      privateStateId: PRIVATE_STATE_ID,
      initialPrivateState: createPrivateState(credentialSecret, credentialCommitment, credential.registrarSecret),
    });
  } catch (err: any) {
    await walletCtx.wallet.stop();
    fail(`findDeployedContract threw: ${err?.message ?? err}`);
  }

  // 4. Read the on-chain contract state via the public data provider — proves
  // the contract is indexed and queryable on the chain itself, not just that
  // we know how to construct the local handle.
  const onChainState = await providers.publicDataProvider.queryContractState(deployment.address);
  if (!onChainState) {
    await walletCtx.wallet.stop();
    fail(`queryContractState returned null for ${deployment.address}`);
  }

  // Decode the state as Vero's ledger. queryContractState returning non-null
  // only proves something is deployed there; this proves it is this contract,
  // with the credential commitment its constructor was given.
  let ledgerState: any;
  try {
    ledgerState = Vero.ledger(onChainState.data);
  } catch (err: any) {
    await walletCtx.wallet.stop();
    fail(`on-chain state is not a Vero ledger: ${err?.message ?? err}`);
  }
  if (!(ledgerState.registrarCommitment?.length === 32)) {
    await walletCtx.wallet.stop();
    fail('registrarCommitment missing or not 32 bytes');
  }

  // The registry has to actually contain this credential, otherwise
  // verifySource cannot produce a membership path and the deployment is
  // useless even though everything above passed.
  const registryPath = ledgerState.credentialRegistry.findPathForLeaf(credentialCommitment);
  if (!registryPath) {
    await walletCtx.wallet.stop();
    fail(`credential ${toHex(credentialCommitment)} is not in the on-chain registry`);
  }

  console.log(`✅ e2e-check passed`);
  console.log(`   contractAddress: ${deployment.address}`);
  console.log(`   network:         ${network}`);
  console.log(`   registrar:       ${toHex(ledgerState.registrarCommitment)}`);
  console.log(`   registry leaf:   ${toHex(credentialCommitment)} (present)`);
  console.log(`   verified posts:  ${ledgerState.verifiedPosts.size()}`);

  // Report which kinds of issuer are represented on-chain. A post recorded
  // with an empty issuer type would mean the encoding round-trip is broken,
  // which a bare count would hide.
  const issuerTypes = new Set<string>();
  for (const [, issuerType] of ledgerState.verifiedPosts) {
    issuerTypes.add(decodeIssuerType(issuerType));
  }
  if (issuerTypes.size > 0) {
    console.log(`   issuer types:    ${[...issuerTypes].join(', ')}`);
    if (issuerTypes.has('')) fail('a post is recorded with an empty issuer type');
  }

  await walletCtx.wallet.stop();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
