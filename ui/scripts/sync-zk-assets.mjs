/**
 * Copy the compiled circuit's ZK assets into ui/public so the browser can
 * fetch them.
 *
 * Proving in the browser needs the prover key and the circuit's ZKIR. In Node
 * those are read straight off disk by NodeZkConfigProvider; in the browser
 * FetchZkConfigProvider pulls them over HTTP, which means they have to sit
 * somewhere the app actually serves. Hence the copy — `ZK 404` in the Midnight
 * troubleshooting notes is this step having been skipped.
 *
 * Run after every `npm run compile`, because a recompiled circuit invalidates
 * the copies: a stale prover key produces proofs the chain rejects.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_NAME = 'vero';

const source = path.resolve(here, '..', '..', 'contracts', 'managed', CONTRACT_NAME);
const target = path.resolve(here, '..', 'public', 'zk', CONTRACT_NAME);

if (!fs.existsSync(source)) {
  console.error(`\n  Compiled contract not found at ${source}`);
  console.error('  Run `npm run compile` at the repository root first.\n');
  process.exit(1);
}

// keys/ and zkir/ are fetched over HTTP at proof time, so they go to public/.
const WANTED = ['keys', 'zkir'];

// contract/ is different: the generated module imports @midnight-ntwrk/
// compact-runtime by bare specifier, which only a bundler can resolve. Served
// as a static file the browser would fail on that import, so it is copied
// into the source tree instead and bundled like any other module.
const GENERATED = path.resolve(here, '..', 'lib', 'generated', CONTRACT_NAME);

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });

let files = 0;
let bytes = 0;

for (const dir of WANTED) {
  const from = path.join(source, dir);
  if (!fs.existsSync(from)) {
    console.error(`  Missing ${dir}/ in ${source} — was the contract compiled with --skip-zk?`);
    process.exit(1);
  }
  const to = path.join(target, dir);
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name);
    if (!fs.statSync(src).isFile()) continue;
    fs.copyFileSync(src, path.join(to, name));
    files += 1;
    bytes += fs.statSync(src).size;
  }
}

fs.rmSync(GENERATED, { recursive: true, force: true });
fs.mkdirSync(GENERATED, { recursive: true });
const contractDir = path.join(source, 'contract');
let generated = 0;
for (const name of fs.readdirSync(contractDir)) {
  const src = path.join(contractDir, name);
  if (!fs.statSync(src).isFile()) continue;
  fs.copyFileSync(src, path.join(GENERATED, name));
  generated += 1;
}

const mb = (bytes / 1024 / 1024).toFixed(1);
console.log(`\n  Synced ${files} ZK assets (${mb} MB) → public/zk/${CONTRACT_NAME}/`);
console.log(`  Copied ${generated} contract files → lib/generated/${CONTRACT_NAME}/\n`);
