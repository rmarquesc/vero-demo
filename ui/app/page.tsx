import { POSTS } from '@/lib/posts';
import { readLedger, hashPost, toHex, NETWORK, contractAddress } from '@/lib/vero';

export const dynamic = 'force-dynamic';

export default async function ReaderView() {
  let ledger = null;
  let error: string | null = null;

  try {
    ledger = await readLedger();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const address = contractAddress();

  return (
    <main className="wrap">
      <header className="masthead">
        <p className="eyebrow">
          <span className="pip" /> Vero · reader view
        </p>
        <h1>
          What can this source <em>prove?</em>
        </h1>
        <p className="sub">
          A reader checks a post against the Midnight ledger. No wallet, no account, nothing
          installed — the signal is public, the credential behind it is not.
        </p>

        {error ? (
          <div className="err">
            Could not read the ledger: {error}
            <br />
            {NETWORK === 'undeployed'
              ? 'Is the local devnet up? docker compose up -d --wait'
              : `Network: ${NETWORK}`}
          </div>
        ) : (
          <div className={`ledger-strip${ledger ? '' : ' down'}`}>
            <span className="live">{ledger ? 'reading ledger' : 'no contract'}</span>
            <span>
              network <b>{NETWORK}</b>
            </span>
            {ledger && (
              <>
                <span>
                  verified posts <b>{ledger.verifiedCount}</b>
                </span>
                <span>
                  contract <b>{ledger.contractAddress.slice(0, 12)}…</b>
                </span>
              </>
            )}
            {!ledger && !address && <span>nothing deployed on this network yet</span>}
          </div>
        )}
      </header>

      <p className="feed-label">Sample feed · content is invented, verification is real</p>

      {POSTS.map((post) => {
        const hash = toHex(hashPost(post.content));
        const issuerType = ledger?.verified.get(hash);

        return (
          <article className="post" key={post.id}>
            <div className="post-head">
              <div className="avatar" />
              <div className="who">
                <span className="name">{post.name}</span>
                <span className="handle">{post.handle}</span>
              </div>
            </div>

            <p className="post-body">{post.content}</p>

            {issuerType ? (
              <span className="seal">
                <span className="tick">✓</span> Vero verified
                <span className="kind">{issuerType}</span>
              </span>
            ) : (
              <span className="unsealed">no verification on record</span>
            )}

            <p className="post-meta">sha256 {hash}</p>
          </article>
        );
      })}

      <div className="note">
        <b>What the badge means.</b> The source proved it holds a credential registered by a
        recognised issuer, and that the credential has not expired — without revealing{' '}
        <b>which</b> credential, so neither the person nor the issuing body is disclosed. What sits
        on the ledger is the post hash and the issuer type, nothing else.
        <br />
        <br />
        <b>What it does not mean.</b> Nothing about whether the post is true. Vero verifies the
        source, not the claim.
        <br />
        <br />
        A post is identified by the SHA-256 of its text, so editing a verified post silently drops
        its badge — the signal is bound to the exact words, not to the account.
      </div>
    </main>
  );
}
