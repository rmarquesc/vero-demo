/**
 * An in-process simulator for the Vero contract.
 *
 * The e2e and forgery scripts in `scripts/` exercise the contract through a
 * real devnet: proof server, node, indexer, a funded wallet. That is the right
 * test for the wiring, and the wrong one for the contract's logic — it needs
 * Docker, takes minutes, and cannot rewind the clock.
 *
 * This drives the same compiled circuits directly through the Compact runtime.
 * No Docker, no wallet, no proofs: circuit execution is real, only the proving
 * is skipped. Every `assert` in vero.compact fires here exactly as it would
 * on-chain, which is what makes the suite worth having.
 *
 * The one capability the devnet cannot offer is the important one: block time
 * is a constructor argument here, so expiry is testable in both directions
 * without waiting a year.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
  type ChargedState,
} from '@midnight-ntwrk/compact-runtime';

import { witnesses as realWitnesses, type VeroPrivateState } from '../src/vero-credential';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MANAGED = path.resolve(__dirname, '..', 'contracts', 'managed', 'vero', 'contract', 'index.js');

if (!fs.existsSync(MANAGED)) {
  throw new Error(
    `The contract is not compiled — ${MANAGED} is missing.\n` +
      'Run `npm run compile` (or `npm test`, which compiles first).',
  );
}

// The generated contract is plain JavaScript with a sibling .d.ts; it has no
// type declarations the TS resolver can follow from here, so it is imported
// dynamically and typed at the boundary below.
const Vero: any = await import(MANAGED);

export type MerklePath = { leaf: Uint8Array; path: { sibling: { field: bigint }; goes_left: boolean }[] };

/** The witness surface the contract declares. */
export type VeroWitnesses = {
  registrarSecret(ctx: { ledger: any; privateState: VeroPrivateState }): [VeroPrivateState, Uint8Array];
  credentialSecret(ctx: { ledger: any; privateState: VeroPrivateState }): [VeroPrivateState, Uint8Array];
  credentialPath(ctx: { ledger: any; privateState: VeroPrivateState }): [VeroPrivateState, MerklePath];
};

/**
 * Deterministic 32-byte secrets. Named rather than random so a failing run
 * reproduces exactly; `crypto.randomBytes` in a test is a coin flip you only
 * notice when it lands badly.
 */
export const secretFor = (label: string): Uint8Array =>
  Uint8Array.from(crypto.createHash('sha256').update(`vero:test:${label}`).digest());

/** The contract never reads `ownPublicKey()`, so any well-formed key will do. */
const COIN_PUBLIC_KEY = { bytes: new Uint8Array(32) };

export const deriveRegistrarCommitment = (secret: Uint8Array): Uint8Array =>
  Vero.pureCircuits.deriveRegistrarCommitment(secret);

export const deriveCredentialCommitment = (
  secret: Uint8Array,
  issuerType: Uint8Array,
  expiry: bigint,
): Uint8Array => Vero.pureCircuits.deriveCredentialCommitment(secret, issuerType, expiry);

export type SimulatorOptions = {
  /** Commitment of the registrar the contract is deployed with. */
  registrarCommitment: Uint8Array;
  /** Private state backing the witnesses. */
  privateState: VeroPrivateState;
  /** Block time, in SECONDS since the epoch — the unit Midnight compares against. */
  time: number;
  /** Replace individual witnesses, to play a prover who lies about their inputs. */
  witnesses?: Partial<VeroWitnesses>;
};

export class VeroSimulator {
  private readonly contract: any;
  private readonly address = sampleContractAddress();
  private state: ChargedState;
  private privateState: VeroPrivateState;

  /** Block time seen by the next circuit call, in seconds since the epoch. */
  public time: number;

  constructor(options: SimulatorOptions) {
    this.contract = new Vero.Contract({ ...realWitnesses, ...(options.witnesses ?? {}) });
    this.privateState = options.privateState;
    this.time = options.time;

    const constructed = this.contract.initialState(
      createConstructorContext(options.privateState, COIN_PUBLIC_KEY),
      options.registrarCommitment,
    );
    // `.data` rather than the ContractState itself: both the circuit context
    // and the ledger decoder want the ChargedState, and keeping one type here
    // means the ledger is readable before the first circuit call.
    this.state = constructed.currentContractState.data;
    this.privateState = constructed.currentPrivateState;
  }

  /** Move the clock. Seconds — a millisecond value silently disables expiry. */
  at(timeSeconds: number): this {
    this.time = timeSeconds;
    return this;
  }

  /**
   * Switch actor. One ledger, several people acting against it: the registrar
   * registers, a source proves, an impostor tries to. Each holds different
   * private state, which is the only thing that distinguishes them — the
   * contract has no notion of a caller.
   */
  as(privateState: VeroPrivateState): this {
    this.privateState = privateState;
    return this;
  }

  /** The public ledger, decoded. */
  get ledger(): {
    credentialRegistry: {
      firstFree(): bigint;
      findPathForLeaf(leaf: Uint8Array): MerklePath | undefined;
      checkRoot(root: { field: bigint }): boolean;
    };
    registrarCommitment: Uint8Array;
    verifiedPosts: {
      size(): bigint;
      member(key: Uint8Array): boolean;
      lookup(key: Uint8Array): Uint8Array;
    };
  } {
    return Vero.ledger(this.state);
  }

  registerCredential(commitment: Uint8Array): void {
    this.call('registerCredential', commitment);
  }

  verifySource(postHash: Uint8Array, issuerType: Uint8Array, expiry: bigint): void {
    this.call('verifySource', postHash, issuerType, expiry);
  }

  /**
   * Threads the context through by hand: state in, state out. A fresh context
   * per call is what makes `at()` work — block time is fixed when the context
   * is built, so reusing one would freeze the clock at the first call.
   */
  private call(circuit: 'registerCredential' | 'verifySource', ...args: unknown[]): void {
    const context = createCircuitContext(
      this.address,
      COIN_PUBLIC_KEY,
      this.state,
      this.privateState,
      undefined,
      undefined,
      this.time,
    );
    const result = this.contract.impureCircuits[circuit](context, ...args);
    this.state = result.context.currentQueryContext.state;
    this.privateState = result.context.currentPrivateState;
  }
}
