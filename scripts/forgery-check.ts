/**
 * Security regression: a membership path alone must not be enough.
 *
 * The registry's leaves are public on-chain, so anyone can compute a valid
 * Merkle path for somebody else's credential. What stops them proving with it
 * is the contract's `assert(path.leaf == commitment)`, which binds the path to
 * the commitment derived from the prover's own secret.
 *
 * This script plays the attacker: it knows no registered secret, but supplies
 * a genuine path for a leaf that *is* registered. The circuit must reject it.
 * Exits 0 when the forgery is refused, 1 when it succeeds.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';

import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import { resolveNetwork, getOrCreateWallet, getDeployment } from '../src/network';
import { createWallet, persistWalletState } from '../src/wallet';
import { loadOrCreateCredential, encodeIssuerType, hashPost, toHex } from '../src/vero-credential';

// @ts-expect-error wallet sync requires WebSocket
globalThis.WebSocket = WebSocket;

const PRIVATE_STATE_ID = 'veroForgeryPrivateState';
const { network, config: networkConfig } = resolveNetwork();

function pass(msg: string): never {
  console.log(`✅ forgery-check passed: ${msg}`);
  process.exit(0);
}
function fail(msg: string): never {
  console.error(`❌ forgery-check FAILED: ${msg}`);
  process.exit(1);
}

async function main() {
  const deployment = getDeployment(network);
  if (!deployment) fail(`no deployment on file for ${network}`);

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const zkConfigPath = path.resolve(__dirname, '..', 'contracts', 'managed', 'vero');
  if (!fs.existsSync(path.join(zkConfigPath, 'contract', 'index.js'))) {
    fail('contract not compiled — run `npm run compile`');
  }
  const Vero = await import(pathToFileURL(path.join(zkConfigPath, 'contract', 'index.js')).href);

  // The victim's credential — the one actually in the registry.
  const { credential } = loadOrCreateCredential();
  const issuerType = encodeIssuerType(credential.issuerType);
  const expiry = BigInt(credential.expirySeconds);
  const registrarCommitment: Uint8Array = Vero.pureCircuits.deriveRegistrarCommitment(
    credential.registrarSecret,
  );
  const leafFor = (secret: Uint8Array): Uint8Array =>
    Vero.pureCircuits.deriveCredentialLeaf(
      Vero.pureCircuits.deriveSubjectCommitment(secret),
      registrarCommitment,
      issuerType,
      expiry,
    );

  const victimLeaf = leafFor(credential.secret);

  // The attacker: a secret no registrar ever granted a credential for.
  const attackerSecret = Uint8Array.from(crypto.randomBytes(32));
  const attackerLeaf = leafFor(attackerSecret);
  if (toHex(attackerLeaf) === toHex(victimLeaf)) fail('attacker leaf collided with the victim leaf');

  console.log(`  victim leaf (registered): ${toHex(victimLeaf)}`);
  console.log(`  attacker leaf (not registered): ${toHex(attackerLeaf)}`);

  // The dishonest witness: the attacker's secret, but the victim's path.
  const forgedWitnesses = {
    credentialSecret: ({ privateState }: any) => [privateState, attackerSecret],
    registrarSecret: ({ privateState }: any) => [privateState, new Uint8Array(32)],
    governanceSecret: ({ privateState }: any) => [privateState, new Uint8Array(32)],
    credentialPath: ({ ledger, privateState }: any) => {
      const p = ledger.credentialRegistry.findPathForLeaf(victimLeaf);
      if (!p) fail('victim credential is not in the registry — deploy first');
      return [privateState, p];
    },
  };

  const compiledContract = (CompiledContract.make('vero', Vero.Contract) as any).pipe(
    (CompiledContract.withWitnesses as any)(forgedWitnesses),
    (CompiledContract.withCompiledFileAssets as any)(zkConfigPath),
  );

  const walletCtx = await createWallet({ network, networkConfig, seed: getOrCreateWallet(network).seed });
  await walletCtx.wallet.waitForSyncedState();
  await persistWalletState(network, walletCtx);

  const zkConfigProvider = new NodeZkConfigProvider(zkConfigPath);
  const walletProvider = {
    getCoinPublicKey: () => walletCtx.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => walletCtx.shieldedSecretKeys.encryptionPublicKey,
    async balanceTx(tx: any, ttl?: Date) {
      const recipe = await walletCtx.wallet.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: walletCtx.shieldedSecretKeys, dustSecretKey: walletCtx.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      );
      return walletCtx.wallet.finalizeRecipe(recipe);
    },
    submitTx: (tx: any) => walletCtx.wallet.submitTransaction(tx) as any,
  };

  const providers = {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: 'vero-forgery-state',
      accountId: walletCtx.unshieldedKeystore.getBech32Address().toString(),
      privateStoragePasswordProvider: () => 'Local-Devnet-Development-Placeholder-1',
    }),
    publicDataProvider: indexerPublicDataProvider(networkConfig.indexer, networkConfig.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(networkConfig.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };

  const deployed: any = await findDeployedContract(providers, {
    compiledContract: compiledContract as any,
    contractAddress: deployment.address,
    privateStateId: PRIVATE_STATE_ID,
    initialPrivateState: {
      credentialSecret: attackerSecret,
      credentialLeaf: attackerLeaf,
      registrarSecret: new Uint8Array(32),
      governanceSecret: new Uint8Array(32),
    },
  });

  console.log('  attempting the forgery...');
  try {
    await deployed.callTx.verifySource(
      hashPost('https://exemplo.pt/post-forjado'),
      issuerType,
      expiry,
    );
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    await walletCtx.wallet.stop();
    if (msg.includes('Merkle path does not belong to this credential')) {
      pass('the leaf-binding assert rejected a valid path for a foreign leaf');
    }
    fail(`rejected, but not by the binding assert — got: ${msg}`);
  }

  await walletCtx.wallet.stop();
  fail('THE FORGERY SUCCEEDED — a valid path for a foreign leaf was accepted');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
