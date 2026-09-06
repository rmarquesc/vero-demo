'use client';

import { useEffect, useState } from 'react';
import { POSTS } from '@/lib/posts';
import {
  connectWallet,
  verifyPost,
  loadCredential,
  saveCredential,
  clearCredential,
  type StoredCredential,
  type Stage,
  type VerifyResult,
} from '@/lib/publish-client';

export type Config = {
  network: string;
  contractAddress: string | null;
  indexerUri: string;
  indexerWsUri: string;
  proofServerUri: string;
};

const STAGE_TEXT: Record<Stage, string> = {
  idle: '',
  connecting: 'Waiting for the wallet…',
  connected: 'Wallet connected',
  'loading-contract': 'Loading the circuit…',
  proving: 'Generating the proof — this takes 30–60 seconds',
  submitting: 'Submitting to the network…',
  done: 'Done',
  error: '',
};

export default function PublishClient({ config }: { config: Config }) {
  const [walletApi, setWalletApi] = useState<any>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [credential, setCredential] = useState<StoredCredential | null>(null);
  const [selected, setSelected] = useState<string>(POSTS[0].id);
  const [stage, setStage] = useState<Stage>('idle');
  const [detail, setDetail] = useState<string>('');
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Draft credential fields
  const [secretHex, setSecretHex] = useState('');
  const [issuerType, setIssuerType] = useState('journalist:accredited');
  const [expiry, setExpiry] = useState('');

  useEffect(() => {
    const stored = loadCredential();
    if (stored) {
      setCredential(stored);
      setSecretHex(stored.secretHex);
      setIssuerType(stored.issuerType);
      setExpiry(String(stored.expirySeconds));
    }
  }, []);

  async function onConnect() {
    setError(null);
    setStage('connecting');
    try {
      const { api, address: addr } = await connectWallet();
      setWalletApi(api);
      setAddress(addr);
      setStage('connected');
    } catch (e) {
      setStage('error');
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function onSaveCredential() {
    setError(null);
    const clean = secretHex.trim().replace(/^0x/, '');
    if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
      setError('The credential secret must be 64 hex characters (32 bytes).');
      return;
    }
    const seconds = Number(expiry);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      setError('Expiry must be a unix timestamp in seconds.');
      return;
    }
    if (seconds > 4_102_444_800) {
      setError(
        'That expiry is past the year 2100 — almost certainly milliseconds. Block time is ' +
          'compared in seconds; a millisecond value makes every expiry check pass. Divide by 1000.',
      );
      return;
    }
    const c = { secretHex: clean, issuerType: issuerType.trim(), expirySeconds: seconds };
    saveCredential(c);
    setCredential(c);
  }

  function onForget() {
    clearCredential();
    setCredential(null);
    setSecretHex('');
    setExpiry('');
  }

  async function onVerify() {
    if (!walletApi || !credential || !config.contractAddress) return;
    const post = POSTS.find((p) => p.id === selected);
    if (!post) return;

    setError(null);
    setResult(null);
    try {
      const res = await verifyPost({
        walletApi,
        contractAddress: config.contractAddress,
        indexerUri: config.indexerUri,
        indexerWsUri: config.indexerWsUri,
        proofServerUri: config.proofServerUri,
        networkId: config.network,
        credential,
        postContent: post.content,
        onStage: (s, d) => {
          setStage(s);
          setDetail(d ?? '');
        },
      });
      setResult(res);
      setStage('done');
    } catch (e) {
      setStage('error');
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const busy = stage === 'loading-contract' || stage === 'proving' || stage === 'submitting';

  return (
    <>
      <section className="step">
        <p className="step-k">
          <span className="n">01</span> wallet
        </p>
        {address ? (
          <p className="step-ok">
            Connected <code>{address.slice(0, 22)}…</code>
          </p>
        ) : (
          <>
            <p className="step-help">
              Any Midnight wallet works — the connector API is the same. Unlock it first, and point
              it at the proof server this app uses: <code>{config.proofServerUri}</code>
            </p>
            <button className="btn" onClick={onConnect} disabled={stage === 'connecting'}>
              {stage === 'connecting' ? 'Waiting…' : 'Connect wallet'}
            </button>
          </>
        )}
      </section>

      <section className="step">
        <p className="step-k">
          <span className="n">02</span> credential
        </p>
        {credential ? (
          <>
            <p className="step-ok">
              Held <code>{credential.issuerType}</code> · expires{' '}
              {new Date(credential.expirySeconds * 1000).toISOString().slice(0, 10)}
            </p>
            <button className="btn ghost" onClick={onForget}>
              Forget it
            </button>
          </>
        ) : (
          <>
            <p className="step-help">
              The secret stays in this browser and is never sent anywhere — it goes into the
              circuit as a witness. Take it from <code>.vero-credential</code> at the repository
              root.
            </p>
            <label className="field">
              <span>credential secret · 64 hex characters</span>
              <input
                value={secretHex}
                onChange={(e) => setSecretHex(e.target.value)}
                placeholder="4bf0e4c3…"
                spellCheck={false}
              />
            </label>
            <label className="field">
              <span>issuer type</span>
              <input value={issuerType} onChange={(e) => setIssuerType(e.target.value)} />
            </label>
            <label className="field">
              <span>expiry · unix seconds</span>
              <input
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
                placeholder="1820173358"
                spellCheck={false}
              />
            </label>
            <button className="btn" onClick={onSaveCredential}>
              Hold this credential
            </button>
          </>
        )}
      </section>

      <section className="step">
        <p className="step-k">
          <span className="n">03</span> post
        </p>
        <div className="picker">
          {POSTS.map((p) => (
            <label key={p.id} className={`pick${selected === p.id ? ' on' : ''}`}>
              <input
                type="radio"
                name="post"
                value={p.id}
                checked={selected === p.id}
                onChange={() => setSelected(p.id)}
              />
              <span className="pick-who">{p.name}</span>
              <span className="pick-text">{p.content}</span>
            </label>
          ))}
        </div>
      </section>

      <section className="step">
        <button
          className="btn primary"
          onClick={onVerify}
          disabled={!walletApi || !credential || !config.contractAddress || busy}
        >
          {busy ? 'Working…' : 'Prove the credential and verify this post'}
        </button>

        {busy && (
          <p className="working">
            {STAGE_TEXT[stage]}
            {detail ? ` — ${detail}` : ''}
          </p>
        )}

        {result && (
          <div className="ok-box">
            ✓ Verified on-chain
            <br />
            tx <code>{String(result.txId).slice(0, 24)}…</code>
            {result.blockHeight ? (
              <>
                {' '}
                · block <code>{String(result.blockHeight)}</code>
              </>
            ) : null}
            <br />
            <a href="/">Open the reader view →</a>
          </div>
        )}

        {error && <div className="err">{error}</div>}
      </section>
    </>
  );
}
