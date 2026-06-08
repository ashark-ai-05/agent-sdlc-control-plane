import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './git.mjs';
import { readJson } from './io.mjs';

export function die(message, code = 1) {
  console.error(`agent-sdlc: ${message}`);
  process.exit(code);
}

export function loadRun(repo, runId) {
  const gitRoot = git(repo, ['rev-parse', '--show-toplevel']);
  if (!gitRoot.ok) die(`${repo} is not a git repository`);
  const root = gitRoot.stdout.trim();
  const runDir = join(root, '.agentic-sdlc', 'runs', runId);
  return {
    root,
    runDir,
    manifest: readJson(join(runDir, 'manifest.json'), {}),
    contextPack: readJson(join(runDir, 'context-pack.json'), {}),
    approvalPath: join(runDir, 'approvals.jsonl'),
    eventsPath: join(runDir, 'events.jsonl'),
  };
}

export function listRunIds(root) {
  const runsRoot = join(root, '.agentic-sdlc', 'runs');
  if (!existsSync(runsRoot)) return [];
  return readdirSync(runsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}
