import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { git } from '../core/git.mjs';
import { writeJson } from '../core/io.mjs';
import { loadPolicy, validatePolicyShape } from '../core/policy.mjs';
import { validateConfigFile } from '../core/config.mjs';
import { die } from '../core/run-context.mjs';
import { buildRepoScan, isConfigPath, listTrackedFiles, resolveGitRoot, walkFiles } from '../core/repo.mjs';

export function repoScan(args) {
  const root = resolveGitRoot(args.repo);
  const scan = buildRepoScan(root);
  const outPath = join(root, '.agentic-sdlc', 'repo-scan.json');
  writeJson(outPath, scan);
  console.log(JSON.stringify({ ...scan, artifact: outPath }, null, 2));
}

export function policyValidate(args) {
  const repo = resolve(String(args.repo || ''));
  if (!repo || !existsSync(repo)) die('--repo must point to an existing repository');
  const gitRoot = git(repo, ['rev-parse', '--show-toplevel']);
  if (!gitRoot.ok) die(`${repo} is not a git repository`);
  const root = gitRoot.stdout.trim();
  const policyPath = join(root, '.agentic-sdlc', 'policy.json');
  const policy = loadPolicy(root);
  const shape = validatePolicyShape(policy);
  const payload = {
    validatedAt: new Date().toISOString(),
    repo: root,
    policyPath,
    policyPresent: existsSync(policyPath),
    ok: shape.ok,
    errors: shape.errors,
    warnings: shape.warnings,
    effectivePolicy: policy,
  };
  const outPath = join(root, '.agentic-sdlc', 'policy-validation.json');
  writeJson(outPath, payload);
  console.log(JSON.stringify({ ...payload, artifact: outPath }, null, 2));
  if (!payload.ok) process.exit(1);
}

export function configValidate(args) {
  const repo = resolve(String(args.repo || ''));
  if (!repo || !existsSync(repo)) die('--repo must point to an existing repository');
  const gitRoot = git(repo, ['rev-parse', '--show-toplevel']);
  if (!gitRoot.ok) die(`${repo} is not a git repository`);
  const root = gitRoot.stdout.trim();
  const files = args['target-file']
    ? [String(args['target-file'])]
    : (listTrackedFiles(root).length ? listTrackedFiles(root) : walkFiles(root)).filter(isConfigPath);
  const results = files.map((file) => {
    const absolute = resolve(root, file);
    const rel = relative(root, absolute);
    if (rel.startsWith('..') || !existsSync(absolute)) return { file, ok: false, type: 'unknown', errors: ['file missing or outside repository'] };
    const result = validateConfigFile(absolute);
    result.file = rel;
    return result;
  });
  const payload = {
    validatedAt: new Date().toISOString(),
    repo: root,
    ok: results.every((result) => result.ok),
    filesChecked: results.length,
    results,
  };
  const outPath = join(root, '.agentic-sdlc', 'config-validation.json');
  writeJson(outPath, payload);
  console.log(JSON.stringify({ ...payload, artifact: outPath }, null, 2));
  if (!payload.ok) process.exit(1);
}
