import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';

const cli = new URL('../bin/agent-sdlc.mjs', import.meta.url).pathname;

function sh(cwd, command) {
  const result = spawnSync(command, { cwd, shell: true, encoding: 'utf8' });
  assert.equal(result.status, 0, `${command}\n${result.stdout}\n${result.stderr}`);
  return result;
}

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'agent-sdlc-exec-'));
  mkdirSync(join(repo, 'src/main/resources'), { recursive: true });
  mkdirSync(join(repo, '.agentic-sdlc/runs/run-1'), { recursive: true });
  writeFileSync(join(repo, 'src/main/resources/application.yml'), 'app:\n  name: demo\n');
  writeFileSync(join(repo, '.agentic-sdlc/runs/run-1/manifest.json'), JSON.stringify({
    manifestVersion: '0.1.0',
    runId: 'run-1',
    workingBranch: 'agent-sdlc/run-1',
    validationCommands: ['node --version'],
  }, null, 2));
  writeFileSync(join(repo, '.agentic-sdlc/runs/run-1/context-pack.json'), JSON.stringify({
    runId: 'run-1',
    contextSufficiencyScore: 0.8,
    unknowns: [],
  }, null, 2));
  writeFileSync(join(repo, '.agentic-sdlc/runs/run-1/approvals.jsonl'), JSON.stringify({ gate: 'implementation_plan', status: 'approved' }) + '\n');
  sh(repo, 'git init -q && git config user.email test@example.com && git config user.name Test && git add src/main/resources/application.yml && git commit -q -m initial');
  return repo;
}

test('feature interpret uses adapter and persists interpreted requirement artifacts', () => {
  const repo = makeRepo();
  const result = spawnSync('node', [cli, 'feature', 'interpret', '--repo', repo, '--run', 'run-1', '--requirement', 'Enable feature flag for service-a', '--agent-adapter', 'mock-agent'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.state, 'waiting_requirement_approval');
  assert.equal(payload.adapter.provider, 'mock-agent');
  assert.equal(payload.adapter.phase, 'interpret_requirement');
  assert.equal(payload.interpretedRequirement.intent, 'Enable feature flag for service-a');
  assert.deepEqual(payload.interpretedRequirement.constraints, ['local-only mock interpretation', 'human approval required before planning or execution']);

  const runDir = join(repo, '.agentic-sdlc/runs/run-1');
  const interpreted = JSON.parse(readFileSync(join(runDir, 'interpreted-requirement.json'), 'utf8'));
  assert.equal(interpreted.intent, 'Enable feature flag for service-a');
  assert.equal(interpreted.adapter.provider, 'mock-agent');
  assert.match(readFileSync(join(runDir, 'interpreted-requirement.md'), 'utf8'), /Enable feature flag for service-a/);
  assert.match(readFileSync(join(runDir, 'agent-adapter-interpret-requirement.json'), 'utf8'), /interpret_requirement/);
  assert.match(readFileSync(join(runDir, 'events.jsonl'), 'utf8'), /requirement_interpreted/);
});

function interpretRequirement(repo) {
  const result = spawnSync('node', [cli, 'feature', 'interpret', '--repo', repo, '--run', 'run-1', '--requirement', 'Enable feature flag for service-a', '--agent-adapter', 'mock-agent'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('feature plan creates task breakdown and implementation plan artifacts', () => {
  const repo = makeRepo();
  interpretRequirement(repo);
  const result = spawnSync('node', [cli, 'feature', 'plan', '--repo', repo, '--run', 'run-1', '--agent-adapter', 'mock-agent'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.state, 'waiting_plan_approval');
  assert.equal(payload.adapter.provider, 'mock-agent');
  assert.equal(payload.adapter.phase, 'create_implementation_plan');
  assert.equal(payload.taskBreakdown.tasks[0].id, 'task-1');
  assert.match(payload.implementationPlan.steps[0], /Apply controlled config change/);

  const runDir = join(repo, '.agentic-sdlc/runs/run-1');
  assert.match(readFileSync(join(runDir, 'task-breakdown.md'), 'utf8'), /Enable feature flag for service-a/);
  assert.match(readFileSync(join(runDir, 'implementation-plan.md'), 'utf8'), /execution approval/);
  assert.match(readFileSync(join(runDir, 'agent-adapter-plan.json'), 'utf8'), /create_implementation_plan/);
  assert.match(readFileSync(join(runDir, 'events.jsonl'), 'utf8'), /implementation_plan_created/);
});

test('provider check writes Amp readiness without exposing credentials', () => {
  const repo = makeRepo();
  const result = spawnSync('node', [cli, 'provider', 'check', '--repo', repo, '--provider', 'amp', '--run', 'run-1'], {
    encoding: 'utf8',
    env: { ...process.env, AMP_API_KEY: 'secret-test-value' },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.provider, 'amp');
  assert.equal(payload.config.apiKeyPresent, true);
  assert.equal(payload.safeDefault.externalCallExecuted, false);
  assert.equal(payload.safeDefault.credentialsLogged, false);
  assert.match(payload.artifact, /provider-readiness\/amp\.json/);
  assert.doesNotMatch(result.stdout, /secret-test-value/);

  const artifact = readFileSync(join(repo, '.agentic-sdlc/provider-readiness/amp.json'), 'utf8');
  assert.match(artifact, /live Amp invocation is not requested/);
  assert.doesNotMatch(artifact, /secret-test-value/);
});

test('amp live interpret invokes configured command only after explicit opt-in and persists raw output', () => {
  const repo = makeRepo();
  const fakeAmp = join(repo, 'fake-amp.mjs');
  writeFileSync(fakeAmp, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  console.log(JSON.stringify({
    intent: 'Live interpreted feature flag requirement',
    summary: 'Live Amp summary',
    workflowType: 'feature_config_change',
    constraints: ['read-only live interpretation'],
    assumptions: ['fake amp command used in test'],
    unknowns: ['real provider output not used']
  }));
});
`);
  chmodSync(fakeAmp, 0o755);

  const result = spawnSync('node', [cli, 'feature', 'interpret', '--repo', repo, '--run', 'run-1', '--requirement', 'Enable feature flag for service-a', '--agent-adapter', 'amp'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENT_SDLC_AMP_LIVE: 'true',
      AGENT_SDLC_AMP_ALLOW_NETWORK: 'true',
      AGENT_SDLC_AMP_COMMAND: fakeAmp,
      AMP_API_KEY: 'secret-test-value',
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stdout, /secret-test-value/);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.adapter.provider, 'amp');
  assert.equal(payload.interpretedRequirement.intent, 'Live interpreted feature flag requirement');
  assert.equal(payload.interpretedRequirement.providerRequest.externalCallExecuted, true);
  assert.equal(payload.interpretedRequirement.providerRequest.liveInvocationSucceeded, true);
  assert.equal(payload.interpretedRequirement.audit.providerInvocationExecuted, true);

  const runDir = join(repo, '.agentic-sdlc/runs/run-1');
  assert.match(readFileSync(join(runDir, 'amp-interpret-raw-output.txt'), 'utf8'), /Live Amp summary/);
  assert.match(readFileSync(join(runDir, 'agent-adapter-interpret-result.json'), 'utf8'), /Live interpreted feature flag requirement/);
  assert.doesNotMatch(readFileSync(join(runDir, 'interpreted-requirement.json'), 'utf8'), /secret-test-value/);
});

test('amp live planning invokes configured command for task breakdown and plan only after opt-in', () => {
  const repo = makeRepo();
  const fakeAmp = join(repo, 'fake-amp-plan.mjs');
  writeFileSync(fakeAmp, `#!/usr/bin/env node
let input = '';
process.stdin.on('data', (chunk) => { input += chunk.toString(); });
process.stdin.on('end', () => {
  if (input.includes('task breakdown')) {
    console.log(JSON.stringify({
      tasks: [
        { id: 'live-task-1', title: 'Live task from Amp', type: 'implementation', risk: 'low' },
        { id: 'live-task-2', title: 'Validate live plan artifacts', type: 'validation', risk: 'low' }
      ]
    }));
  } else {
    console.log(JSON.stringify({
      summary: 'Live implementation plan from Amp',
      steps: ['Apply explicit config change', 'Run validation evidence capture'],
      tasks: ['live-task-1', 'live-task-2'],
      requiredApprovals: ['implementation_plan', 'execution', 'pr_creation']
    }));
  }
});
`);
  chmodSync(fakeAmp, 0o755);

  const interpret = spawnSync('node', [cli, 'feature', 'interpret', '--repo', repo, '--run', 'run-1', '--requirement', 'Enable feature flag for service-a', '--agent-adapter', 'amp'], { encoding: 'utf8' });
  assert.equal(interpret.status, 0, interpret.stderr || interpret.stdout);

  const result = spawnSync('node', [cli, 'feature', 'plan', '--repo', repo, '--run', 'run-1', '--agent-adapter', 'amp'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENT_SDLC_AMP_LIVE: 'true',
      AGENT_SDLC_AMP_ALLOW_NETWORK: 'true',
      AGENT_SDLC_AMP_COMMAND: fakeAmp,
      AMP_API_KEY: 'secret-test-value',
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stdout, /secret-test-value/);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.taskBreakdown.tasks[0].id, 'live-task-1');
  assert.equal(payload.taskBreakdown.providerRequest.externalCallExecuted, true);
  assert.equal(payload.implementationPlan.summary, 'Live implementation plan from Amp');
  assert.equal(payload.implementationPlan.providerRequest.liveInvocationSucceeded, true);
  assert.equal(payload.implementationPlan.audit.providerInvocationExecuted, true);

  const runDir = join(repo, '.agentic-sdlc/runs/run-1');
  assert.match(readFileSync(join(runDir, 'amp-task-breakdown-raw-output.txt'), 'utf8'), /Live task from Amp/);
  assert.match(readFileSync(join(runDir, 'amp-implementation-plan-raw-output.txt'), 'utf8'), /Live implementation plan from Amp/);
  assert.match(readFileSync(join(runDir, 'agent-adapter-task-breakdown-result.json'), 'utf8'), /live-task-1/);
  assert.match(readFileSync(join(runDir, 'agent-adapter-implementation-plan-result.json'), 'utf8'), /Live implementation plan from Amp/);
  assert.doesNotMatch(readFileSync(join(runDir, 'implementation-plan.json'), 'utf8'), /secret-test-value/);
});

test('amp adapter skeleton records provider requests across planning and execution phases', () => {
  const repo = makeRepo();
  const interpret = spawnSync('node', [cli, 'feature', 'interpret', '--repo', repo, '--run', 'run-1', '--requirement', 'Enable feature flag for service-a', '--agent-adapter', 'amp'], { encoding: 'utf8' });
  assert.equal(interpret.status, 0, interpret.stderr || interpret.stdout);
  const interpretedPayload = JSON.parse(interpret.stdout);
  assert.equal(interpretedPayload.adapter.provider, 'amp');
  assert.equal(interpretedPayload.interpretedRequirement.providerRequest.externalCallExecuted, false);
  assert.equal(interpretedPayload.interpretedRequirement.providerRequest.readiness.safeDefault.credentialsLogged, false);
  assert.match(interpretedPayload.interpretedRequirement.constraints.join('\n'), /no Amp SDK\/CLI call/);

  const plan = spawnSync('node', [cli, 'feature', 'plan', '--repo', repo, '--run', 'run-1', '--agent-adapter', 'amp'], { encoding: 'utf8' });
  assert.equal(plan.status, 0, plan.stderr || plan.stdout);
  const planPayload = JSON.parse(plan.stdout);
  assert.equal(planPayload.adapter.provider, 'amp');
  assert.equal(planPayload.taskBreakdown.providerRequest.mode, 'request_artifact_only');
  assert.match(planPayload.implementationPlan.steps.join('\n'), /Live Amp execution is configured|deterministic control-plane/);

  const execute = spawnSync('node', [cli, 'feature', 'execute', '--repo', repo, '--run', 'run-1', '--target-file', 'src/main/resources/application.yml', '--set-key', 'feature.enabled', '--set-value', 'true', '--agent-adapter', 'amp', '--auto-approve'], { encoding: 'utf8' });
  assert.equal(execute.status, 0, execute.stderr || execute.stdout);
  const executePayload = JSON.parse(execute.stdout);
  assert.equal(executePayload.adapter.provider, 'amp');
  assert.equal(executePayload.adapter.audit.providerInvocationExecuted, false);
  assert.equal(executePayload.adapter.audit.controlledLocalWrite, true);
  assert.equal(executePayload.adapter.providerRequest.externalCallExecuted, false);

  const review = spawnSync('node', [cli, 'feature', 'review', '--repo', repo, '--run', 'run-1', '--agent-adapter', 'amp'], { encoding: 'utf8' });
  assert.equal(review.status, 0, review.stderr || review.stdout);
  const reviewPayload = JSON.parse(review.stdout);
  assert.equal(reviewPayload.adapter.provider, 'amp');
  assert.match(reviewPayload.review.findings.join('\n'), /Amp review request recorded/);

  const runDir = join(repo, '.agentic-sdlc/runs/run-1');
  assert.match(readFileSync(join(runDir, 'interpreted-requirement.json'), 'utf8'), /request_artifact_only/);
  assert.match(readFileSync(join(runDir, 'implementation-plan.json'), 'utf8'), /implementation-plan-v1/);
  assert.match(readFileSync(join(runDir, 'agent-adapter.json'), 'utf8'), /safe_local_config_change/);
  assert.match(readFileSync(join(runDir, 'change-review.json'), 'utf8'), /change-review-v1/);
});

test('feature review creates change review artifacts after execution', () => {
  const repo = makeRepo();
  const execute = spawnSync('node', [cli, 'feature', 'execute', '--repo', repo, '--run', 'run-1', '--target-file', 'src/main/resources/application.yml', '--set-key', 'feature.enabled', '--set-value', 'true', '--mock-agent', '--auto-approve'], { encoding: 'utf8' });
  assert.equal(execute.status, 0, execute.stderr || execute.stdout);

  const result = spawnSync('node', [cli, 'feature', 'review', '--repo', repo, '--run', 'run-1', '--agent-adapter', 'mock-agent'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.state, 'waiting_pr_approval');
  assert.equal(payload.adapter.phase, 'review_changes');
  assert.equal(payload.review.recommendation, 'approve_with_human_review');

  const runDir = join(repo, '.agentic-sdlc/runs/run-1');
  assert.match(readFileSync(join(runDir, 'change-review.md'), 'utf8'), /approve_with_human_review/);
  assert.match(readFileSync(join(runDir, 'change-review.json'), 'utf8'), /review_changes/);
  assert.match(readFileSync(join(runDir, 'events.jsonl'), 'utf8'), /changes_reviewed/);
});

test('feature execute applies controlled config change and persists artifacts', () => {
  const repo = makeRepo();
  const result = spawnSync('node', [cli, 'feature', 'execute', '--repo', repo, '--run', 'run-1', '--target-file', 'src/main/resources/application.yml', '--set-key', 'feature.enabled', '--set-value', 'true', '--mock-agent', '--auto-approve'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.state, 'waiting_pr_approval');
  assert.deepEqual(payload.changedFiles, ['src/main/resources/application.yml']);
  assert.equal(payload.validation.ok, true);
  assert.equal(payload.confidence.rating, 'high');
  assert.equal(payload.adapter.provider, 'mock-agent');
  assert.equal(payload.adapter.phase, 'execute_approved_plan');

  const runDir = join(repo, '.agentic-sdlc/runs/run-1');
  const adapter = JSON.parse(readFileSync(join(runDir, 'agent-adapter.json'), 'utf8'));
  assert.equal(adapter.provider, 'mock-agent');
  assert.equal(adapter.phase, 'execute_approved_plan');
  assert.deepEqual(adapter.capabilities, ['deterministic_config_change']);
  assert.match(readFileSync(join(runDir, 'events.jsonl'), 'utf8'), /adapter_phase_completed/);
  assert.match(readFileSync(join(repo, 'src/main/resources/application.yml'), 'utf8'), /feature:\n  enabled: true/);
  assert.match(readFileSync(join(runDir, 'diff.patch'), 'utf8'), /agent-sdlc mock config change/);
  assert.ok(existsSync(join(runDir, 'changed-files.json')));
  assert.ok(existsSync(join(runDir, 'maven-output.txt')));
  assert.ok(existsSync(join(runDir, 'config-validation.json')));
  assert.ok(existsSync(join(runDir, 'validation-summary.json')));
  assert.ok(existsSync(join(runDir, 'confidence.json')));
});

test('feature pr-preview generates PR preview artifacts without creating a PR', () => {
  const repo = makeRepo();
  const execute = spawnSync('node', [cli, 'feature', 'execute', '--repo', repo, '--run', 'run-1', '--target-file', 'src/main/resources/application.yml', '--set-key', 'feature.enabled', '--set-value', 'true', '--mock-agent', '--auto-approve'], { encoding: 'utf8' });
  assert.equal(execute.status, 0, execute.stderr || execute.stdout);

  const result = spawnSync('node', [cli, 'feature', 'pr-preview', '--repo', repo, '--run', 'run-1'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.state, 'waiting_pr_approval');
  assert.match(payload.title, /agent-sdlc/);

  const runDir = join(repo, '.agentic-sdlc/runs/run-1');
  assert.match(readFileSync(join(runDir, 'pr-title.txt'), 'utf8'), /feature config change/);
  assert.match(readFileSync(join(runDir, 'pr-body.md'), 'utf8'), /Changed files/);
  assert.match(readFileSync(join(runDir, 'review-checklist.md'), 'utf8'), /Approve or reject the `pr_creation` gate/);
  assert.match(readFileSync(join(runDir, 'pr-preview.md'), 'utf8'), /PR Preview/);
  assert.match(readFileSync(join(runDir, 'events.jsonl'), 'utf8'), /pr_preview_generated/);
});

function executeAndPreview(repo) {
  const execute = spawnSync('node', [cli, 'feature', 'execute', '--repo', repo, '--run', 'run-1', '--target-file', 'src/main/resources/application.yml', '--set-key', 'feature.enabled', '--set-value', 'true', '--mock-agent', '--auto-approve'], { encoding: 'utf8' });
  assert.equal(execute.status, 0, execute.stderr || execute.stdout);
  const preview = spawnSync('node', [cli, 'feature', 'pr-preview', '--repo', repo, '--run', 'run-1'], { encoding: 'utf8' });
  assert.equal(preview.status, 0, preview.stderr || preview.stdout);
}

function executePreviewAndCreatePr(repo) {
  executeAndPreview(repo);
  const runDir = join(repo, '.agentic-sdlc/runs/run-1');
  appendFileSync(join(runDir, 'approvals.jsonl'), JSON.stringify({ gate: 'pr_creation', status: 'approved', actor: 'test' }) + '\n');
  const createPr = spawnSync('node', [cli, 'feature', 'create-pr', '--repo', repo, '--run', 'run-1', '--provider', 'stash', '--dry-run'], { encoding: 'utf8' });
  assert.equal(createPr.status, 0, createPr.stderr || createPr.stdout);
}

function executePreviewCreatePrAndEnterprisePreview(repo) {
  executePreviewAndCreatePr(repo);
  const enterprisePreview = spawnSync('node', [cli, 'feature', 'enterprise-preview', '--repo', repo, '--run', 'run-1', '--jira-key', 'ABC-123', '--confluence-page-id', '98765'], { encoding: 'utf8' });
  assert.equal(enterprisePreview.status, 0, enterprisePreview.stderr || enterprisePreview.stdout);
}

test('feature create-pr requires pr_creation approval', () => {
  const repo = makeRepo();
  executeAndPreview(repo);

  const result = spawnSync('node', [cli, 'feature', 'create-pr', '--repo', repo, '--run', 'run-1', '--provider', 'stash', '--project-key', 'ABC', '--repo-slug', 'service-a', '--reviewers', 'alice,bob', '--dry-run'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /pr_creation approval missing/);
});

test('feature create-pr writes stash request after approval', () => {
  const repo = makeRepo();
  executeAndPreview(repo);
  const runDir = join(repo, '.agentic-sdlc/runs/run-1');
  appendFileSync(join(runDir, 'approvals.jsonl'), JSON.stringify({ gate: 'pr_creation', status: 'approved', actor: 'test' }) + '\n');

  const result = spawnSync('node', [cli, 'feature', 'create-pr', '--repo', repo, '--run', 'run-1', '--provider', 'stash', '--project-key', 'ABC', '--repo-slug', 'service-a', '--reviewers', 'alice,bob', '--dry-run'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.state, 'pr_creation_request_ready');
  assert.equal(payload.provider, 'stash');
  assert.equal(payload.dryRun, true);
  assert.equal(payload.sourceBranch, 'agent-sdlc/run-1');
  assert.equal(payload.projectKey, 'ABC');
  assert.equal(payload.repoSlug, 'service-a');
  assert.deepEqual(payload.reviewers, ['alice', 'bob']);

  const request = JSON.parse(readFileSync(join(runDir, 'stash-create-pr-request.json'), 'utf8'));
  assert.equal(request.title, '[agent-sdlc] feature config change (run-1)');
  assert.equal(request.sourceBranch, 'agent-sdlc/run-1');
  assert.equal(request.targetBranch, 'main');
  assert.equal(request.projectKey, 'ABC');
  assert.equal(request.repoSlug, 'service-a');
  assert.equal(request.stashRestPayload.fromRef.repository.project.key, 'ABC');
  assert.equal(request.stashRestPayload.fromRef.repository.slug, 'service-a');
  assert.deepEqual(request.stashRestPayload.reviewers.map((reviewer) => reviewer.user.name), ['alice', 'bob']);
  assert.equal(request.policy.prCreationApprovalPresent, true);
  assert.deepEqual(request.changedFiles, ['src/main/resources/application.yml']);
  assert.match(readFileSync(join(runDir, 'events.jsonl'), 'utf8'), /create_pr_request_generated/);
});

test('feature enterprise-preview generates Jira and Confluence update previews', () => {
  const repo = makeRepo();
  executePreviewAndCreatePr(repo);

  const result = spawnSync('node', [cli, 'feature', 'enterprise-preview', '--repo', repo, '--run', 'run-1', '--jira-key', 'ABC-123', '--confluence-page-id', '98765'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.state, 'waiting_enterprise_update_approval');
  assert.equal(payload.approvalGate, 'enterprise_update');

  const runDir = join(repo, '.agentic-sdlc/runs/run-1');
  assert.match(readFileSync(join(runDir, 'jira-update-preview.md'), 'utf8'), /Issue: ABC-123/);
  assert.match(readFileSync(join(runDir, 'confluence-update-preview.md'), 'utf8'), /Page: 98765/);
  assert.match(readFileSync(join(runDir, 'jira-update-preview.md'), 'utf8'), /enterprise_update/);
  const request = JSON.parse(readFileSync(join(runDir, 'enterprise-update-request.json'), 'utf8'));
  assert.equal(request.state, 'waiting_enterprise_update_approval');
  assert.equal(request.jira.issueKey, 'ABC-123');
  assert.equal(request.confluence.pageId, '98765');
  assert.equal(request.policy.writeJiraNow, false);
  assert.equal(request.policy.writeConfluenceNow, false);
  assert.deepEqual(request.inputs.changedFiles, ['src/main/resources/application.yml']);
  assert.match(readFileSync(join(runDir, 'agent-adapter-update-previews.json'), 'utf8'), /generate_update_previews/);
  assert.match(readFileSync(join(runDir, 'events.jsonl'), 'utf8'), /adapter_phase_completed/);
  assert.match(readFileSync(join(runDir, 'events.jsonl'), 'utf8'), /enterprise_update_preview_generated/);
});

test('feature apply-enterprise-updates requires enterprise_update approval', () => {
  const repo = makeRepo();
  executePreviewCreatePrAndEnterprisePreview(repo);

  const result = spawnSync('node', [cli, 'feature', 'apply-enterprise-updates', '--repo', repo, '--run', 'run-1', '--dry-run'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /enterprise_update approval missing/);
});

test('feature apply-enterprise-updates writes Jira and Confluence apply requests after approval', () => {
  const repo = makeRepo();
  executePreviewCreatePrAndEnterprisePreview(repo);
  const runDir = join(repo, '.agentic-sdlc/runs/run-1');
  appendFileSync(join(runDir, 'approvals.jsonl'), JSON.stringify({ gate: 'enterprise_update', status: 'approved', actor: 'test' }) + '\n');

  const result = spawnSync('node', [cli, 'feature', 'apply-enterprise-updates', '--repo', repo, '--run', 'run-1', '--dry-run'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.state, 'enterprise_update_apply_requests_ready');
  assert.equal(payload.dryRun, true);

  const jira = JSON.parse(readFileSync(join(runDir, 'jira-update-apply-request.json'), 'utf8'));
  const confluence = JSON.parse(readFileSync(join(runDir, 'confluence-update-apply-request.json'), 'utf8'));
  assert.equal(jira.provider, 'jira');
  assert.equal(jira.issueKey, 'ABC-123');
  assert.equal(jira.policy.enterpriseUpdateApprovalPresent, true);
  assert.equal(jira.policy.dryRunOnly, true);
  assert.equal(confluence.provider, 'confluence');
  assert.equal(confluence.pageId, '98765');
  assert.equal(confluence.policy.enterpriseUpdateApprovalPresent, true);
  assert.match(readFileSync(join(runDir, 'events.jsonl'), 'utf8'), /enterprise_update_apply_requests_generated/);
});

test('run status summarizes state, gates, artifacts, validation, confidence, and next command', () => {
  const repo = makeRepo();
  executePreviewCreatePrAndEnterprisePreview(repo);
  const runDir = join(repo, '.agentic-sdlc/runs/run-1');
  appendFileSync(join(runDir, 'approvals.jsonl'), JSON.stringify({ gate: 'enterprise_update', status: 'approved', actor: 'test' }) + '\n');

  const result = spawnSync('node', [cli, 'run', 'status', '--repo', repo, '--run', 'run-1', '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const status = JSON.parse(result.stdout);
  assert.equal(status.state, 'ready_to_apply_enterprise_updates');
  assert.deepEqual(status.gates.approved.sort(), ['enterprise_update', 'execution', 'implementation_plan', 'pr_creation'].sort());
  assert.equal(status.validation.ok, true);
  assert.equal(status.confidence.rating, 'high');
  assert.deepEqual(status.changedFiles, ['src/main/resources/application.yml']);
  assert.ok(status.artifacts.some((item) => item.name === 'enterprise-update-request.json' && item.present));
  assert.match(status.nextRecommendedCommand, /apply-enterprise-updates/);

  const textResult = spawnSync('node', [cli, 'run', 'status', '--repo', repo, '--run', 'run-1'], { encoding: 'utf8' });
  assert.equal(textResult.status, 0, textResult.stderr || textResult.stdout);
  assert.match(textResult.stdout, /State: ready_to_apply_enterprise_updates/);
  assert.match(textResult.stdout, /Next: agent-sdlc feature apply-enterprise-updates/);

  const listResult = spawnSync('node', [cli, 'run', 'list', '--repo', repo, '--json'], { encoding: 'utf8' });
  assert.equal(listResult.status, 0, listResult.stderr || listResult.stdout);
  const listPayload = JSON.parse(listResult.stdout);
  assert.equal(listPayload.summary.total, 1);
  assert.equal(listPayload.summary.byState.ready_to_apply_enterprise_updates, 1);
  assert.equal(listPayload.runs[0].runId, 'run-1');
});

test('approval commands list, approve, and reject gates with latest-state semantics', () => {
  const repo = makeRepo();
  const approve = spawnSync('node', [cli, 'approval', 'approve', '--repo', repo, '--run', 'run-1', '--gate', 'execution', '--actor', 'tester', '--reason', 'safe demo'], { encoding: 'utf8' });
  assert.equal(approve.status, 0, approve.stderr || approve.stdout);
  assert.equal(JSON.parse(approve.stdout).status, 'approved');

  const reject = spawnSync('node', [cli, 'approval', 'reject', '--repo', repo, '--run', 'run-1', '--gate', 'execution', '--actor', 'tester', '--reason', 'changed mind'], { encoding: 'utf8' });
  assert.equal(reject.status, 0, reject.stderr || reject.stdout);
  assert.equal(JSON.parse(reject.stdout).status, 'rejected');

  const list = spawnSync('node', [cli, 'approval', 'list', '--repo', repo, '--run', 'run-1', '--json'], { encoding: 'utf8' });
  assert.equal(list.status, 0, list.stderr || list.stdout);
  const payload = JSON.parse(list.stdout);
  assert.equal(payload.latestByGate.execution.status, 'rejected');
  assert.deepEqual(payload.approvedGates, ['implementation_plan']);

  const status = spawnSync('node', [cli, 'run', 'status', '--repo', repo, '--run', 'run-1', '--json'], { encoding: 'utf8' });
  assert.equal(status.status, 0, status.stderr || status.stdout);
  assert.equal(JSON.parse(status.stdout).state, 'waiting_execution_approval');
});

test('run init scaffolds manifest and context pack with validation detection', () => {
  const repo = mkdtempSync(join(tmpdir(), 'agent-sdlc-init-'));
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }, null, 2));
  sh(repo, 'git init -q && git config user.email test@example.com && git config user.name Test && git add package.json && git commit -q -m initial');

  const result = spawnSync('node', [cli, 'run', 'init', '--repo', repo, '--run', 'new-run'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.state, 'waiting_plan_approval');

  const runDir = join(repo, '.agentic-sdlc/runs/new-run');
  const manifest = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8'));
  const context = JSON.parse(readFileSync(join(runDir, 'context-pack.json'), 'utf8'));
  assert.equal(manifest.runId, 'new-run');
  assert.deepEqual(manifest.validationCommands, ['npm test']);
  assert.equal(context.contextSufficiencyScore, 0.5);
  const policy = JSON.parse(readFileSync(join(repo, '.agentic-sdlc/policy.json'), 'utf8'));
  assert.deepEqual(policy.protectedBranches, ['main', 'master']);
  assert.ok(existsSync(join(runDir, 'approvals.jsonl')));
  assert.match(readFileSync(join(runDir, 'events.jsonl'), 'utf8'), /run_initialized/);
});

test('run audit-report writes markdown audit report', () => {
  const repo = makeRepo();
  executePreviewCreatePrAndEnterprisePreview(repo);
  const result = spawnSync('node', [cli, 'run', 'audit-report', '--repo', repo, '--run', 'run-1'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.state, 'waiting_enterprise_update_approval');
  const report = readFileSync(join(repo, '.agentic-sdlc/runs/run-1/audit-report.md'), 'utf8');
  assert.match(report, /# Agent SDLC audit report/);
  assert.match(report, /## Gates/);
  assert.match(report, /## Artifact checklist/);
  assert.match(report, /## Event timeline/);
});

test('repo scan, policy validate, and config validate persist safety artifacts', () => {
  const repo = mkdtempSync(join(tmpdir(), 'agent-sdlc-scan-'));
  mkdirSync(join(repo, 'src/main/resources'), { recursive: true });
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }, null, 2));
  writeFileSync(join(repo, 'src/main/resources/application.yml'), 'app:\n  name: demo\n');
  sh(repo, 'git init -q && git config user.email test@example.com && git config user.name Test && git add package.json src/main/resources/application.yml && git commit -q -m initial');
  const init = spawnSync('node', [cli, 'run', 'init', '--repo', repo, '--run', 'scan-run'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr || init.stdout);

  const scan = spawnSync('node', [cli, 'repo', 'scan', '--repo', repo], { encoding: 'utf8' });
  assert.equal(scan.status, 0, scan.stderr || scan.stdout);
  const scanPayload = JSON.parse(scan.stdout);
  assert.deepEqual(scanPayload.stack, ['node']);
  assert.deepEqual(scanPayload.validationCommands, ['npm test']);
  assert.ok(scanPayload.configFiles.includes('package.json'));
  assert.ok(existsSync(join(repo, '.agentic-sdlc/repo-scan.json')));

  const policy = spawnSync('node', [cli, 'policy', 'validate', '--repo', repo], { encoding: 'utf8' });
  assert.equal(policy.status, 0, policy.stderr || policy.stdout);
  const policyPayload = JSON.parse(policy.stdout);
  assert.equal(policyPayload.ok, true);
  assert.equal(policyPayload.policyPresent, true);
  assert.ok(existsSync(join(repo, '.agentic-sdlc/policy-validation.json')));

  const config = spawnSync('node', [cli, 'config', 'validate', '--repo', repo, '--target-file', 'src/main/resources/application.yml'], { encoding: 'utf8' });
  assert.equal(config.status, 0, config.stderr || config.stdout);
  const configPayload = JSON.parse(config.stdout);
  assert.equal(configPayload.ok, true);
  assert.equal(configPayload.filesChecked, 1);
  assert.equal(configPayload.results[0].type, 'yaml');
  assert.ok(existsSync(join(repo, '.agentic-sdlc/config-validation.json')));
});

function waitForDaemon(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`daemon did not start\nstdout=${stdout}\nstderr=${stderr}`)), 5000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      try {
        const payload = JSON.parse(stdout);
        clearTimeout(timer);
        resolve(payload.url);
      } catch {}
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('exit', (code) => reject(new Error(`daemon exited early ${code}\nstdout=${stdout}\nstderr=${stderr}`)));
  });
}

test('source code uses production module directories and thin entrypoints', () => {
  const requiredModules = [
    '../src/main.mjs',
    '../src/cli/args.mjs',
    '../src/core/io.mjs',
    '../src/core/git.mjs',
    '../src/core/policy.mjs',
    '../src/core/approvals.mjs',
    '../src/core/config.mjs',
    '../src/core/amp-runtime.mjs',
    '../src/adapters/index.mjs',
    '../src/adapters/mock-agent.mjs',
    '../src/adapters/amp.mjs',
    '../src/adapters/types.mjs',
    '../src/core/confidence.mjs',
    '../src/core/repo.mjs',
    '../src/core/run-context.mjs',
    '../src/core/text.mjs',
    '../src/commands/feature.mjs',
    '../src/commands/provider.mjs',
    '../src/commands/run.mjs',
    '../src/commands/approval.mjs',
    '../src/commands/safety.mjs',
    '../src/daemon/mission-control-html.mjs',
    '../src/daemon/server.mjs',
  ];
  for (const modulePath of requiredModules) {
    assert.ok(existsSync(new URL(modulePath, import.meta.url).pathname), `${modulePath} should exist`);
  }
  const bin = readFileSync(cli, 'utf8');
  assert.match(bin, /from '\.\.\/src\/main\.mjs'/);
  assert.ok(bin.length < 500, 'bin entrypoint should stay thin; implementation belongs in src/');
  const app = readFileSync(new URL('../src/app.mjs', import.meta.url), 'utf8');
  assert.ok(app.length < 12000, 'src/app.mjs should stay as the dispatcher; command implementations belong in src/commands/');
});

test('daemon serves mission-control UI, status API, artifacts, and approval updates', async () => {
  const repo = makeRepo();
  const child = spawn('node', [cli, 'daemon', 'start', '--repo', repo, '--port', '0'], { encoding: 'utf8' });
  try {
    const baseUrl = await waitForDaemon(child);
    const html = await fetch(baseUrl).then((res) => res.text());
    assert.match(html, /Agent SDLC Mission Control/);

    const health = await fetch(`${baseUrl}/api/health`).then((res) => res.json());
    assert.equal(health.ok, true);
    assert.ok(health.runs.includes('run-1'));

    const runs = await fetch(`${baseUrl}/api/runs`).then((res) => res.json());
    assert.equal(runs.runs[0].runId, 'run-1');
    assert.equal(runs.runs[0].state, 'waiting_execution_approval');

    const executed = await fetch(`${baseUrl}/api/runs/run-1/actions/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetFile: 'src/main/resources/application.yml', setKey: 'feature.enabled', setValue: 'true' }),
    }).then((res) => res.json());
    assert.equal(executed.action, 'execute');
    assert.equal(executed.state.state, 'waiting_pr_approval');

    const preview = await fetch(`${baseUrl}/api/runs/run-1/actions/pr-preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }).then((res) => res.json());
    assert.equal(preview.action, 'pr-preview');

    const status = await fetch(`${baseUrl}/api/runs/run-1/status`).then((res) => res.json());
    assert.equal(status.validation.ok, true);
    assert.ok(status.artifacts.some((artifact) => artifact.name === 'diff.patch' && artifact.present));

    const diff = await fetch(`${baseUrl}/api/runs/run-1/artifacts/diff.patch`).then((res) => res.text());
    assert.match(diff, /feature:/);

    const approval = await fetch(`${baseUrl}/api/runs/run-1/approvals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gate: 'pr_creation', status: 'approved', actor: 'tester' }),
    }).then((res) => res.json());
    assert.equal(approval.status, 'approved');

    const audit = await fetch(`${baseUrl}/api/runs/run-1/actions/audit-report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }).then((res) => res.json());
    assert.equal(audit.action, 'audit-report');
    assert.equal(audit.state.artifacts.find((artifact) => artifact.name === 'audit-report.md').present, true);

    const prRequest = await fetch(`${baseUrl}/api/runs/run-1/actions/create-pr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectKey: 'ABC', repoSlug: 'service-a', reviewers: ['alice'] }),
    }).then((res) => res.json());
    assert.equal(prRequest.action, 'create-pr');
    assert.equal(prRequest.result.projectKey, 'ABC');

    const updated = await fetch(`${baseUrl}/api/runs/run-1/status`).then((res) => res.json());
    assert.ok(updated.gates.approved.includes('pr_creation'));
    assert.ok(updated.artifacts.some((artifact) => artifact.name === 'stash-create-pr-request.json' && artifact.present));
  } finally {
    child.kill('SIGTERM');
  }
});
