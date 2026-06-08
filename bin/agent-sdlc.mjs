#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) args[key] = true;
    else args[key] = argv[++i];
  }
  return args;
}

function die(message, code = 1) {
  console.error(`agent-sdlc: ${message}`);
  process.exit(code);
}

function readJson(path, fallback = undefined) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function defaultPolicy() {
  return {
    policyVersion: '0.1.0',
    protectedBranches: ['main', 'master'],
    requireCleanWorkingTreeBeforeExecute: false,
    validationMustPassForPr: true,
    allowFailedValidationOverride: true,
    enterpriseWritesRequireApproval: true,
    disallowedActions: ['merge_pr', 'deploy', 'production_mutation'],
  };
}

function loadPolicy(root) {
  const policyPath = join(root, '.agentic-sdlc', 'policy.json');
  return { ...defaultPolicy(), ...(readJson(policyPath, {}) || {}) };
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function appendJsonl(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...value, timestamp: new Date().toISOString() })}\n`, { flag: 'a' });
}

function git(repo, args, opts = {}) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', ...opts });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    command: `git ${args.join(' ')}`,
  };
}

function run(repo, command) {
  const result = spawnSync(command, { cwd: repo, shell: true, encoding: 'utf8' });
  return {
    command,
    status: result.status ?? 127,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ok: result.status === 0,
  };
}

function approvals(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function hasApproval(path, gate) {
  const record = [...approvals(path)].reverse().find((entry) => entry.gate === gate);
  return record?.status === 'approved';
}

function approvedGates(path) {
  const latest = new Map();
  for (const entry of approvals(path)) {
    if (entry.gate) latest.set(entry.gate, entry);
  }
  return [...latest.values()].filter((entry) => entry.status === 'approved').map((entry) => entry.gate);
}

function stringifyScalar(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

function setDeep(obj, dottedKey, rawValue) {
  const parts = dottedKey.split('.').filter(Boolean);
  if (parts.length === 0) die('--set-key must not be empty');
  let cursor = obj;
  for (const part of parts.slice(0, -1)) {
    if (!cursor[part] || typeof cursor[part] !== 'object' || Array.isArray(cursor[part])) cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts.at(-1)] = stringifyScalar(rawValue);
}

function formatYamlScalar(raw) {
  const value = stringifyScalar(raw);
  if (typeof value === 'boolean' || typeof value === 'number' || value === null) return String(value);
  if (/^[A-Za-z0-9_./:-]+$/.test(String(value))) return String(value);
  return JSON.stringify(String(value));
}

function setYamlValue(text, dottedKey, rawValue, runId) {
  const parts = dottedKey.split('.').filter(Boolean);
  if (!parts.length) die('--set-key must not be empty');
  const lines = text.split(/\r?\n/).filter((line, idx, arr) => !(idx === arr.length - 1 && line === ''));
  const valueText = formatYamlScalar(rawValue);

  function findKey(start, end, indent, key) {
    const re = new RegExp(`^\\s{${indent}}${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`);
    for (let i = start; i < end; i++) {
      if (re.test(lines[i])) return i;
    }
    return -1;
  }

  function blockEnd(start, indent) {
    let i = start + 1;
    for (; i < lines.length; i++) {
      if (!lines[i].trim() || lines[i].trim().startsWith('#')) continue;
      const currentIndent = lines[i].match(/^ */)[0].length;
      if (currentIndent <= indent) break;
    }
    return i;
  }

  let start = 0;
  let end = lines.length;
  let indent = 0;
  let insertAt = lines.length;
  for (let depth = 0; depth < parts.length; depth++) {
    const key = parts[depth];
    const idx = findKey(start, end, indent, key);
    const isLeaf = depth === parts.length - 1;
    if (idx >= 0) {
      if (isLeaf) {
        lines[idx] = `${' '.repeat(indent)}${key}: ${valueText}`;
        return `${lines.join('\n')}\n`;
      }
      start = idx + 1;
      end = blockEnd(idx, indent);
      insertAt = end;
      indent += 2;
      continue;
    }
    const newLines = [];
    if (!lines.some((line) => line.includes(`agent-sdlc mock config change for ${runId}`))) {
      newLines.push(`${' '.repeat(indent)}# agent-sdlc mock config change for ${runId}`);
    }
    for (let j = depth; j < parts.length; j++) {
      const isFinal = j === parts.length - 1;
      newLines.push(`${' '.repeat(indent + (j - depth) * 2)}${parts[j]}:${isFinal ? ` ${valueText}` : ''}`);
    }
    lines.splice(insertAt, 0, ...newLines);
    return `${lines.join('\n')}\n`;
  }
  return `${lines.join('\n')}\n`;
}

function applyConfigChange(targetPath, key, value, runId) {
  if (!existsSync(targetPath)) die(`target file does not exist: ${targetPath}`);
  const before = readFileSync(targetPath, 'utf8');
  const lower = targetPath.toLowerCase();
  let after;

  if (lower.endsWith('.json')) {
    const parsed = JSON.parse(before || '{}');
    setDeep(parsed, key, value);
    after = `${JSON.stringify(parsed, null, 2)}\n`;
  } else if (lower.endsWith('.properties')) {
    const lines = before.split(/\r?\n/).filter((line, idx, arr) => !(idx === arr.length - 1 && line === ''));
    const idx = lines.findIndex((line) => line.trim().startsWith(`${key}=`));
    if (idx >= 0) lines[idx] = `${key}=${value}`;
    else lines.push(`# agent-sdlc mock config change for ${runId}`, `${key}=${value}`);
    after = `${lines.join('\n')}\n`;
  } else if (lower.endsWith('.yml') || lower.endsWith('.yaml')) {
    after = setYamlValue(before, key, value, runId);
  } else {
    after = `${before.replace(/\s*$/, '\n')}# agent-sdlc mock config change for ${runId}\n${key}=${value}\n`;
  }

  if (after !== before) writeFileSync(targetPath, after);
}

function chooseValidationCommands(contextPack, manifest) {
  const candidates = [
    ...(Array.isArray(manifest.validationCommands) ? manifest.validationCommands : []),
    ...(Array.isArray(contextPack.validationCommands) ? contextPack.validationCommands : []),
    ...(contextPack.build?.mavenCommand ? [contextPack.build.mavenCommand] : []),
    ...(manifest.mavenCommand ? [manifest.mavenCommand] : []),
  ];
  const deduped = [...new Set(candidates.filter(Boolean))];
  return deduped.length ? deduped : ['mvn test'];
}

function scoreConfidence({ contextPack, validationSummary, changedFiles }) {
  const contextSufficiency = Number(contextPack.contextSufficiencyScore ?? contextPack.contextSufficiency ?? 0.6);
  const requirementCoverage = 0.75;
  const validationScore = validationSummary.ok ? 1 : 0;
  const changedFilesRiskScore = changedFiles.length === 1 ? 0.9 : changedFiles.length <= 3 ? 0.75 : 0.45;
  const reviewerScore = 0.7;
  const unknowns = Array.isArray(contextPack.unknowns) ? contextPack.unknowns.length : 2;
  const assumptionsScore = Math.max(0.35, 1 - unknowns * 0.1);
  const inputs = { contextSufficiency, requirementCoverage, validationScore, changedFilesRiskScore, reviewerScore, assumptionsScore };
  const overallConfidence = Number((
    contextSufficiency * 0.20 +
    requirementCoverage * 0.20 +
    validationScore * 0.25 +
    0.8 * 0.10 +
    reviewerScore * 0.10 +
    changedFilesRiskScore * 0.10 +
    assumptionsScore * 0.05
  ).toFixed(2));
  const rating = overallConfidence >= 0.85 ? 'high' : overallConfidence >= 0.7 ? 'medium-high' : overallConfidence >= 0.5 ? 'medium' : 'low';
  const riskFactors = ['mock reviewer score used'];
  if (!validationSummary.ok) riskFactors.push('validation command failed');
  if (unknowns > 0) riskFactors.push(`${unknowns} unresolved unknown(s) in context pack`);
  if (changedFiles.length !== 1) riskFactors.push(`${changedFiles.length} changed files detected`);
  return {
    overallConfidence,
    rating,
    inputs,
    riskFactors,
    recommendedHumanReviewFocus: [
      'verify config key semantics',
      'confirm module-specific validation is sufficient',
      'inspect diff.patch before PR creation approval',
    ],
  };
}

function featureExecute(args) {
  const repo = resolve(String(args.repo || ''));
  const runId = String(args.run || '');
  const targetFile = String(args['target-file'] || '');
  const setKey = String(args['set-key'] || '');
  const setValue = String(args['set-value'] ?? '');

  if (!repo || !existsSync(repo)) die('--repo must point to an existing repository');
  if (!runId) die('--run is required');
  if (!targetFile) die('--target-file is required');
  if (!setKey) die('--set-key is required');
  if (setValue === '') die('--set-value is required');

  const gitRoot = git(repo, ['rev-parse', '--show-toplevel']);
  if (!gitRoot.ok) die(`${repo} is not a git repository`);
  const root = gitRoot.stdout.trim();
  const runDir = join(root, '.agentic-sdlc', 'runs', runId);
  const manifestPath = join(runDir, 'manifest.json');
  const contextPath = join(runDir, 'context-pack.json');
  const approvalPath = join(runDir, 'approvals.jsonl');
  const eventsPath = join(runDir, 'events.jsonl');
  const manifest = readJson(manifestPath, {});
  const contextPack = readJson(contextPath, {});

  appendJsonl(eventsPath, { type: 'feature_execute_started', runId, targetFile, setKey });

  if (!hasApproval(approvalPath, 'implementation_plan')) {
    die(`implementation_plan approval missing in ${approvalPath}`);
  }
  if (!hasApproval(approvalPath, 'execution')) {
    if (args['auto-approve']) {
      appendJsonl(approvalPath, { gate: 'execution', status: 'approved', mode: 'auto', actor: 'agent-sdlc' });
      appendJsonl(eventsPath, { type: 'approval_recorded', gate: 'execution', status: 'approved', mode: 'auto' });
    } else {
      die('execution approval missing; rerun with --auto-approve for demo mode or record approval first');
    }
  }

  const workingBranch = manifest.workingBranch || `agent-sdlc/${runId}`;
  const currentBranch = git(root, ['branch', '--show-current']).stdout.trim();
  const branchExists = git(root, ['rev-parse', '--verify', workingBranch]);
  const checkout = branchExists.ok
    ? git(root, ['checkout', workingBranch])
    : git(root, ['checkout', '-b', workingBranch]);
  if (!checkout.ok) die(`failed to checkout working branch ${workingBranch}: ${checkout.stderr || checkout.stdout}`);
  appendJsonl(eventsPath, { type: 'working_branch_ready', fromBranch: currentBranch, workingBranch });

  const absoluteTarget = resolve(root, targetFile);
  const relativeTarget = relative(root, absoluteTarget);
  if (relativeTarget.startsWith('..')) die('--target-file must stay inside repo');
  applyConfigChange(absoluteTarget, setKey, setValue, runId);
  const configValidation = validateConfigFile(absoluteTarget);
  configValidation.file = relativeTarget;
  writeJson(join(runDir, 'config-validation.json'), configValidation);
  appendJsonl(eventsPath, { type: 'mock_config_change_applied', file: relativeTarget, key: setKey, value: setValue });
  appendJsonl(eventsPath, { type: 'config_validation_completed', ok: configValidation.ok, file: relativeTarget, errors: configValidation.errors });

  const changed = git(root, ['diff', '--name-only']).stdout.split('\n').filter(Boolean);
  const diff = git(root, ['diff', '--', ...changed]);
  writeJson(join(runDir, 'changed-files.json'), { changedFiles: changed });
  writeFileSync(join(runDir, 'diff.patch'), diff.stdout);

  const validationCommands = chooseValidationCommands(contextPack, manifest);
  const validationRuns = validationCommands.map((command) => run(root, command));
  const mavenOutput = validationRuns.map((r) => `$ ${r.command}\nexit=${r.status}\n${r.stdout}${r.stderr}`).join('\n---\n');
  writeFileSync(join(runDir, 'maven-output.txt'), mavenOutput);
  const validationSummary = {
    ok: configValidation.ok && validationRuns.every((r) => r.ok),
    configValidation,
    commands: validationRuns.map(({ command, status, ok }) => ({ command, status, ok })),
  };
  writeJson(join(runDir, 'validation-summary.json'), validationSummary);
  appendJsonl(eventsPath, { type: 'validation_completed', ...validationSummary });

  const confidence = scoreConfidence({ contextPack, validationSummary, changedFiles: changed });
  writeJson(join(runDir, 'confidence.json'), confidence);
  appendJsonl(eventsPath, { type: 'confidence_scored', overallConfidence: confidence.overallConfidence, rating: confidence.rating });
  appendJsonl(eventsPath, { type: 'waiting_for_pr_creation_approval', gate: 'pr_creation' });

  console.log(JSON.stringify({
    runId,
    repo: root,
    state: 'waiting_pr_approval',
    workingBranch,
    changedFiles: changed,
    validation: validationSummary,
    confidence,
    artifacts: {
      changedFiles: join(runDir, 'changed-files.json'),
      diff: join(runDir, 'diff.patch'),
      mavenOutput: join(runDir, 'maven-output.txt'),
      validationSummary: join(runDir, 'validation-summary.json'),
      confidence: join(runDir, 'confidence.json'),
    },
  }, null, 2));
}

function firstLine(text, fallback) {
  const line = String(text || '').split('\n').map((value) => value.trim()).find(Boolean);
  return line || fallback;
}

function bulletList(items, fallback = '- none') {
  if (!Array.isArray(items) || items.length === 0) return fallback;
  return items.map((item) => `- ${item}`).join('\n');
}

function fileListFromChangedFiles(changedFilesArtifact) {
  if (Array.isArray(changedFilesArtifact)) return changedFilesArtifact;
  if (Array.isArray(changedFilesArtifact?.changedFiles)) return changedFilesArtifact.changedFiles;
  return [];
}

function validationLines(validationSummary) {
  const commands = Array.isArray(validationSummary?.commands) ? validationSummary.commands : [];
  if (!commands.length) return '- validation not run or summary unavailable';
  return commands.map((cmd) => `- ${cmd.ok ? 'PASS' : 'FAIL'}: \`${cmd.command}\` (exit ${cmd.status})`).join('\n');
}

function loadRun(repo, runId) {
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

function featurePrPreview(args) {
  const repo = resolve(String(args.repo || ''));
  const runId = String(args.run || '');
  if (!repo || !existsSync(repo)) die('--repo must point to an existing repository');
  if (!runId) die('--run is required');

  const { root, runDir, manifest, contextPack, eventsPath } = loadRun(repo, runId);
  const changedFiles = fileListFromChangedFiles(readJson(join(runDir, 'changed-files.json'), {}));
  const validationSummary = readJson(join(runDir, 'validation-summary.json'), {});
  const confidence = readJson(join(runDir, 'confidence.json'), {});
  const diffPath = join(runDir, 'diff.patch');
  const diff = existsSync(diffPath) ? readFileSync(diffPath, 'utf8') : '';

  if (!changedFiles.length) die(`changed-files.json missing or empty in ${runDir}; run feature execute first`);
  if (!diff) die(`diff.patch missing or empty in ${runDir}; run feature execute first`);

  const workingBranch = manifest.workingBranch || `agent-sdlc/${runId}`;
  const workflowType = manifest.workflowType || contextPack.workflowType || 'feature_config_change';
  const validationOk = Boolean(validationSummary.ok);
  const confidenceLabel = confidence.overallConfidence == null
    ? 'not scored'
    : `${confidence.overallConfidence} (${confidence.rating || 'unrated'})`;

  const title = firstLine(
    manifest.prTitle || contextPack.prTitle || contextPack.requirementSummary || manifest.requirementSummary,
    `[agent-sdlc] ${workflowType.replaceAll('_', ' ')} (${runId})`,
  );

  const body = `## Summary\n\nGenerated PR preview for Agent SDLC run \`${runId}\`.\n\n## Run metadata\n\n- Workflow: \`${workflowType}\`\n- Working branch: \`${workingBranch}\`\n- Validation: ${validationOk ? 'passed' : 'failed or unavailable'}\n- Confidence: ${confidenceLabel}\n\n## Changed files\n\n${bulletList(changedFiles)}\n\n## Validation\n\n${validationLines(validationSummary)}\n\n## Confidence risk factors\n\n${bulletList(confidence.riskFactors)}\n\n## Recommended human review focus\n\n${bulletList(confidence.recommendedHumanReviewFocus)}\n\n## Notes\n\nThis is a preview artifact only. Do not create or update the PR until the \`pr_creation\` approval gate is approved.\n`;

  const checklist = `# Review checklist for ${runId}\n\n- [ ] Confirm the changed files match the approved implementation plan.\n- [ ] Inspect \`diff.patch\` for unintended edits.\n- [ ] Verify config key semantics and rollout behavior.\n- [ ] Confirm validation scope is sufficient for the changed module/service.\n- [ ] Review confidence risk factors.\n- [ ] Approve or reject the \`pr_creation\` gate.\n`;

  const preview = `# PR Preview\n\n## Title\n\n${title}\n\n## Body\n\n${body}\n## Review checklist\n\n${checklist}\n## Diff artifact\n\nSee \`diff.patch\` in this run directory.\n`;

  writeFileSync(join(runDir, 'pr-title.txt'), `${title}\n`);
  writeFileSync(join(runDir, 'pr-body.md'), body);
  writeFileSync(join(runDir, 'review-checklist.md'), checklist);
  writeFileSync(join(runDir, 'pr-preview.md'), preview);
  appendJsonl(eventsPath, { type: 'pr_preview_generated', runId, title, artifacts: ['pr-preview.md', 'pr-title.txt', 'pr-body.md', 'review-checklist.md'] });
  appendJsonl(eventsPath, { type: 'waiting_for_pr_creation_approval', gate: 'pr_creation' });

  console.log(JSON.stringify({
    runId,
    repo: root,
    state: 'waiting_pr_approval',
    title,
    validation: validationSummary,
    confidence,
    artifacts: {
      prPreview: join(runDir, 'pr-preview.md'),
      prTitle: join(runDir, 'pr-title.txt'),
      prBody: join(runDir, 'pr-body.md'),
      reviewChecklist: join(runDir, 'review-checklist.md'),
      diff: diffPath,
    },
  }, null, 2));
}

function isProtectedBranch(branch, policy = defaultPolicy()) {
  return (policy.protectedBranches || ['main', 'master']).includes(String(branch || '').trim());
}

function requireFile(path, label) {
  if (!existsSync(path)) die(`${label} missing: ${path}`);
  return readFileSync(path, 'utf8');
}

function loadOptionalText(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function featureCreatePr(args) {
  const repo = resolve(String(args.repo || ''));
  const runId = String(args.run || '');
  const provider = String(args.provider || 'stash');
  const dryRun = args['dry-run'] !== false;
  if (!repo || !existsSync(repo)) die('--repo must point to an existing repository');
  if (!runId) die('--run is required');
  if (provider !== 'stash' && provider !== 'bitbucket') die('--provider currently supports stash or bitbucket only');

  const { root, runDir, manifest, contextPack, approvalPath, eventsPath } = loadRun(repo, runId);
  const policy = loadPolicy(root);
  const title = firstLine(requireFile(join(runDir, 'pr-title.txt'), 'pr-title.txt'), `[agent-sdlc] ${runId}`);
  const body = requireFile(join(runDir, 'pr-body.md'), 'pr-body.md');
  requireFile(join(runDir, 'pr-preview.md'), 'pr-preview.md');
  requireFile(join(runDir, 'review-checklist.md'), 'review-checklist.md');
  const validationSummary = readJson(join(runDir, 'validation-summary.json'), {});
  const confidence = readJson(join(runDir, 'confidence.json'), {});
  const changedFiles = fileListFromChangedFiles(readJson(join(runDir, 'changed-files.json'), {}));

  if (!hasApproval(approvalPath, 'pr_creation')) {
    die(`pr_creation approval missing in ${approvalPath}`);
  }
  if (!validationSummary.ok && policy.validationMustPassForPr && !args['allow-failed-validation']) {
    die('validation failed or unavailable; use --allow-failed-validation only after explicit approval');
  }

  const sourceBranch = manifest.workingBranch || git(root, ['branch', '--show-current']).stdout.trim();
  const targetBranch = manifest.baseBranch || contextPack.baseBranch || 'main';
  if (isProtectedBranch(sourceBranch, policy)) die(`refusing to create PR from protected branch: ${sourceBranch}`);

  const currentBranch = git(root, ['branch', '--show-current']).stdout.trim();
  if (isProtectedBranch(currentBranch, policy)) {
    die(`refusing to run PR creation while checked out on protected branch: ${currentBranch}`);
  }

  const request = {
    provider,
    dryRun,
    runId,
    repository: root,
    sourceBranch,
    targetBranch,
    title,
    description: body,
    changedFiles,
    validation: validationSummary,
    confidence,
    policy: {
      prCreationApprovalRequired: true,
      prCreationApprovalPresent: true,
      validationMustPassUnlessOverridden: !args['allow-failed-validation'],
      protectedSourceBranchesRejected: policy.protectedBranches || ['main', 'master'],
      mergeNotAllowed: policy.disallowedActions?.includes('merge_pr') ?? true,
      deployNotAllowed: policy.disallowedActions?.includes('deploy') ?? true,
    },
  };

  const requestPath = join(runDir, `${provider}-create-pr-request.json`);
  writeJson(requestPath, request);
  appendJsonl(eventsPath, { type: 'create_pr_request_generated', runId, provider, dryRun, requestPath });

  console.log(JSON.stringify({
    runId,
    repo: root,
    state: dryRun ? 'pr_creation_request_ready' : 'pr_creation_request_ready_unexecuted',
    provider,
    dryRun,
    requestPath,
    sourceBranch,
    targetBranch,
    title,
  }, null, 2));
}

function featureEnterprisePreview(args) {
  const repo = resolve(String(args.repo || ''));
  const runId = String(args.run || '');
  if (!repo || !existsSync(repo)) die('--repo must point to an existing repository');
  if (!runId) die('--run is required');

  const { root, runDir, manifest, contextPack, eventsPath } = loadRun(repo, runId);
  const prTitle = firstLine(requireFile(join(runDir, 'pr-title.txt'), 'pr-title.txt'), `[agent-sdlc] ${runId}`);
  const prBody = requireFile(join(runDir, 'pr-body.md'), 'pr-body.md');
  const prRequest = readJson(join(runDir, 'stash-create-pr-request.json'), readJson(join(runDir, 'bitbucket-create-pr-request.json'), {}));
  const changedFiles = fileListFromChangedFiles(readJson(join(runDir, 'changed-files.json'), {}));
  const validationSummary = readJson(join(runDir, 'validation-summary.json'), {});
  const confidence = readJson(join(runDir, 'confidence.json'), {});
  const diff = loadOptionalText(join(runDir, 'diff.patch'));

  if (!changedFiles.length) die(`changed-files.json missing or empty in ${runDir}; run feature execute first`);
  if (!Object.keys(prRequest).length) die(`PR request artifact missing in ${runDir}; run feature create-pr --dry-run first`);

  const jiraKey = String(args['jira-key'] || manifest.jiraKey || contextPack.jira?.key || contextPack.jiraKey || 'TBD-JIRA');
  const confluencePageId = String(args['confluence-page-id'] || manifest.confluencePageId || contextPack.confluence?.pageId || contextPack.confluencePageId || 'TBD-CONFLUENCE-PAGE');
  const sourceBranch = prRequest.sourceBranch || manifest.workingBranch || `agent-sdlc/${runId}`;
  const targetBranch = prRequest.targetBranch || manifest.baseBranch || 'main';
  const prUrlPlaceholder = prRequest.url || '<PR URL pending creation>';
  const validationText = validationSummary.ok ? 'Validation passed' : 'Validation failed or unavailable';
  const confidenceText = confidence.overallConfidence == null ? 'not scored' : `${confidence.overallConfidence} (${confidence.rating || 'unrated'})`;

  const jiraPreview = `# Jira update preview\n\nIssue: ${jiraKey}\n\n## Proposed comment\n\nAgent SDLC run \`${runId}\` prepared a PR creation request.\n\n- PR title: ${prTitle}\n- Source branch: \`${sourceBranch}\`\n- Target branch: \`${targetBranch}\`\n- PR URL: ${prUrlPlaceholder}\n- Validation: ${validationText}\n- Confidence: ${confidenceText}\n\nChanged files:\n${bulletList(changedFiles)}\n\nHuman approval required before this Jira comment is written: \`enterprise_update\`.\n`;

  const confluencePreview = `# Confluence update preview\n\nPage: ${confluencePageId}\n\n## Proposed section\n\n### Agent SDLC run ${runId}\n\n**Summary:** ${prTitle}\n\n**Branch:** \`${sourceBranch}\` → \`${targetBranch}\`\n\n**Validation:** ${validationText}\n\n**Confidence:** ${confidenceText}\n\n**Changed files:**\n${bulletList(changedFiles)}\n\n**Review focus:**\n${bulletList(confidence.recommendedHumanReviewFocus)}\n\nHuman approval required before this Confluence update is written: \`enterprise_update\`.\n`;

  const enterpriseRequest = {
    runId,
    repository: root,
    state: 'waiting_enterprise_update_approval',
    approvalGate: 'enterprise_update',
    dryRun: true,
    jira: {
      issueKey: jiraKey,
      action: 'add_comment',
      previewArtifact: join(runDir, 'jira-update-preview.md'),
      body: jiraPreview,
    },
    confluence: {
      pageId: confluencePageId,
      action: 'append_section',
      previewArtifact: join(runDir, 'confluence-update-preview.md'),
      body: confluencePreview,
    },
    inputs: {
      prTitle,
      prBodyArtifact: join(runDir, 'pr-body.md'),
      prRequestArtifact: prRequest.provider ? join(runDir, `${prRequest.provider}-create-pr-request.json`) : undefined,
      sourceBranch,
      targetBranch,
      changedFiles,
      validation: validationSummary,
      confidence,
      diffSummary: diff ? diff.split('\n').slice(0, 40).join('\n') : '',
    },
    policy: {
      enterpriseUpdateApprovalRequired: true,
      writeJiraNow: false,
      writeConfluenceNow: false,
      secretsMustNotBeLogged: true,
      productionMutationNotAllowed: true,
    },
  };

  writeFileSync(join(runDir, 'jira-update-preview.md'), jiraPreview);
  writeFileSync(join(runDir, 'confluence-update-preview.md'), confluencePreview);
  writeJson(join(runDir, 'enterprise-update-request.json'), enterpriseRequest);
  appendJsonl(eventsPath, { type: 'enterprise_update_preview_generated', runId, artifacts: ['jira-update-preview.md', 'confluence-update-preview.md', 'enterprise-update-request.json'] });
  appendJsonl(eventsPath, { type: 'waiting_for_enterprise_update_approval', gate: 'enterprise_update' });

  console.log(JSON.stringify({
    runId,
    repo: root,
    state: 'waiting_enterprise_update_approval',
    approvalGate: 'enterprise_update',
    artifacts: {
      jiraPreview: join(runDir, 'jira-update-preview.md'),
      confluencePreview: join(runDir, 'confluence-update-preview.md'),
      enterpriseRequest: join(runDir, 'enterprise-update-request.json'),
    },
  }, null, 2));
}

function featureApplyEnterpriseUpdates(args) {
  const repo = resolve(String(args.repo || ''));
  const runId = String(args.run || '');
  const dryRun = args['dry-run'] !== false;
  if (!repo || !existsSync(repo)) die('--repo must point to an existing repository');
  if (!runId) die('--run is required');

  const { root, runDir, approvalPath, eventsPath } = loadRun(repo, runId);
  const enterpriseRequestPath = join(runDir, 'enterprise-update-request.json');
  const enterpriseRequest = readJson(enterpriseRequestPath, undefined);
  if (!enterpriseRequest) die(`enterprise-update-request.json missing in ${runDir}; run feature enterprise-preview first`);
  if (!hasApproval(approvalPath, 'enterprise_update')) {
    die(`enterprise_update approval missing in ${approvalPath}`);
  }

  const jiraApplyRequest = {
    runId,
    dryRun,
    provider: 'jira',
    action: enterpriseRequest.jira?.action || 'add_comment',
    issueKey: enterpriseRequest.jira?.issueKey,
    body: enterpriseRequest.jira?.body,
    sourcePreviewArtifact: enterpriseRequest.jira?.previewArtifact || join(runDir, 'jira-update-preview.md'),
    policy: {
      enterpriseUpdateApprovalPresent: true,
      dryRunOnly: dryRun,
      realWriteRequiresDryRunFalse: true,
      secretsMustNotBeLogged: true,
    },
  };

  const confluenceApplyRequest = {
    runId,
    dryRun,
    provider: 'confluence',
    action: enterpriseRequest.confluence?.action || 'append_section',
    pageId: enterpriseRequest.confluence?.pageId,
    body: enterpriseRequest.confluence?.body,
    sourcePreviewArtifact: enterpriseRequest.confluence?.previewArtifact || join(runDir, 'confluence-update-preview.md'),
    policy: {
      enterpriseUpdateApprovalPresent: true,
      dryRunOnly: dryRun,
      realWriteRequiresDryRunFalse: true,
      secretsMustNotBeLogged: true,
    },
  };

  const jiraPath = join(runDir, 'jira-update-apply-request.json');
  const confluencePath = join(runDir, 'confluence-update-apply-request.json');
  writeJson(jiraPath, jiraApplyRequest);
  writeJson(confluencePath, confluenceApplyRequest);
  appendJsonl(eventsPath, { type: 'enterprise_update_apply_requests_generated', runId, dryRun, artifacts: ['jira-update-apply-request.json', 'confluence-update-apply-request.json'] });

  console.log(JSON.stringify({
    runId,
    repo: root,
    state: dryRun ? 'enterprise_update_apply_requests_ready' : 'enterprise_update_apply_requests_ready_unexecuted',
    dryRun,
    artifacts: {
      jiraApplyRequest: jiraPath,
      confluenceApplyRequest: confluencePath,
    },
  }, null, 2));
}

function detectValidationCommands(root) {
  if (existsSync(join(root, 'pom.xml'))) return ['mvn test'];
  if (existsSync(join(root, 'build.gradle')) || existsSync(join(root, 'build.gradle.kts'))) return ['./gradlew test'];
  if (existsSync(join(root, 'package.json'))) {
    const pkg = readJson(join(root, 'package.json'), {});
    if (pkg.scripts?.test) return ['npm test'];
  }
  if (existsSync(join(root, 'go.mod'))) return ['go test ./...'];
  return [];
}

function detectRepoStack(root) {
  const stack = [];
  if (existsSync(join(root, 'pom.xml'))) stack.push('maven');
  if (existsSync(join(root, 'build.gradle')) || existsSync(join(root, 'build.gradle.kts'))) stack.push('gradle');
  if (existsSync(join(root, 'package.json'))) stack.push('node');
  if (existsSync(join(root, 'go.mod'))) stack.push('go');
  if (existsSync(join(root, 'requirements.txt')) || existsSync(join(root, 'pyproject.toml'))) stack.push('python');
  return stack;
}

function listTrackedFiles(root) {
  const result = git(root, ['ls-files']);
  if (!result.ok) return [];
  return result.stdout.split('\n').filter(Boolean);
}

function walkFiles(root, options = {}) {
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

function isConfigPath(path) {
  const lower = path.toLowerCase();
  return lower.endsWith('.json') || lower.endsWith('.yml') || lower.endsWith('.yaml') || lower.endsWith('.properties') || lower.endsWith('.toml');
}

function basicYamlValidation(text) {
  const errors = [];
  const stack = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!line.trim() || line.trim().startsWith('#')) return;
    const indent = line.match(/^ */)[0].length;
    if (indent % 2 !== 0) errors.push(`line ${index + 1}: indentation should use multiples of two spaces`);
    const trimmed = line.trim();
    if (trimmed.includes('\t')) errors.push(`line ${index + 1}: tabs are not allowed in YAML indentation`);
    if (!trimmed.startsWith('- ') && !trimmed.includes(':')) errors.push(`line ${index + 1}: expected key/value separator ':'`);
    while (stack.length && stack.at(-1).indent >= indent) stack.pop();
    if (/^[^:#][^:]*:\s*$/.test(trimmed)) stack.push({ indent, key: trimmed.slice(0, -1) });
  });
  return errors;
}

function validateConfigFile(path) {
  const lower = path.toLowerCase();
  const text = readFileSync(path, 'utf8');
  const result = { file: path, ok: true, type: 'unknown', errors: [] };
  try {
    if (lower.endsWith('.json')) {
      result.type = 'json';
      JSON.parse(text || '{}');
    } else if (lower.endsWith('.yml') || lower.endsWith('.yaml')) {
      result.type = 'yaml';
      result.errors.push(...basicYamlValidation(text));
    } else if (lower.endsWith('.properties')) {
      result.type = 'properties';
      text.split(/\r?\n/).forEach((line, index) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) return;
        if (!trimmed.includes('=') && !trimmed.includes(':')) result.errors.push(`line ${index + 1}: expected key=value or key:value`);
      });
    } else if (lower.endsWith('.toml')) {
      result.type = 'toml';
      text.split(/\r?\n/).forEach((line, index) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('[')) return;
        if (!trimmed.includes('=')) result.errors.push(`line ${index + 1}: expected key=value`);
      });
    }
  } catch (error) {
    result.errors.push(error.message);
  }
  result.ok = result.errors.length === 0;
  return result;
}

function validatePolicyShape(policy) {
  const errors = [];
  const warnings = [];
  if (!policy.policyVersion) warnings.push('policyVersion missing; default will be used at runtime');
  if (!Array.isArray(policy.protectedBranches) || policy.protectedBranches.length === 0) errors.push('protectedBranches must be a non-empty array');
  if (!Array.isArray(policy.disallowedActions)) errors.push('disallowedActions must be an array');
  for (const action of ['merge_pr', 'deploy', 'production_mutation']) {
    if (!policy.disallowedActions?.includes(action)) warnings.push(`disallowedActions should include ${action}`);
  }
  for (const flag of ['validationMustPassForPr', 'enterpriseWritesRequireApproval']) {
    if (typeof policy[flag] !== 'boolean') errors.push(`${flag} must be boolean`);
  }
  if (policy.validationMustPassForPr === false) warnings.push('validationMustPassForPr=false weakens PR safety gate');
  if (policy.enterpriseWritesRequireApproval === false) warnings.push('enterpriseWritesRequireApproval=false weakens enterprise write gate');
  return { ok: errors.length === 0, errors, warnings };
}

function repoScan(args) {
  const repo = resolve(String(args.repo || ''));
  if (!repo || !existsSync(repo)) die('--repo must point to an existing repository');
  const gitRoot = git(repo, ['rev-parse', '--show-toplevel']);
  if (!gitRoot.ok) die(`${repo} is not a git repository`);
  const root = gitRoot.stdout.trim();
  const trackedFiles = listTrackedFiles(root);
  const allFiles = trackedFiles.length ? trackedFiles : walkFiles(root);
  const configFiles = allFiles.filter(isConfigPath).sort();
  const dirtyFiles = git(root, ['status', '--short']).stdout.split('\n').filter(Boolean).map((line) => line.slice(3));
  const remotes = git(root, ['remote', '-v']).stdout.split('\n').filter(Boolean);
  const branches = git(root, ['branch', '--format=%(refname:short)']).stdout.split('\n').filter(Boolean);
  const currentBranch = git(root, ['branch', '--show-current']).stdout.trim();
  const scan = {
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
  const outPath = join(root, '.agentic-sdlc', 'repo-scan.json');
  writeJson(outPath, scan);
  console.log(JSON.stringify({ ...scan, artifact: outPath }, null, 2));
}

function policyValidate(args) {
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

function configValidate(args) {
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

function runInit(args) {
  const repo = resolve(String(args.repo || ''));
  const runId = String(args.run || '');
  if (!repo || !existsSync(repo)) die('--repo must point to an existing repository');
  if (!runId) die('--run is required');

  const gitRoot = git(repo, ['rev-parse', '--show-toplevel']);
  if (!gitRoot.ok) die(`${repo} is not a git repository`);
  const root = gitRoot.stdout.trim();
  const runDir = join(root, '.agentic-sdlc', 'runs', runId);
  const policyPath = join(root, '.agentic-sdlc', 'policy.json');
  mkdirSync(runDir, { recursive: true });

  const currentBranch = git(root, ['branch', '--show-current']).stdout.trim() || 'main';
  const workflowType = String(args['workflow-type'] || 'feature_config_change');
  const baseBranch = String(args['base-branch'] || currentBranch || 'main');
  const workingBranch = String(args['working-branch'] || `agent-sdlc/${runId}`);
  const validationCommands = args['validation-command']
    ? [String(args['validation-command'])]
    : detectValidationCommands(root);

  const manifestPath = join(runDir, 'manifest.json');
  const contextPath = join(runDir, 'context-pack.json');
  if (existsSync(manifestPath) && !args.force) die(`manifest.json already exists for ${runId}; use --force to overwrite`);

  const manifest = {
    manifestVersion: '0.1.0',
    runId,
    workflowType,
    baseBranch,
    workingBranch,
    validationCommands,
    createdAt: new Date().toISOString(),
  };
  const contextPack = {
    runId,
    workflowType,
    repoPath: root,
    baseBranch,
    workingBranch,
    validationCommands,
    assumptions: [],
    unknowns: ['implementation plan not generated yet'],
    contextSufficiencyScore: 0.5,
  };

  writeJson(manifestPath, manifest);
  writeJson(contextPath, contextPack);
  if (!existsSync(policyPath) || args.force) writeJson(policyPath, defaultPolicy());
  const approvalPath = join(runDir, 'approvals.jsonl');
  if (!existsSync(approvalPath) || args.force) writeFileSync(approvalPath, '');
  appendJsonl(join(runDir, 'events.jsonl'), { type: 'run_initialized', runId, workflowType, baseBranch, workingBranch });

  console.log(JSON.stringify({
    runId,
    repo: root,
    state: 'waiting_plan_approval',
    runDir,
    artifacts: {
      manifest: manifestPath,
      contextPack: contextPath,
      events: join(runDir, 'events.jsonl'),
    },
    nextRecommendedCommand: `agent-sdlc approval approve --repo ${root} --run ${runId} --gate implementation_plan --actor <name>`,
  }, null, 2));
}

function artifactChecklist(runDir) {
  const names = [
    'manifest.json',
    'context-pack.json',
    '../../policy.json',
    'approvals.jsonl',
    'changed-files.json',
    'diff.patch',
    'maven-output.txt',
    'config-validation.json',
    'validation-summary.json',
    'confidence.json',
    'pr-preview.md',
    'pr-title.txt',
    'pr-body.md',
    'review-checklist.md',
    'stash-create-pr-request.json',
    'bitbucket-create-pr-request.json',
    'jira-update-preview.md',
    'confluence-update-preview.md',
    'enterprise-update-request.json',
    'jira-update-apply-request.json',
    'confluence-update-apply-request.json',
    'audit-report.md',
    'events.jsonl',
  ];
  return names.map((name) => ({ name, present: existsSync(join(runDir, name)) }));
}

function inferState({ artifacts, approvalsPresent, validationSummary }) {
  const has = (name) => artifacts.some((item) => item.name === name && item.present);
  if (has('jira-update-apply-request.json') && has('confluence-update-apply-request.json')) return 'enterprise_update_apply_requests_ready';
  if (has('enterprise-update-request.json')) return approvalsPresent.includes('enterprise_update') ? 'ready_to_apply_enterprise_updates' : 'waiting_enterprise_update_approval';
  if (has('stash-create-pr-request.json') || has('bitbucket-create-pr-request.json')) return 'pr_creation_request_ready';
  if (has('pr-preview.md')) return approvalsPresent.includes('pr_creation') ? 'ready_to_create_pr_request' : 'waiting_pr_approval';
  if (has('confidence.json')) return 'waiting_pr_approval';
  if (approvalsPresent.includes('execution')) return 'ready_to_execute_or_executing';
  if (approvalsPresent.includes('implementation_plan')) return 'waiting_execution_approval';
  if (has('context-pack.json')) return 'waiting_plan_approval';
  return 'created';
}

function nextCommandForState(state, repo, runId) {
  const quotedRepo = repo.includes(' ') ? `"${repo}"` : repo;
  const byState = {
    waiting_execution_approval: `agent-sdlc feature execute --repo ${quotedRepo} --run ${runId} --target-file <file> --set-key <key> --set-value <value> --mock-agent --auto-approve`,
    ready_to_execute_or_executing: `agent-sdlc feature execute --repo ${quotedRepo} --run ${runId} --target-file <file> --set-key <key> --set-value <value> --mock-agent`,
    waiting_pr_approval: `agent-sdlc feature pr-preview --repo ${quotedRepo} --run ${runId}`,
    ready_to_create_pr_request: `agent-sdlc feature create-pr --repo ${quotedRepo} --run ${runId} --provider stash --dry-run`,
    pr_creation_request_ready: `agent-sdlc feature enterprise-preview --repo ${quotedRepo} --run ${runId}`,
    waiting_enterprise_update_approval: `approve enterprise_update, then: agent-sdlc feature apply-enterprise-updates --repo ${quotedRepo} --run ${runId} --dry-run`,
    ready_to_apply_enterprise_updates: `agent-sdlc feature apply-enterprise-updates --repo ${quotedRepo} --run ${runId} --dry-run`,
    enterprise_update_apply_requests_ready: 'Review apply request artifacts or wire approved provider adapters next.',
  };
  return byState[state] || 'Continue planning/approval flow.';
}

function runStatus(args) {
  const repo = resolve(String(args.repo || ''));
  const runId = String(args.run || '');
  if (!repo || !existsSync(repo)) die('--repo must point to an existing repository');
  if (!runId) die('--run is required');

  const { root, runDir, approvalPath, manifest, contextPack } = loadRun(repo, runId);
  const approvalRecords = approvals(approvalPath);
  const approvalsPresent = approvedGates(approvalPath);
  const allGates = ['implementation_plan', 'execution', 'pr_creation', 'enterprise_update'];
  const missingGates = allGates.filter((gate) => !approvalsPresent.includes(gate));
  const artifacts = artifactChecklist(runDir);
  const validationSummary = readJson(join(runDir, 'validation-summary.json'), {});
  const confidence = readJson(join(runDir, 'confidence.json'), {});
  const changedFiles = fileListFromChangedFiles(readJson(join(runDir, 'changed-files.json'), {}));
  const state = inferState({ artifacts, approvalsPresent, validationSummary });
  const nextRecommendedCommand = nextCommandForState(state, root, runId);

  const payload = {
    runId,
    repo: root,
    state,
    workflowType: manifest.workflowType || contextPack.workflowType,
    workingBranch: manifest.workingBranch,
    baseBranch: manifest.baseBranch || contextPack.baseBranch,
    gates: {
      approved: approvalsPresent,
      missing: missingGates,
    },
    artifacts,
    validation: Object.keys(validationSummary).length ? validationSummary : { ok: null, commands: [] },
    confidence: Object.keys(confidence).length ? confidence : { overallConfidence: null, rating: 'not_scored' },
    changedFiles,
    nextRecommendedCommand,
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const presentArtifacts = artifacts.filter((item) => item.present).map((item) => item.name);
  const missingArtifacts = artifacts.filter((item) => !item.present).map((item) => item.name);
  console.log(`Run: ${runId}`);
  console.log(`Repo: ${root}`);
  console.log(`State: ${state}`);
  console.log(`Workflow: ${payload.workflowType || 'unknown'}`);
  console.log(`Working branch: ${payload.workingBranch || 'unknown'}`);
  console.log(`Approved gates: ${approvalsPresent.length ? approvalsPresent.join(', ') : 'none'}`);
  console.log(`Missing gates: ${missingGates.length ? missingGates.join(', ') : 'none'}`);
  console.log(`Validation: ${payload.validation.ok === null ? 'not run' : payload.validation.ok ? 'passed' : 'failed'}`);
  console.log(`Confidence: ${payload.confidence.overallConfidence ?? 'not scored'} (${payload.confidence.rating || 'not_scored'})`);
  console.log(`Changed files: ${changedFiles.length ? changedFiles.join(', ') : 'none'}`);
  console.log(`Artifacts present: ${presentArtifacts.length ? presentArtifacts.join(', ') : 'none'}`);
  console.log(`Artifacts missing: ${missingArtifacts.length ? missingArtifacts.join(', ') : 'none'}`);
  console.log(`Next: ${nextRecommendedCommand}`);
}

function runAuditReport(args) {
  const repo = resolve(String(args.repo || ''));
  const runId = String(args.run || '');
  if (!repo || !existsSync(repo)) die('--repo must point to an existing repository');
  if (!runId) die('--run is required');

  const { root, runDir, approvalPath, manifest, contextPack } = loadRun(repo, runId);
  const approvalRecords = approvals(approvalPath);
  const validationSummary = readJson(join(runDir, 'validation-summary.json'), {});
  const confidence = readJson(join(runDir, 'confidence.json'), {});
  const changedFiles = fileListFromChangedFiles(readJson(join(runDir, 'changed-files.json'), {}));
  const events = existsSync(join(runDir, 'events.jsonl'))
    ? readFileSync(join(runDir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const artifacts = artifactChecklist(runDir);
  const approved = approvedGates(approvalPath);
  const state = inferState({ artifacts, approvalsPresent: approved, validationSummary });

  const report = `# Agent SDLC audit report\n\n## Run\n\n- Run ID: \`${runId}\`\n- Repo: \`${root}\`\n- State: \`${state}\`\n- Workflow: \`${manifest.workflowType || contextPack.workflowType || 'unknown'}\`\n- Working branch: \`${manifest.workingBranch || 'unknown'}\`\n- Base branch: \`${manifest.baseBranch || contextPack.baseBranch || 'unknown'}\`\n\n## Gates\n\n${approvalRecords.length ? approvalRecords.map((record) => `- ${record.timestamp || '-'} — ${record.gate}: ${record.status} (${record.actor || 'unknown'}${record.reason ? `; ${record.reason}` : ''})`).join('\n') : '- no approval records'}\n\n## Validation\n\n- Status: ${validationSummary.ok === true ? 'passed' : validationSummary.ok === false ? 'failed' : 'not run'}\n${Array.isArray(validationSummary.commands) ? validationSummary.commands.map((cmd) => `- ${cmd.command}: ${cmd.ok ? 'PASS' : 'FAIL'} (exit ${cmd.status})`).join('\n') : ''}\n\n## Confidence\n\n- Overall: ${confidence.overallConfidence ?? 'not scored'}\n- Rating: ${confidence.rating || 'not_scored'}\n\nRisk factors:\n${bulletList(confidence.riskFactors)}\n\nReview focus:\n${bulletList(confidence.recommendedHumanReviewFocus)}\n\n## Changed files\n\n${bulletList(changedFiles)}\n\n## Artifact checklist\n\n${artifacts.map((item) => `- [${item.present ? 'x' : ' '}] ${item.name}`).join('\n')}\n\n## Event timeline\n\n${events.length ? events.map((event) => `- ${event.timestamp || '-'} — ${event.type || 'event'}${event.gate ? ` (${event.gate})` : ''}`).join('\n') : '- no events'}\n`;

  const reportPath = join(runDir, 'audit-report.md');
  writeFileSync(reportPath, report);
  appendJsonl(join(runDir, 'events.jsonl'), { type: 'audit_report_generated', runId, reportPath });
  console.log(JSON.stringify({ runId, repo: root, state, reportPath }, null, 2));
}

function approvalCommand(args, action) {
  const repo = resolve(String(args.repo || ''));
  const runId = String(args.run || '');
  if (!repo || !existsSync(repo)) die('--repo must point to an existing repository');
  if (!runId) die('--run is required');

  const { root, runDir, approvalPath, eventsPath } = loadRun(repo, runId);
  const validGates = ['context_pack', 'requirement', 'implementation_plan', 'execution', 'pr_creation', 'enterprise_update'];

  if (action === 'list') {
    const records = approvals(approvalPath);
    const latest = new Map();
    for (const record of records) {
      if (record.gate) latest.set(record.gate, record);
    }
    const payload = {
      runId,
      repo: root,
      approvalPath,
      approvals: records,
      latestByGate: Object.fromEntries(latest),
      approvedGates: approvedGates(approvalPath),
    };
    if (args.json) console.log(JSON.stringify(payload, null, 2));
    else {
      console.log(`Run: ${runId}`);
      console.log(`Approvals file: ${approvalPath}`);
      if (!records.length) console.log('No approval records.');
      for (const record of records) {
        console.log(`${record.timestamp || '-'}  ${record.gate || '-'}  ${record.status || '-'}  actor=${record.actor || '-'}${record.reason ? `  reason=${record.reason}` : ''}`);
      }
    }
    return;
  }

  const gate = String(args.gate || '');
  if (!gate) die('--gate is required');
  if (!validGates.includes(gate)) die(`--gate must be one of: ${validGates.join(', ')}`);

  if (action === 'approve') {
    const actor = String(args.actor || process.env.USER || 'unknown');
    const record = { gate, status: 'approved', actor, reason: args.reason ? String(args.reason) : undefined };
    appendJsonl(approvalPath, record);
    appendJsonl(eventsPath, { type: 'approval_recorded', gate, status: 'approved', actor });
    console.log(JSON.stringify({ runId, repo: root, gate, status: 'approved', actor, approvalPath }, null, 2));
    return;
  }

  if (action === 'reject') {
    const actor = String(args.actor || process.env.USER || 'unknown');
    const reason = String(args.reason || 'rejected');
    const record = { gate, status: 'rejected', actor, reason };
    appendJsonl(approvalPath, record);
    appendJsonl(eventsPath, { type: 'approval_recorded', gate, status: 'rejected', actor, reason });
    console.log(JSON.stringify({ runId, repo: root, gate, status: 'rejected', actor, reason, approvalPath }, null, 2));
    return;
  }

  die(`unknown approval action: ${action}`);
}

function usage() {
  console.log(`Usage:\n  agent-sdlc repo scan --repo <repo>\n  agent-sdlc policy validate --repo <repo>\n  agent-sdlc config validate --repo <repo> [--target-file <path>]\n  agent-sdlc run init --repo <repo> --run <run-id> [--workflow-type feature_config_change] [--validation-command 'npm test'] [--force]\n  agent-sdlc feature execute --repo <repo> --run <run-id> --target-file <path> --set-key <key> --set-value <value> [--mock-agent] [--auto-approve]\n  agent-sdlc feature pr-preview --repo <repo> --run <run-id>\n  agent-sdlc feature create-pr --repo <repo> --run <run-id> --provider stash [--dry-run] [--allow-failed-validation]\n  agent-sdlc feature enterprise-preview --repo <repo> --run <run-id> [--jira-key ABC-123] [--confluence-page-id 12345]\n  agent-sdlc feature apply-enterprise-updates --repo <repo> --run <run-id> [--dry-run]\n  agent-sdlc run status --repo <repo> --run <run-id> [--json]\n  agent-sdlc run audit-report --repo <repo> --run <run-id>\n  agent-sdlc approval list --repo <repo> --run <run-id> [--json]\n  agent-sdlc approval approve --repo <repo> --run <run-id> --gate <gate> [--actor <name>] [--reason <reason>]\n  agent-sdlc approval reject --repo <repo> --run <run-id> --gate <gate> --reason <reason> [--actor <name>]\n`);
}

const args = parseArgs(process.argv.slice(2));
const [domain, action] = args._;
if (domain === 'repo' && action === 'scan') repoScan(args);
else if (domain === 'policy' && action === 'validate') policyValidate(args);
else if (domain === 'config' && action === 'validate') configValidate(args);
else if (domain === 'run' && action === 'init') runInit(args);
else if (domain === 'feature' && action === 'execute') featureExecute(args);
else if (domain === 'feature' && action === 'pr-preview') featurePrPreview(args);
else if (domain === 'feature' && action === 'create-pr') featureCreatePr(args);
else if (domain === 'feature' && action === 'enterprise-preview') featureEnterprisePreview(args);
else if (domain === 'feature' && action === 'apply-enterprise-updates') featureApplyEnterpriseUpdates(args);
else if (domain === 'run' && action === 'status') runStatus(args);
else if (domain === 'run' && action === 'audit-report') runAuditReport(args);
else if (domain === 'approval' && ['list', 'approve', 'reject'].includes(action)) approvalCommand(args, action);
else {
  usage();
  process.exit(domain ? 1 : 0);
}
