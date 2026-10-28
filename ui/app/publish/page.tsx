import PublishClient, { type Config } from './PublishClient';
import type { Proving } from '@/lib/publish-client';
import { NETWORK, INDEXER, contractAddress } from '@/lib/vero';

export const dynamic = 'force-dynamic';

const PROOF_SERVERS: Record<string, string> = {
  undeployed: 'http://127.0.0.1:6300',
  preview: 'http://127.0.0.1:6300',
  preprod: 'http://127.0.0.1:6300',
};

/**
 * The wallet proves by default: it is the only option that works once the app
 * is hosted, because a visitor has no proof server of their own. Set
 * VERO_PROVING=proof-server to prove against the local one instead, as the
 * CLI does.
 */
const PROVING: Proving = process.env.VERO_PROVING === 'proof-server' ? 'proof-server' : 'wallet';

export default function PublishPage() {
  const config: Config = {
    network: NETWORK,
    contractAddress: contractAddress(),
    indexerUri: INDEXER,
    indexerWsUri: INDEXER.replace(/^http/, 'ws') + '/ws',
    proving: PROVING,
    proofServerUri: PROOF_SERVERS[NETWORK] ?? 'http://127.0.0.1:6300',
  };

  return (
    <main className="wrap">
      <header className="masthead">
        <p className="eyebrow">
          <span className="pip" /> Vero · publisher view
        </p>
        <h1>
          Prove it, don&apos;t <em>declare</em> it.
        </h1>
        <p className="sub">
          A credentialed source verifies one of its posts. The proof is generated here in the
          browser; the credential never leaves it.
        </p>
        <div className="ledger-strip">
          <span>
            network <b>{config.network}</b>
          </span>
          <span>
            contract{' '}
            <b>{config.contractAddress ? `${config.contractAddress.slice(0, 12)}…` : 'none'}</b>
          </span>
          <span>
            proving{' '}
            <b>
              {config.proving === 'wallet'
                ? 'in the wallet'
                : config.proofServerUri.replace(/^https?:\/\//, '')}
            </b>
          </span>
        </div>
      </header>

      <div className="wip">
        <b>New in this wave — proving from the browser.</b>
        <br />
        Browser wallets speak the DApp Connector API v4, which passes transactions as
        serialized strings and returns nothing from <code>submitTransaction</code>; the
        midnight-js version this contract is built on expects objects and a transaction id.
        Midnight ships an adapter for the proving half and none for the wallet half, so Vero
        has its own: <code>ui/lib/wallet-bridge.ts</code>. How it works, and what has been
        tested against what, is in <code>docs/wave2-wallet-bridge.md</code>.
      </div>

      <PublishClient config={config} />

      <div className="note">
        <b>Why this needs a wallet and the reader view does not.</b> Recording a verification is a
        transaction: it costs DUST and has to be signed. Reading one back is a public query. That
        asymmetry is the product — proving is work for the source, checking is free for everyone
        else.
      </div>
    </main>
  );
}
