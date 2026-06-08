import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appendJsonl, readJson, writeJson } from '../core/io.mjs';
import { approvals, approvedGates } from '../core/approvals.mjs';
import { git } from '../core/git.mjs';
import { defaultPolicy } from '../core/policy.mjs';
import { detectValidationCommands, resolveGitRoot } from '../core/repo.mjs';
import { die, listRunIds, loadRun } from '../core/run-context.mjs';
import { bulletList, fileListFromChangedFiles } from '../core/text.mjs';

export function runInit(args) {
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

export function artifactChecklist(runDir) {
  const names = [
    'manifest.json',
    'context-pack.json',
    '../../policy.json',
    'approvals.jsonl',
    'agent-adapter-interpret-requirement.json',
    'interpreted-requirement.json',
    'interpreted-requirement.md',
    'agent-adapter-plan.json',
    'task-breakdown.json',
    'task-breakdown.md',
    'implementation-plan.json',
    'implementation-plan.md',
    'agent-adapter.json',
    'changed-files.json',
    'diff.patch',
    'maven-output.txt',
    'config-validation.json',
    'validation-summary.json',
    'confidence.json',
    'agent-adapter-review.json',
    'change-review.json',
    'change-review.md',
    'pr-preview.md',
    'pr-title.txt',
    'pr-body.md',
    'review-checklist.md',
    'stash-create-pr-request.json',
    'bitbucket-create-pr-request.json',
    'agent-adapter-update-previews.json',
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

export function inferState({ artifacts, approvalsPresent, validationSummary }) {
  const has = (name) => artifacts.some((item) => item.name === name && item.present);
  if (has('jira-update-apply-request.json') && has('confluence-update-apply-request.json')) return 'enterprise_update_apply_requests_ready';
  if (has('enterprise-update-request.json')) return approvalsPresent.includes('enterprise_update') ? 'ready_to_apply_enterprise_updates' : 'waiting_enterprise_update_approval';
  if (has('stash-create-pr-request.json') || has('bitbucket-create-pr-request.json')) return 'pr_creation_request_ready';
  if (has('pr-preview.md')) return approvalsPresent.includes('pr_creation') ? 'ready_to_create_pr_request' : 'waiting_pr_approval';
  if (has('confidence.json')) return 'waiting_pr_approval';
  if (approvalsPresent.includes('execution')) return 'ready_to_execute_or_executing';
  if (approvalsPresent.includes('implementation_plan')) return 'waiting_execution_approval';
  if (has('implementation-plan.json')) return 'waiting_plan_approval';
  if (has('interpreted-requirement.json')) return 'waiting_requirement_approval';
  if (has('context-pack.json')) return 'waiting_plan_approval';
  return 'created';
}

export function nextCommandForState(state, repo, runId) {
  const quotedRepo = repo.includes(' ') ? `"${repo}"` : repo;
  const byState = {
    waiting_requirement_approval: `approve requirement, then: agent-sdlc feature plan --repo ${quotedRepo} --run ${runId}`,
    waiting_plan_approval: `agent-sdlc feature plan --repo ${quotedRepo} --run ${runId}, then approve implementation_plan`,
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

export function buildRunStatusPayload(repo, runId) {
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

export function buildRunListPayload(repo) {
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

export function runList(args) {
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

export function runStatus(args) {
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

export function runAuditReport(args) {
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
