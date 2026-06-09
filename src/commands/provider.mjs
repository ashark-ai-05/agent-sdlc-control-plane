import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkAmpReadiness } from '../core/amp-runtime.mjs';
import { git } from '../core/git.mjs';
import { readJson, writeJson } from '../core/io.mjs';
import { die } from '../core/run-context.mjs';

export function providerCheck(args) {
  const repo = resolve(String(args.repo || ''));
  const provider = String(args.provider || 'amp');
  const runId = args.run ? String(args.run) : '';
  if (!repo || !existsSync(repo)) die('--repo must point to an existing repository');
  if (provider !== 'amp') die('--provider currently supports amp only');

  const gitRoot = git(repo, ['rev-parse', '--show-toplevel']);
  const root = gitRoot.ok ? gitRoot.stdout.trim() : repo;
  const runDir = runId ? join(root, '.agentic-sdlc', 'runs', runId) : '';
  const manifest = runId ? readJson(join(runDir, 'manifest.json'), {}) : {};
  const contextPack = runId ? readJson(join(runDir, 'context-pack.json'), {}) : {};
  const readiness = checkAmpReadiness({ manifest, contextPack });
  const outputDir = join(root, '.agentic-sdlc', 'provider-readiness');
  const outputPath = join(outputDir, 'amp.json');
  const artifact = {
    ...readiness,
    repository: root,
    runId: runId || null,
  };
  writeJson(outputPath, artifact);
  console.log(JSON.stringify({
    ...artifact,
    artifact: outputPath,
  }, null, 2));
}
