import { spawnSync } from 'node:child_process';

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
  return {
    provider: 'amp',
    command,
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
