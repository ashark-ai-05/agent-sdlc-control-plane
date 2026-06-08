import { relative, resolve } from 'node:path';
import { applyConfigChange, validateConfigFile } from '../core/config.mjs';
import { adapterContract } from './types.mjs';

export function createMockAgentAdapter() {
  const contract = adapterContract('mock-agent', ['deterministic_config_change']);
  return {
    ...contract,
    interpretRequirement({ requirement, runId, manifest = {}, contextPack = {} }) {
      const intent = String(requirement || '').trim();
      if (!intent) throw new Error('--requirement is required');
      return {
        provider: contract.provider,
        contractVersion: contract.contractVersion,
        phase: 'interpret_requirement',
        capabilities: contract.capabilities,
        runId,
        intent,
        workflowType: manifest.workflowType || contextPack.workflowType || 'feature_config_change',
        summary: intent,
        constraints: ['local-only mock interpretation', 'human approval required before planning or execution'],
        assumptions: Array.isArray(contextPack.assumptions) ? contextPack.assumptions : [],
        unknowns: Array.isArray(contextPack.unknowns) ? contextPack.unknowns : [],
        audit: {
          deterministic: true,
          arbitraryCodeExecution: false,
          externalWrites: false,
        },
      };
    },
    executeApprovedPlan({ root, runId, targetFile, setKey, setValue }) {
      const absoluteTarget = resolve(root, targetFile);
      const relativeTarget = relative(root, absoluteTarget);
      if (relativeTarget.startsWith('..')) throw new Error('--target-file must stay inside repo');

      applyConfigChange(absoluteTarget, setKey, setValue, runId);
      const configValidation = validateConfigFile(absoluteTarget);
      configValidation.file = relativeTarget;

      return {
        provider: contract.provider,
        contractVersion: contract.contractVersion,
        phase: 'execute_approved_plan',
        capabilities: contract.capabilities,
        targetFile: relativeTarget,
        configValidation,
        audit: {
          deterministic: true,
          arbitraryCodeExecution: false,
          externalWrites: false,
        },
      };
    },
  };
}
