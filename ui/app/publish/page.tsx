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

      <div className="wip">
        <b>Wave 1 status — this view connects, but cannot yet complete a proof.</b>
        <br />
        Browser wallets speak the DApp Connector API v4, which passes transactions as
        serialized strings and returns nothing from <code>submitTransaction</code>. The
        midnight-js version this contract is built on expects objects and a transaction id.
        An official bridge exists for the proving half; the wallet half has to be written,
        and that is Wave 2 work — specified in <code>docs/wave2-wallet-bridge.md</code>.
        <br />
        <br />
        Everything up to and including holding a credential works against 1AM today.
        Proving currently happens from the CLI, and the{' '}
        <a href="/">reader view</a> shows the result — which is the half of the product a
        reader actually experiences.
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
