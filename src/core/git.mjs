import { spawnSync } from 'node:child_process';

export function git(repo, args, opts = {}) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', ...opts });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    command: `git ${args.join(' ')}`,
  };
}

export function run(repo, command) {
  const result = spawnSync(command, { cwd: repo, shell: true, encoding: 'utf8' });
  return {
    command,
    status: result.status ?? 127,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ok: result.status === 0,
  };
}
