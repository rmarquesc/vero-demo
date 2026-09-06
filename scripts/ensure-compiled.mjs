/**
 * Makes `npm test` work on a fresh clone.
 *
 * The tests drive the compiled contract, and contracts/managed/ is generated
 * output that is not tracked. Compiling with --skip-zk gives the tests
 * everything they need in a couple of seconds: the simulator executes circuits
 * but never proves them, so the proving keys are dead weight here.
 *
 * An existing build is left alone — including a full one with keys, which a
 * --skip-zk run would replace.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const built = path.join(root, 'contracts', 'managed', 'vero', 'contract', 'index.js');

if (existsSync(built)) {
  process.exit(0);
}

console.log('Contract not compiled yet — building without proving keys for the tests.');

const result = spawnSync(
  'compact',
  ['compile', '--skip-zk', 'contracts/vero.compact', 'contracts/managed/vero'],
  { cwd: root, stdio: 'inherit' },
);

if (result.error?.code === 'ENOENT') {
  console.error(
    '\nThe Compact CLI is not on PATH, so the contract cannot be compiled.\n' +
      'Install it from https://docs.midnight.network and re-run `npm test`.\n' +
      'Nothing else is needed — these tests do not use Docker, a wallet or a node.\n',
  );
  process.exit(1);
}

process.exit(result.status ?? 1);
