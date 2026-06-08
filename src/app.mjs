import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve, relative } from 'node:path';
import { URL } from 'node:url';
import { parseArgs } from './cli/args.mjs';
import { appendJsonl, loadOptionalText, readJson, requireFile, writeJson } from './core/io.mjs';
import { approvals, approvedGates, hasApproval } from './core/approvals.mjs';
import { git, run } from './core/git.mjs';
import { defaultPolicy, isProtectedBranch, loadPolicy, validatePolicyShape } from './core/policy.mjs';
import { applyConfigChange, validateConfigFile } from './core/config.mjs';
import { missionControlHtml } from './daemon/mission-control-html.mjs';

function die(message, code = 1) {
  console.error(`agent-sdlc: ${message}`);
  process.exit(code);
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

function parseCsv(value) {
  if (Array.isArray(value)) return value;
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function prProviderFields({ args, manifest, contextPack, provider, sourceBranch, targetBranch }) {
  const stash = manifest.stash || contextPack.stash || contextPack.bitbucket || {};
  const projectKey = String(args['project-key'] || manifest.projectKey || contextPack.projectKey || stash.projectKey || 'TBD_PROJECT');
  const repoSlug = String(args['repo-slug'] || manifest.repoSlug || contextPack.repoSlug || stash.repoSlug || 'TBD_REPO');
  const reviewers = parseCsv(args.reviewers || manifest.reviewers || contextPack.reviewers || stash.reviewers).map((reviewer) => ({ user: { name: reviewer } }));
  return {
    projectKey,
    repoSlug,
    reviewers,
    source: { branch: sourceBranch, refId: `refs/heads/${sourceBranch}` },
    target: { branch: targetBranch, refId: `refs/heads/${targetBranch}` },
    links: {
      self: null,
      web: null,
    },
    providerSchema: provider === 'stash' ? 'stash-rest-preview-v1' : 'bitbucket-rest-preview-v1',
  };
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

  const providerFields = prProviderFields({ args, manifest, contextPack, provider, sourceBranch, targetBranch });
  const request = {
    provider,
    dryRun,
    runId,
    repository: root,
    projectKey: providerFields.projectKey,
    repoSlug: providerFields.repoSlug,
    sourceBranch,
    targetBranch,
    source: providerFields.source,
    target: providerFields.target,
    reviewers: providerFields.reviewers,
    title,
    description: body,
    changedFiles,
    validation: validationSummary,
    confidence,
    providerSchema: providerFields.providerSchema,
    stashRestPayload: {
      title,
      description: body,
      state: 'OPEN',
      open: true,
      closed: false,
      fromRef: {
        id: providerFields.source.refId,
        displayId: providerFields.source.branch,
        repository: {
          slug: providerFields.repoSlug,
          project: { key: providerFields.projectKey },
        },
      },
      toRef: {
        id: providerFields.target.refId,
        displayId: providerFields.target.branch,
        repository: {
          slug: providerFields.repoSlug,
          project: { key: providerFields.projectKey },
        },
      },
      reviewers: providerFields.reviewers,
    },
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
    projectKey: providerFields.projectKey,
    repoSlug: providerFields.repoSlug,
    reviewers: providerFields.reviewers.map((reviewer) => reviewer.user.name),
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

function resolveGitRoot(repo) {
  const resolved = resolve(String(repo || ''));
  if (!resolved || !existsSync(resolved)) die('--repo must point to an existing repository');
  const gitRoot = git(resolved, ['rev-parse', '--show-toplevel']);
  if (!gitRoot.ok) die(`${resolved} is not a git repository`);
  return gitRoot.stdout.trim();
}

function buildRepoScan(root) {
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

function repoScan(args) {
  const root = resolveGitRoot(args.repo);
  const scan = buildRepoScan(root);
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

function buildRunStatusPayload(repo, runId) {
  const { root, runDir, approvalPath, manifest, contextPack } = loadRun(repo, runId);
  const approvalsPresent = approvedGates(approvalPath);
  const allGates = ['implementation_plan', 'execution', 'pr_creation', 'enterprise_update'];
  const missingGates = allGates.filter((gate) => !approvalsPresent.includes(gate));
  const artifacts = artifactChecklist(runDir);
  const validationSummary = readJson(join(runDir, 'validation-summary.json'), {});
  const confidence = readJson(join(runDir, 'confidence.json'), {});
  const changedFiles = fileListFromChangedFiles(readJson(join(runDir, 'changed-files.json'), {}));
  const state = inferState({ artifacts, approvalsPresent, validationSummary });
  const nextRecommendedCommand = nextCommandForState(state, root, runId);
  return {
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
}

function buildRunListPayload(repo) {
  const root = resolveGitRoot(repo);
  const runs = listRunIds(root).map((runId) => {
    try { return buildRunStatusPayload(root, runId); }
    catch (error) { return { runId, repo: root, state: 'unreadable', error: error.message }; }
  });
  const summary = runs.reduce((acc, run) => {
    acc.total += 1;
    acc.byState[run.state] = (acc.byState[run.state] || 0) + 1;
    return acc;
  }, { total: 0, byState: {} });
  return { repo: root, runs, summary };
}

function runList(args) {
  const repo = resolve(String(args.repo || ''));
  if (!repo || !existsSync(repo)) die('--repo must point to an existing repository');
  const payload = buildRunListPayload(repo);
  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(`Repo: ${payload.repo}`);
  console.log(`Runs: ${payload.summary.total}`);
  for (const run of payload.runs) {
    console.log(`${run.runId}\t${run.state}\t${run.workflowType || 'unknown'}\t${run.nextRecommendedCommand || ''}`);
  }
}

function runStatus(args) {
  const repo = resolve(String(args.repo || ''));
  const runId = String(args.run || '');
  if (!repo || !existsSync(repo)) die('--repo must point to an existing repository');
  if (!runId) die('--run is required');

  const payload = buildRunStatusPayload(repo, runId);
  const { artifacts, changedFiles, gates, repo: root, state, nextRecommendedCommand } = payload;

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
  console.log(`Approved gates: ${gates.approved.length ? gates.approved.join(', ') : 'none'}`);
  console.log(`Missing gates: ${gates.missing.length ? gates.missing.join(', ') : 'none'}`);
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

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(text);
}

function readRequestJson(req) {
  return new Promise((resolveBody, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) reject(new Error('request body too large'));
    });
    req.on('end', () => {
      if (!body.trim()) resolveBody({});
      else {
        try { resolveBody(JSON.parse(body)); } catch (error) { reject(error); }
      }
    });
    req.on('error', reject);
  });
}

function runCliAction(root, runId, action, body = {}) {
  const baseArgs = ['--repo', root, '--run', runId];
  const actionArgs = {
    'execute': ['feature', 'execute', ...baseArgs, '--target-file', String(body.targetFile || body['target-file'] || ''), '--set-key', String(body.setKey || body['set-key'] || ''), '--set-value', String(body.setValue ?? body['set-value'] ?? ''), '--mock-agent', '--auto-approve'],
    'pr-preview': ['feature', 'pr-preview', ...baseArgs],
    'audit-report': ['run', 'audit-report', ...baseArgs],
    'create-pr': ['feature', 'create-pr', ...baseArgs, '--provider', String(body.provider || 'stash'), '--project-key', String(body.projectKey || body['project-key'] || 'TBD_PROJECT'), '--repo-slug', String(body.repoSlug || body['repo-slug'] || 'TBD_REPO'), '--reviewers', parseCsv(body.reviewers).join(','), '--dry-run'],
    'enterprise-preview': ['feature', 'enterprise-preview', ...baseArgs, '--jira-key', String(body.jiraKey || body['jira-key'] || 'TBD-JIRA'), '--confluence-page-id', String(body.confluencePageId || body['confluence-page-id'] || 'TBD-CONFLUENCE-PAGE')],
    'apply-enterprise-updates': ['feature', 'apply-enterprise-updates', ...baseArgs, '--dry-run'],
  };
  const args = actionArgs[action];
  if (!args) return { ok: false, status: 400, payload: { error: `unsupported action: ${action}` } };
  if (body.allowFailedValidation || body['allow-failed-validation']) args.push('--allow-failed-validation');
  const result = spawnSync(process.execPath, [process.argv[1], ...args], { cwd: root, encoding: 'utf8' });
  let payload;
  try { payload = JSON.parse(result.stdout || '{}'); }
  catch { payload = { stdout: result.stdout }; }
  if (result.status !== 0) return { ok: false, status: 400, payload: { error: result.stderr || result.stdout || `action failed: ${action}`, action, exitStatus: result.status } };
  return { ok: true, status: 200, payload: { action, result: payload, state: buildRunStatusPayload(root, runId) } };
}

function listRunIds(root) {
  const runsRoot = join(root, '.agentic-sdlc', 'runs');
  if (!existsSync(runsRoot)) return [];
  return readdirSync(runsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function handleDaemonRequest(req, res, root) {
  const url = new URL(req.url, 'http://localhost');
  const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  try {
    if (req.method === 'GET' && url.pathname === '/') return sendText(res, 200, missionControlHtml(), 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, repo: root, currentBranch: git(root, ['branch', '--show-current']).stdout.trim(), runs: listRunIds(root) });
    }
    if (req.method === 'GET' && url.pathname === '/api/repo/scan') {
      const scan = buildRepoScan(root);
      const artifact = join(root, '.agentic-sdlc', 'repo-scan.json');
      writeJson(artifact, scan);
      return sendJson(res, 200, { ...scan, artifact });
    }
    if (req.method === 'GET' && url.pathname === '/api/runs') {
      return sendJson(res, 200, buildRunListPayload(root));
    }
    if (segments[0] === 'api' && segments[1] === 'runs' && segments[2]) {
      const runId = segments[2];
      const { runDir, approvalPath, eventsPath } = loadRun(root, runId);
      if (req.method === 'GET' && segments[3] === 'status') return sendJson(res, 200, buildRunStatusPayload(root, runId));
      if (req.method === 'GET' && segments[3] === 'artifacts' && segments[4]) {
        const artifactName = segments.slice(4).join('/');
        const artifactPath = resolve(runDir, artifactName);
        const rel = relative(runDir, artifactPath);
        if (rel.startsWith('..') || !existsSync(artifactPath)) return sendJson(res, 404, { error: 'artifact not found' });
        const contentType = artifactName.endsWith('.json') || artifactName.endsWith('.jsonl') ? 'application/json; charset=utf-8' : artifactName.endsWith('.md') ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8';
        return sendText(res, 200, readFileSync(artifactPath, 'utf8'), contentType);
      }
      if (req.method === 'POST' && segments[3] === 'actions' && segments[4]) {
        const body = await readRequestJson(req);
        const result = runCliAction(root, runId, segments[4], body);
        return sendJson(res, result.status, result.payload);
      }
      if (req.method === 'POST' && segments[3] === 'approvals') {
        const body = await readRequestJson(req);
        const gate = String(body.gate || '');
        const status = String(body.status || '');
        const actor = String(body.actor || 'mission-control');
        const reason = body.reason ? String(body.reason) : undefined;
        const validGates = ['context_pack', 'requirement', 'implementation_plan', 'execution', 'pr_creation', 'enterprise_update'];
        if (!validGates.includes(gate)) return sendJson(res, 400, { error: `invalid gate: ${gate}` });
        if (!['approved', 'rejected'].includes(status)) return sendJson(res, 400, { error: 'status must be approved or rejected' });
        appendJsonl(approvalPath, { gate, status, actor, reason });
        appendJsonl(eventsPath, { type: 'approval_recorded', gate, status, actor, reason, source: 'mission-control' });
        return sendJson(res, 200, { runId, gate, status, actor, approvalPath, state: buildRunStatusPayload(root, runId).state });
      }
    }
    return sendJson(res, 404, { error: 'not found' });
  } catch (error) {
    return sendJson(res, 500, { error: error.message, stack: process.env.AGENT_SDLC_DEBUG ? error.stack : undefined });
  }
}

function daemonStart(args) {
  const root = resolveGitRoot(args.repo || '.');
  const port = Number(args.port || 4317);
  const host = String(args.host || '127.0.0.1');
  const server = createServer((req, res) => {
    handleDaemonRequest(req, res, root);
  });
  server.listen(port, host, () => {
    console.log(JSON.stringify({ state: 'daemon_started', repo: root, url: `http://${host}:${server.address().port}`, endpoints: ['/api/health', '/api/repo/scan', '/api/runs'] }, null, 2));
  });
}

function usage() {
  console.log(`Usage:\n  agent-sdlc daemon start --repo <repo> [--host 127.0.0.1] [--port 4317]\n  agent-sdlc repo scan --repo <repo>\n  agent-sdlc policy validate --repo <repo>\n  agent-sdlc config validate --repo <repo> [--target-file <path>]\n  agent-sdlc run init --repo <repo> --run <run-id> [--workflow-type feature_config_change] [--validation-command 'npm test'] [--force]\n  agent-sdlc run list --repo <repo> [--json]\n  agent-sdlc feature execute --repo <repo> --run <run-id> --target-file <path> --set-key <key> --set-value <value> [--mock-agent] [--auto-approve]\n  agent-sdlc feature pr-preview --repo <repo> --run <run-id>\n  agent-sdlc feature create-pr --repo <repo> --run <run-id> --provider stash [--dry-run] [--project-key ABC] [--repo-slug service] [--reviewers alice,bob] [--allow-failed-validation]\n  agent-sdlc feature enterprise-preview --repo <repo> --run <run-id> [--jira-key ABC-123] [--confluence-page-id 12345]\n  agent-sdlc feature apply-enterprise-updates --repo <repo> --run <run-id> [--dry-run]\n  agent-sdlc run status --repo <repo> --run <run-id> [--json]\n  agent-sdlc run audit-report --repo <repo> --run <run-id>\n  agent-sdlc approval list --repo <repo> --run <run-id> [--json]\n  agent-sdlc approval approve --repo <repo> --run <run-id> --gate <gate> [--actor <name>] [--reason <reason>]\n  agent-sdlc approval reject --repo <repo> --run <run-id> --gate <gate> --reason <reason> [--actor <name>]\n`);
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const [domain, action] = args._;
  if (domain === 'daemon' && action === 'start') daemonStart(args);
  else if (domain === 'repo' && action === 'scan') repoScan(args);
  else if (domain === 'policy' && action === 'validate') policyValidate(args);
  else if (domain === 'config' && action === 'validate') configValidate(args);
  else if (domain === 'run' && action === 'init') runInit(args);
  else if (domain === 'run' && action === 'list') runList(args);
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
}
