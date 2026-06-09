import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveAgentAdapter } from '../adapters/index.mjs';
import { appendJsonl, loadOptionalText, readJson, requireFile, writeJson } from '../core/io.mjs';
import { hasApproval } from '../core/approvals.mjs';
import { git, run } from '../core/git.mjs';
import { isProtectedBranch, loadPolicy } from '../core/policy.mjs';
import { chooseValidationCommands, scoreConfidence } from '../core/confidence.mjs';
import { die, loadRun } from '../core/run-context.mjs';
import { bulletList, fileListFromChangedFiles, firstLine, parseCsv, validationLines } from '../core/text.mjs';

export function featureInterpret(args) {
  const repo = resolve(String(args.repo || ''));
  const runId = String(args.run || '');
  const requirement = String(args.requirement || '');
  if (!repo || !existsSync(repo)) die('--repo must point to an existing repository');
  if (!runId) die('--run is required');
  if (!requirement.trim()) die('--requirement is required');

  const { root, runDir, manifest, contextPack, eventsPath } = loadRun(repo, runId);
  const adapterName = args['agent-adapter'] || args.adapter || manifest.agentAdapter || contextPack.agentAdapter || 'mock-agent';
  const adapter = resolveAgentAdapter(String(adapterName));
  const interpretedRequirement = adapter.interpretRequirement({ requirement, runId, manifest, contextPack });
  const adapterArtifact = {
    provider: interpretedRequirement.provider,
    contractVersion: interpretedRequirement.contractVersion,
    phase: interpretedRequirement.phase,
    capabilities: interpretedRequirement.capabilities,
    audit: interpretedRequirement.audit,
  };
  const markdown = `# Interpreted requirement\n\n## Intent\n\n${interpretedRequirement.intent}\n\n## Summary\n\n${interpretedRequirement.summary}\n\n## Constraints\n\n${bulletList(interpretedRequirement.constraints)}\n\n## Assumptions\n\n${bulletList(interpretedRequirement.assumptions)}\n\n## Unknowns\n\n${bulletList(interpretedRequirement.unknowns)}\n\n## Approval\n\nApprove or reject the \`requirement\` gate before planning.\n`;

  writeJson(join(runDir, 'agent-adapter-interpret-requirement.json'), adapterArtifact);
  if (interpretedRequirement.providerResult?.executed) {
    writeJson(join(runDir, 'agent-adapter-interpret-result.json'), {
      provider: interpretedRequirement.provider,
      phase: interpretedRequirement.phase,
      ok: interpretedRequirement.providerResult.ok,
      status: interpretedRequirement.providerResult.status,
      signal: interpretedRequirement.providerResult.signal,
      error: interpretedRequirement.providerResult.error,
      startedAt: interpretedRequirement.providerResult.startedAt,
      completedAt: interpretedRequirement.providerResult.completedAt,
      parsed: interpretedRequirement.providerResult.parsed,
      interpretedRequirement: interpretedRequirement.providerResult.interpretedRequirement,
      readiness: interpretedRequirement.providerResult.readiness,
    });
    writeFileSync(join(runDir, 'amp-interpret-raw-output.txt'), interpretedRequirement.providerResult.stdout || '');
  }
  writeJson(join(runDir, 'interpreted-requirement.json'), {
    runId,
    repository: root,
    ...interpretedRequirement,
    adapter: adapterArtifact,
  });
  writeFileSync(join(runDir, 'interpreted-requirement.md'), markdown);
  appendJsonl(eventsPath, { type: 'adapter_phase_completed', provider: adapterArtifact.provider, phase: adapterArtifact.phase, capabilities: adapterArtifact.capabilities });
  appendJsonl(eventsPath, { type: 'requirement_interpreted', runId, provider: adapterArtifact.provider, phase: adapterArtifact.phase });

  console.log(JSON.stringify({
    runId,
    repo: root,
    state: 'waiting_requirement_approval',
    adapter: adapterArtifact,
    interpretedRequirement,
    artifacts: {
      interpretedRequirementJson: join(runDir, 'interpreted-requirement.json'),
      interpretedRequirementMarkdown: join(runDir, 'interpreted-requirement.md'),
      adapter: join(runDir, 'agent-adapter-interpret-requirement.json'),
    },
  }, null, 2));
}

export function featurePlan(args) {
  const repo = resolve(String(args.repo || ''));
  const runId = String(args.run || '');
  if (!repo || !existsSync(repo)) die('--repo must point to an existing repository');
  if (!runId) die('--run is required');

  const { root, runDir, manifest, contextPack, eventsPath } = loadRun(repo, runId);
  const interpretedRequirement = readJson(join(runDir, 'interpreted-requirement.json'), {});
  if (!Object.keys(interpretedRequirement).length) die(`interpreted-requirement.json missing in ${runDir}; run feature interpret first`);
  const adapterName = args['agent-adapter'] || args.adapter || manifest.agentAdapter || contextPack.agentAdapter || 'mock-agent';
  const adapter = resolveAgentAdapter(String(adapterName));
  const taskBreakdown = adapter.createTaskBreakdown({ runId, manifest, contextPack, interpretedRequirement });
  const implementationPlan = adapter.createImplementationPlan({ runId, manifest, contextPack, interpretedRequirement, taskBreakdown });
  const adapterArtifact = {
    provider: implementationPlan.provider,
    contractVersion: implementationPlan.contractVersion,
    phase: implementationPlan.phase,
    phases: ['create_task_breakdown', 'create_implementation_plan'],
    capabilities: implementationPlan.capabilities,
    audit: implementationPlan.audit,
  };
  const taskMarkdown = `# Task breakdown\n\n## Requirement\n\n${interpretedRequirement.intent || interpretedRequirement.summary || 'Unknown requirement'}\n\n## Tasks\n\n${taskBreakdown.tasks.map((task) => `- ${task.id}: ${task.title} (${task.type}, risk=${task.risk})`).join('\n')}\n`;
  const planMarkdown = `# Implementation plan\n\n## Summary\n\n${implementationPlan.summary}\n\n## Steps\n\n${implementationPlan.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}\n\n## Required approvals\n\n${bulletList(implementationPlan.requiredApprovals)}\n\nHuman execution approval is required before file writes outside demo auto-approve mode.\n`;

  writeJson(join(runDir, 'task-breakdown.json'), { runId, repository: root, ...taskBreakdown });
  if (taskBreakdown.providerResult?.executed) {
    writeJson(join(runDir, 'agent-adapter-task-breakdown-result.json'), {
      provider: taskBreakdown.provider,
      phase: taskBreakdown.phase,
      ok: taskBreakdown.providerResult.ok,
      status: taskBreakdown.providerResult.status,
      signal: taskBreakdown.providerResult.signal,
      error: taskBreakdown.providerResult.error,
      startedAt: taskBreakdown.providerResult.startedAt,
      completedAt: taskBreakdown.providerResult.completedAt,
      parsed: taskBreakdown.providerResult.parsed,
      taskBreakdown: taskBreakdown.providerResult.taskBreakdown,
      readiness: taskBreakdown.providerResult.readiness,
    });
    writeFileSync(join(runDir, 'amp-task-breakdown-raw-output.txt'), taskBreakdown.providerResult.stdout || '');
  }
  writeFileSync(join(runDir, 'task-breakdown.md'), taskMarkdown);
  writeJson(join(runDir, 'implementation-plan.json'), { runId, repository: root, ...implementationPlan });
  if (implementationPlan.providerResult?.executed) {
    writeJson(join(runDir, 'agent-adapter-implementation-plan-result.json'), {
      provider: implementationPlan.provider,
      phase: implementationPlan.phase,
      ok: implementationPlan.providerResult.ok,
      status: implementationPlan.providerResult.status,
      signal: implementationPlan.providerResult.signal,
      error: implementationPlan.providerResult.error,
      startedAt: implementationPlan.providerResult.startedAt,
      completedAt: implementationPlan.providerResult.completedAt,
      parsed: implementationPlan.providerResult.parsed,
      implementationPlan: implementationPlan.providerResult.implementationPlan,
      readiness: implementationPlan.providerResult.readiness,
    });
    writeFileSync(join(runDir, 'amp-implementation-plan-raw-output.txt'), implementationPlan.providerResult.stdout || '');
  }
  writeFileSync(join(runDir, 'implementation-plan.md'), planMarkdown);
  writeJson(join(runDir, 'agent-adapter-plan.json'), adapterArtifact);
  appendJsonl(eventsPath, { type: 'adapter_phase_completed', provider: adapterArtifact.provider, phase: 'create_task_breakdown', capabilities: adapterArtifact.capabilities });
  appendJsonl(eventsPath, { type: 'adapter_phase_completed', provider: adapterArtifact.provider, phase: 'create_implementation_plan', capabilities: adapterArtifact.capabilities });
  appendJsonl(eventsPath, { type: 'task_breakdown_created', runId, provider: adapterArtifact.provider });
  appendJsonl(eventsPath, { type: 'implementation_plan_created', runId, provider: adapterArtifact.provider });

  console.log(JSON.stringify({
    runId,
    repo: root,
    state: 'waiting_plan_approval',
    adapter: adapterArtifact,
    taskBreakdown,
    implementationPlan,
    artifacts: {
      taskBreakdownJson: join(runDir, 'task-breakdown.json'),
      taskBreakdownMarkdown: join(runDir, 'task-breakdown.md'),
      implementationPlanJson: join(runDir, 'implementation-plan.json'),
      implementationPlanMarkdown: join(runDir, 'implementation-plan.md'),
      adapter: join(runDir, 'agent-adapter-plan.json'),
    },
  }, null, 2));
}

export function featureReview(args) {
  const repo = resolve(String(args.repo || ''));
  const runId = String(args.run || '');
  if (!repo || !existsSync(repo)) die('--repo must point to an existing repository');
  if (!runId) die('--run is required');

  const { root, runDir, manifest, contextPack, eventsPath } = loadRun(repo, runId);
  const changedFiles = fileListFromChangedFiles(readJson(join(runDir, 'changed-files.json'), {}));
  const validationSummary = readJson(join(runDir, 'validation-summary.json'), {});
  const confidence = readJson(join(runDir, 'confidence.json'), {});
  const diff = loadOptionalText(join(runDir, 'diff.patch'));
  if (!changedFiles.length) die(`changed-files.json missing or empty in ${runDir}; run feature execute first`);
  const adapterName = args['agent-adapter'] || args.adapter || manifest.agentAdapter || contextPack.agentAdapter || 'mock-agent';
  const adapter = resolveAgentAdapter(String(adapterName));
  const review = adapter.reviewChanges({ runId, manifest, contextPack, changedFiles, validationSummary, confidence, diff });
  const adapterArtifact = {
    provider: review.provider,
    contractVersion: review.contractVersion,
    phase: review.phase,
    capabilities: review.capabilities,
    audit: review.audit,
  };
  const markdown = `# Change review\n\n## Recommendation\n\n${review.recommendation}\n\n## Findings\n\n${bulletList(review.findings)}\n\n## Human review focus\n\n${bulletList(review.humanReviewFocus)}\n`;

  writeJson(join(runDir, 'change-review.json'), { runId, repository: root, ...review, adapter: adapterArtifact });
  writeFileSync(join(runDir, 'change-review.md'), markdown);
  writeJson(join(runDir, 'agent-adapter-review.json'), adapterArtifact);
  appendJsonl(eventsPath, { type: 'adapter_phase_completed', provider: adapterArtifact.provider, phase: adapterArtifact.phase, capabilities: adapterArtifact.capabilities });
  appendJsonl(eventsPath, { type: 'changes_reviewed', runId, provider: adapterArtifact.provider, recommendation: review.recommendation });

  console.log(JSON.stringify({
    runId,
    repo: root,
    state: 'waiting_pr_approval',
    adapter: adapterArtifact,
    review,
    artifacts: {
      changeReviewJson: join(runDir, 'change-review.json'),
      changeReviewMarkdown: join(runDir, 'change-review.md'),
      adapter: join(runDir, 'agent-adapter-review.json'),
    },
  }, null, 2));
}

export function featureExecute(args) {
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

  const adapterName = args['agent-adapter'] || args.adapter || (args['mock-agent'] ? 'mock-agent' : manifest.agentAdapter || contextPack.agentAdapter || 'mock-agent');
  const adapter = resolveAgentAdapter(String(adapterName));
  const adapterResult = adapter.executeApprovedPlan({ root, runId, targetFile, setKey, setValue, manifest, contextPack });
  const relativeTarget = adapterResult.targetFile;
  const configValidation = adapterResult.configValidation;
  writeJson(join(runDir, 'agent-adapter.json'), adapterResult);
  writeJson(join(runDir, 'config-validation.json'), configValidation);
  appendJsonl(eventsPath, { type: 'adapter_phase_completed', provider: adapterResult.provider, phase: adapterResult.phase, capabilities: adapterResult.capabilities });
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
    adapter: adapterResult,
    artifacts: {
      changedFiles: join(runDir, 'changed-files.json'),
      diff: join(runDir, 'diff.patch'),
      mavenOutput: join(runDir, 'maven-output.txt'),
      validationSummary: join(runDir, 'validation-summary.json'),
      confidence: join(runDir, 'confidence.json'),
      adapter: join(runDir, 'agent-adapter.json'),
    },
  }, null, 2));
}

export function featurePrPreview(args) {
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

export function featureCreatePr(args) {
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

export function featureEnterprisePreview(args) {
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
  const adapterName = args['agent-adapter'] || args.adapter || manifest.agentAdapter || contextPack.agentAdapter || 'mock-agent';
  const adapter = resolveAgentAdapter(String(adapterName));
  const updatePreview = adapter.generateUpdatePreviews({ runId, manifest, contextPack, prTitle, changedFiles });
  const adapterArtifact = {
    provider: updatePreview.provider,
    contractVersion: updatePreview.contractVersion,
    phase: updatePreview.phase,
    capabilities: updatePreview.capabilities,
    audit: updatePreview.audit,
  };

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
  writeJson(join(runDir, 'agent-adapter-update-previews.json'), adapterArtifact);
  writeJson(join(runDir, 'enterprise-update-request.json'), enterpriseRequest);
  appendJsonl(eventsPath, { type: 'adapter_phase_completed', provider: adapterArtifact.provider, phase: adapterArtifact.phase, capabilities: adapterArtifact.capabilities });
  appendJsonl(eventsPath, { type: 'enterprise_update_preview_generated', runId, artifacts: ['jira-update-preview.md', 'confluence-update-preview.md', 'enterprise-update-request.json', 'agent-adapter-update-previews.json'] });
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
      adapter: join(runDir, 'agent-adapter-update-previews.json'),
    },
  }, null, 2));
}

export function featureApplyEnterpriseUpdates(args) {
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
