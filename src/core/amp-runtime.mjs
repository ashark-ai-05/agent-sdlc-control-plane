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
  const timeoutMs = Number(firstString(env.AGENT_SDLC_AMP_TIMEOUT_MS, manifestAmp.timeoutMs, contextAmp.timeoutMs, '30000'));
  return {
    provider: 'amp',
    command,
    interpretArgs,
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

export function invokeAmpInterpretRequirement({ prompt, requirement, manifest = {}, contextPack = {}, env = process.env } = {}) {
  const readiness = checkAmpReadiness({ manifest, contextPack, env });
  if (!readiness.liveInvocationReady) {
    return {
      executed: false,
      reason: 'readiness_failed',
      readiness,
      parsed: null,
      interpretedRequirement: null,
    };
  }

  const startedAt = new Date().toISOString();
  const result = spawnSync(readiness.config.command, readiness.config.interpretArgs, {
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
  const interpretedRequirement = normalizeInterpretedRequirement(parsed, requirement);

  return {
    executed: true,
    provider: 'amp',
    command: readiness.config.command,
    args: readiness.config.interpretArgs,
    status: result.status,
    signal: result.signal || null,
    error: result.error ? result.error.message : null,
    ok: result.status === 0 && Boolean(interpretedRequirement),
    startedAt,
    completedAt,
    stdout,
    stderr,
    parsed,
    interpretedRequirement,
    readiness,
  };
}
