import { join } from 'node:path';
import { readJson } from './io.mjs';

export function defaultPolicy() {
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

export function loadPolicy(root) {
  const policyPath = join(root, '.agentic-sdlc', 'policy.json');
  return { ...defaultPolicy(), ...(readJson(policyPath, {}) || {}) };
}

export function isProtectedBranch(branch, policy = defaultPolicy()) {
  return (policy.protectedBranches || ['main', 'master']).includes(String(branch || '').trim());
}

export function validatePolicyShape(policy) {
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
