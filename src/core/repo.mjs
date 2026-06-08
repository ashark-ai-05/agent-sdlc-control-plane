import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { git } from './git.mjs';
import { readJson } from './io.mjs';
import { die } from './run-context.mjs';

export function detectValidationCommands(root) {
  if (existsSync(join(root, 'pom.xml'))) return ['mvn test'];
  if (existsSync(join(root, 'build.gradle')) || existsSync(join(root, 'build.gradle.kts'))) return ['./gradlew test'];
  if (existsSync(join(root, 'package.json'))) {
    const pkg = readJson(join(root, 'package.json'), {});
    if (pkg.scripts?.test) return ['npm test'];
  }
  if (existsSync(join(root, 'go.mod'))) return ['go test ./...'];
  return [];
}

export function detectRepoStack(root) {
  const stack = [];
  if (existsSync(join(root, 'pom.xml'))) stack.push('maven');
  if (existsSync(join(root, 'build.gradle')) || existsSync(join(root, 'build.gradle.kts'))) stack.push('gradle');
  if (existsSync(join(root, 'package.json'))) stack.push('node');
  if (existsSync(join(root, 'go.mod'))) stack.push('go');
  if (existsSync(join(root, 'requirements.txt')) || existsSync(join(root, 'pyproject.toml'))) stack.push('python');
  return stack;
}

export function listTrackedFiles(root) {
  const result = git(root, ['ls-files']);
  if (!result.ok) return [];
  return result.stdout.split('\n').filter(Boolean);
}

export function walkFiles(root, options = {}) {
  const ignored = new Set(options.ignored || ['.git', 'node_modules', 'target', 'dist', 'build']);
  const limit = options.limit || 5000;
  const files = [];
  function walk(dir) {
    if (files.length >= limit) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const full = join(dir, entry.name);
      const rel = relative(root, full);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(rel);
      if (files.length >= limit) return;
    }
  }
  walk(root);
  return files;
}

export function isConfigPath(path) {
  const lower = path.toLowerCase();
  return lower.endsWith('.json') || lower.endsWith('.yml') || lower.endsWith('.yaml') || lower.endsWith('.properties') || lower.endsWith('.toml');
}

export function resolveGitRoot(repo) {
  const resolved = resolve(String(repo || ''));
  if (!resolved || !existsSync(resolved)) die('--repo must point to an existing repository');
  const gitRoot = git(resolved, ['rev-parse', '--show-toplevel']);
  if (!gitRoot.ok) die(`${resolved} is not a git repository`);
  return gitRoot.stdout.trim();
}

export function buildRepoScan(root) {
  const trackedFiles = listTrackedFiles(root);
  const allFiles = trackedFiles.length ? trackedFiles : walkFiles(root);
  const configFiles = allFiles.filter(isConfigPath).sort();
  const dirtyFiles = git(root, ['status', '--short']).stdout.split('\n').filter(Boolean).map((line) => line.slice(3));
  const remotes = git(root, ['remote', '-v']).stdout.split('\n').filter(Boolean);
  const branches = git(root, ['branch', '--format=%(refname:short)']).stdout.split('\n').filter(Boolean);
  const currentBranch = git(root, ['branch', '--show-current']).stdout.trim();
  return {
    scannedAt: new Date().toISOString(),
    repo: root,
    currentBranch,
    branches,
    remotes,
    stack: detectRepoStack(root),
    validationCommands: detectValidationCommands(root),
    fileCounts: {
      tracked: trackedFiles.length,
      scanned: allFiles.length,
      config: configFiles.length,
      dirty: dirtyFiles.length,
    },
    totalTrackedBytes: allFiles.reduce((sum, file) => {
      try { return sum + statSync(join(root, file)).size; } catch { return sum; }
    }, 0),
    configFiles,
    dirtyFiles,
    policyPresent: existsSync(join(root, '.agentic-sdlc', 'policy.json')),
  };
}
