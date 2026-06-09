import { spawnSync } from 'node:child_process';

const MAX_CAPTURE_CHARS = 20000;

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function firstBoolean(...values) {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'on', 'live'].includes(normalized)) return true;
      if (['false', '0', 'no', 'off', 'skeleton'].includes(normalized)) return false;
    }
  }
  return false;
}

function firstArray(...values) {
  for (const value of values) {
    if (Array.isArray(value)) return value.map(String);
    if (typeof value === 'string' && value.trim()) return value.trim().split(/\s+/);
  }
  return [];
}

function truncate(value) {
  const text = String(value || '');
  return text.length > MAX_CAPTURE_CHARS ? `${text.slice(0, MAX_CAPTURE_CHARS)}\n...[truncated]` : text;
}

function parseJsonObject(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {}
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } catch {}
  }
  return null;
}

export function normalizeInterpretedRequirement(parsed, fallbackIntent) {
  if (!parsed || typeof parsed !== 'object') return null;
  const intent = firstString(parsed.intent, parsed.requirement, parsed.summary, fallbackIntent);
  if (!intent) return null;
  return {
    intent,
    summary: firstString(parsed.summary, intent),
    workflowType: firstString(parsed.workflowType, parsed.workflow_type, 'feature_config_change'),
    constraints: Array.isArray(parsed.constraints) ? parsed.constraints.map(String) : [],
    assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions.map(String) : [],
    unknowns: Array.isArray(parsed.unknowns) ? parsed.unknowns.map(String) : [],
  };
}

export function normalizeTaskBreakdown(parsed) {
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.tasks)) return null;
  const tasks = parsed.tasks.map((task, index) => ({
    id: firstString(task.id, `task-${index + 1}`),
    title: firstString(task.title, task.summary, `Task ${index + 1}`),
    type: firstString(task.type, 'provider_planning_request'),
    risk: firstString(task.risk, 'medium'),
  })).filter((task) => task.title);
  if (!tasks.length) return null;
  return { tasks };
}

export function normalizeImplementationPlan(parsed, fallbackSummary = 'Amp implementation plan') {
  if (!parsed || typeof parsed !== 'object') return null;
  const steps = Array.isArray(parsed.steps) ? parsed.steps.map(String).filter(Boolean) : [];
  if (!steps.length) return null;
  const requiredApprovals = Array.isArray(parsed.requiredApprovals)
    ? parsed.requiredApprovals.map(String)
    : ['implementation_plan', 'execution', 'pr_creation'];
  return {
    summary: firstString(parsed.summary, fallbackSummary),
    steps,
    tasks: Array.isArray(parsed.tasks) ? parsed.tasks.map(String) : [],
    requiredApprovals,
  };
}

export function normalizeChangeReview(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const recommendation = firstString(parsed.recommendation, 'approve_with_human_review');
  const findings = Array.isArray(parsed.findings) ? parsed.findings.map(String).filter(Boolean) : [];
  const humanReviewFocus = Array.isArray(parsed.humanReviewFocus) ? parsed.humanReviewFocus.map(String).filter(Boolean) : [];
  if (!findings.length && !humanReviewFocus.length) return null;
  return {
    recommendation,
    findings,
    humanReviewFocus,
    riskAssessment: firstString(parsed.riskAssessment, parsed.risk, 'not_provided'),
  };
}

export function normalizeExecutionProposal(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  return {
    targetFile: firstString(parsed.targetFile, parsed.target_file),
    setKey: firstString(parsed.setKey, parsed.set_key),
    setValue: firstString(parsed.setValue, parsed.set_value),
    notes: Array.isArray(parsed.notes) ? parsed.notes.map(String) : [],
  };
}

export function normalizeUpdatePreviews(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const summary = firstString(parsed.summary, 'Amp update preview');
  const jiraBody = firstString(parsed.jiraBody, parsed.jira?.body);
  const confluenceBody = firstString(parsed.confluenceBody, parsed.confluence?.body);
  if (!jiraBody && !confluenceBody) return null;
  return { summary, jiraBody, confluenceBody };
}

export function ampConfigFrom({ manifest = {}, contextPack = {}, env = process.env } = {}) {
  const manifestAmp = manifest.amp || manifest.providers?.amp || {};
  const contextAmp = contextPack.amp || contextPack.providers?.amp || {};
  const command = firstString(env.AGENT_SDLC_AMP_COMMAND, manifestAmp.command, contextAmp.command, 'amp');
  const liveInvocationRequested = firstBoolean(
    env.AGENT_SDLC_AMP_LIVE,
    manifestAmp.liveInvocationEnabled,
    contextAmp.liveInvocationEnabled,
  );
  const allowNetwork = firstBoolean(
    env.AGENT_SDLC_AMP_ALLOW_NETWORK,
    manifestAmp.allowNetwork,
    contextAmp.allowNetwork,
  );
  const model = firstString(env.AGENT_SDLC_AMP_MODEL, manifestAmp.model, contextAmp.model);
  const apiKeyEnv = firstString(manifestAmp.apiKeyEnv, contextAmp.apiKeyEnv, 'AMP_API_KEY');
  const interpretArgs = firstArray(env.AGENT_SDLC_AMP_INTERPRET_ARGS, manifestAmp.interpretArgs, contextAmp.interpretArgs);
  const planArgs = firstArray(env.AGENT_SDLC_AMP_PLAN_ARGS, manifestAmp.planArgs, contextAmp.planArgs, interpretArgs);
  const reviewArgs = firstArray(env.AGENT_SDLC_AMP_REVIEW_ARGS, manifestAmp.reviewArgs, contextAmp.reviewArgs, planArgs);
  const executionArgs = firstArray(env.AGENT_SDLC_AMP_EXECUTION_ARGS, manifestAmp.executionArgs, contextAmp.executionArgs, reviewArgs);
  const updateArgs = firstArray(env.AGENT_SDLC_AMP_UPDATE_ARGS, manifestAmp.updateArgs, contextAmp.updateArgs, reviewArgs);
  const timeoutMs = Number(firstString(env.AGENT_SDLC_AMP_TIMEOUT_MS, manifestAmp.timeoutMs, contextAmp.timeoutMs, '30000'));
  return {
    provider: 'amp',
    command,
    interpretArgs,
    planArgs,
    reviewArgs,
    executionArgs,
    updateArgs,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000,
    mode: liveInvocationRequested ? 'live_requested' : 'request_artifact_only',
    liveInvocationRequested,
    allowNetwork,
    model: model || null,
    apiKeyEnv,
    apiKeyPresent: Boolean(env[apiKeyEnv]),
    env: {
      live: 'AGENT_SDLC_AMP_LIVE',
      command: 'AGENT_SDLC_AMP_COMMAND',
      allowNetwork: 'AGENT_SDLC_AMP_ALLOW_NETWORK',
      model: 'AGENT_SDLC_AMP_MODEL',
      interpretArgs: 'AGENT_SDLC_AMP_INTERPRET_ARGS',
      planArgs: 'AGENT_SDLC_AMP_PLAN_ARGS',
      reviewArgs: 'AGENT_SDLC_AMP_REVIEW_ARGS',
      executionArgs: 'AGENT_SDLC_AMP_EXECUTION_ARGS',
      updateArgs: 'AGENT_SDLC_AMP_UPDATE_ARGS',
      timeoutMs: 'AGENT_SDLC_AMP_TIMEOUT_MS',
      apiKey: apiKeyEnv,
    },
  };
}

export function commandAvailable(command) {
  const result = spawnSync('sh', ['-c', 'command -v "$1"', 'sh', command], {
    encoding: 'utf8',
  });
  return {
    ok: result.status === 0,
    path: result.status === 0 ? result.stdout.trim() : null,
    status: result.status,
  };
}

export function checkAmpReadiness({ manifest = {}, contextPack = {}, env = process.env } = {}) {
  const config = ampConfigFrom({ manifest, contextPack, env });
  const availability = commandAvailable(config.command);
  const blockers = [];
  const warnings = [];

  if (!config.liveInvocationRequested) {
    warnings.push('live Amp invocation is not requested; adapter will stay in request-artifact-only mode');
  }
  if (!availability.ok) {
    blockers.push(`Amp command not found: ${config.command}`);
  }
  if (config.liveInvocationRequested && !config.allowNetwork) {
    blockers.push('live invocation requested but AGENT_SDLC_AMP_ALLOW_NETWORK/provider allowNetwork is not enabled');
  }
  if (config.liveInvocationRequested && !config.apiKeyPresent) {
    warnings.push(`API key env var ${config.apiKeyEnv} is not present; CLI-based auth may still work if Amp is already authenticated`);
  }

  return {
    provider: 'amp',
    ok: blockers.length === 0,
    liveInvocationReady: config.liveInvocationRequested && blockers.length === 0,
    config,
    command: {
      name: config.command,
      available: availability.ok,
      path: availability.path,
    },
    blockers,
    warnings,
    safeDefault: {
      requestArtifactOnly: !config.liveInvocationRequested,
      externalCallExecuted: false,
      credentialsLogged: false,
    },
  };
}

function runAmpJsonPhase({ prompt, manifest = {}, contextPack = {}, env = process.env, argsKey = 'interpretArgs' }) {
  const readiness = checkAmpReadiness({ manifest, contextPack, env });
  if (!readiness.liveInvocationReady) {
    return {
      executed: false,
      reason: 'readiness_failed',
      readiness,
      parsed: null,
    };
  }

  const startedAt = new Date().toISOString();
  const args = readiness.config[argsKey] || [];
  const result = spawnSync(readiness.config.command, args, {
    input: prompt,
    encoding: 'utf8',
    timeout: readiness.config.timeoutMs,
    env,
    maxBuffer: MAX_CAPTURE_CHARS * 4,
  });
  const completedAt = new Date().toISOString();
  const stdout = truncate(result.stdout);
  const stderr = truncate(result.stderr);
  const parsed = parseJsonObject(stdout);

  return {
    executed: true,
    provider: 'amp',
    command: readiness.config.command,
    args,
    status: result.status,
    signal: result.signal || null,
    error: result.error ? result.error.message : null,
    startedAt,
    completedAt,
    stdout,
    stderr,
    parsed,
    readiness,
  };
}

export function invokeAmpInterpretRequirement({ prompt, requirement, manifest = {}, contextPack = {}, env = process.env } = {}) {
  const result = runAmpJsonPhase({ prompt, manifest, contextPack, env, argsKey: 'interpretArgs' });
  if (!result.executed) {
    return {
      ...result,
      interpretedRequirement: null,
    };
  }
  const interpretedRequirement = normalizeInterpretedRequirement(result.parsed, requirement);

  return {
    ...result,
    ok: result.status === 0 && Boolean(interpretedRequirement),
    interpretedRequirement,
  };
}

export function invokeAmpTaskBreakdown({ prompt, manifest = {}, contextPack = {}, env = process.env } = {}) {
  const result = runAmpJsonPhase({ prompt, manifest, contextPack, env, argsKey: 'planArgs' });
  if (!result.executed) {
    return {
      ...result,
      taskBreakdown: null,
    };
  }
  const taskBreakdown = normalizeTaskBreakdown(result.parsed);
  return {
    ...result,
    ok: result.status === 0 && Boolean(taskBreakdown),
    taskBreakdown,
  };
}

export function invokeAmpImplementationPlan({ prompt, fallbackSummary, manifest = {}, contextPack = {}, env = process.env } = {}) {
  const result = runAmpJsonPhase({ prompt, manifest, contextPack, env, argsKey: 'planArgs' });
  if (!result.executed) {
    return {
      ...result,
      implementationPlan: null,
    };
  }
  const implementationPlan = normalizeImplementationPlan(result.parsed, fallbackSummary);
  return {
    ...result,
    ok: result.status === 0 && Boolean(implementationPlan),
    implementationPlan,
  };
}

export function invokeAmpChangeReview({ prompt, manifest = {}, contextPack = {}, env = process.env } = {}) {
  const result = runAmpJsonPhase({ prompt, manifest, contextPack, env, argsKey: 'reviewArgs' });
  if (!result.executed) {
    return {
      ...result,
      changeReview: null,
    };
  }
  const changeReview = normalizeChangeReview(result.parsed);
  return {
    ...result,
    ok: result.status === 0 && Boolean(changeReview),
    changeReview,
  };
}

export function invokeAmpExecutionProposal({ prompt, manifest = {}, contextPack = {}, env = process.env } = {}) {
  const result = runAmpJsonPhase({ prompt, manifest, contextPack, env, argsKey: 'executionArgs' });
  if (!result.executed) {
    return {
      ...result,
      executionProposal: null,
    };
  }
  const executionProposal = normalizeExecutionProposal(result.parsed);
  return {
    ...result,
    ok: result.status === 0 && Boolean(executionProposal),
    executionProposal,
  };
}

export function invokeAmpUpdatePreviews({ prompt, manifest = {}, contextPack = {}, env = process.env } = {}) {
  const result = runAmpJsonPhase({ prompt, manifest, contextPack, env, argsKey: 'updateArgs' });
  if (!result.executed) {
    return {
      ...result,
      updatePreviews: null,
    };
  }
  const updatePreviews = normalizeUpdatePreviews(result.parsed);
  return {
    ...result,
    ok: result.status === 0 && Boolean(updatePreviews),
    updatePreviews,
  };
}
