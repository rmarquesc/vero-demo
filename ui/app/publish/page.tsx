import PublishClient, { type Config } from './PublishClient';
import { NETWORK, INDEXER, contractAddress } from '@/lib/vero';

export const dynamic = 'force-dynamic';

const PROOF_SERVERS: Record<string, string> = {
  undeployed: 'http://127.0.0.1:6300',
  preview: 'http://127.0.0.1:6300',
  preprod: 'http://127.0.0.1:6300',
};

export default function PublishPage() {
  const config: Config = {
    network: NETWORK,
    contractAddress: contractAddress(),
    indexerUri: INDEXER,
    indexerWsUri: INDEXER.replace(/^http/, 'ws') + '/ws',
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
            proof server <b>{config.proofServerUri.replace(/^https?:\/\//, '')}</b>
          </span>
        </div>
      </header>

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
