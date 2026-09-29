import { execFileSync, spawnSync } from 'node:child_process';

// Only Git-tracked files: walking the working tree would also enter local material outside the repository.
const mode = process.argv[2] === '--check' ? '--check' : '--write';
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const result = spawnSync(
  process.execPath,
  ['node_modules/prettier/bin/prettier.cjs', mode, '--ignore-unknown', ...files],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
