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
    createTaskBreakdown({ runId, interpretedRequirement = {} }) {
      const intent = interpretedRequirement.intent || interpretedRequirement.summary || 'Unspecified requirement';
      return {
        provider: contract.provider,
        contractVersion: contract.contractVersion,
        phase: 'create_task_breakdown',
        capabilities: contract.capabilities,
        runId,
        tasks: [
          {
            id: 'task-1',
            title: `Plan controlled implementation for: ${intent}`,
            type: 'planning',
            risk: 'low',
          },
          {
            id: 'task-2',
            title: 'Validate config change and capture evidence',
            type: 'validation',
            risk: 'low',
          },
        ],
        audit: {
          deterministic: true,
          arbitraryCodeExecution: false,
          externalWrites: false,
        },
      };
    },
    createImplementationPlan({ runId, interpretedRequirement = {}, taskBreakdown = {} }) {
      const intent = interpretedRequirement.intent || interpretedRequirement.summary || 'Unspecified requirement';
      return {
        provider: contract.provider,
        contractVersion: contract.contractVersion,
        phase: 'create_implementation_plan',
        capabilities: contract.capabilities,
        runId,
        summary: `Mock implementation plan for: ${intent}`,
        steps: [
          'Apply controlled config change using explicit target-file, set-key, and set-value arguments.',
          'Capture changed files and diff artifacts.',
          'Run configured validation commands and persist output.',
          'Compute confidence and require execution approval before file writes in non-demo mode.',
        ],
        tasks: Array.isArray(taskBreakdown.tasks) ? taskBreakdown.tasks.map((task) => task.id) : [],
        requiredApprovals: ['implementation_plan', 'execution', 'pr_creation'],
        audit: {
          deterministic: true,
          arbitraryCodeExecution: false,
          externalWrites: false,
        },
      };
    },
    reviewChanges({ runId, changedFiles = [], validationSummary = {}, confidence = {}, diff = '' }) {
      return {
        provider: contract.provider,
        contractVersion: contract.contractVersion,
        phase: 'review_changes',
        capabilities: contract.capabilities,
        runId,
        recommendation: validationSummary.ok === false ? 'request_changes' : 'approve_with_human_review',
        changedFiles,
        validationOk: validationSummary.ok ?? null,
        confidenceRating: confidence.rating || 'not_scored',
        findings: [
          changedFiles.length === 1 ? 'single-file change detected' : `${changedFiles.length} changed files detected`,
          diff ? 'diff artifact available for human review' : 'diff artifact missing or empty',
        ],
        humanReviewFocus: confidence.recommendedHumanReviewFocus || ['inspect diff.patch before PR approval'],
        audit: {
          deterministic: true,
          arbitraryCodeExecution: false,
          externalWrites: false,
        },
      };
    },
    generateUpdatePreviews({ runId, prTitle = '', changedFiles = [] }) {
      return {
        provider: contract.provider,
        contractVersion: contract.contractVersion,
        phase: 'generate_update_previews',
        capabilities: contract.capabilities,
        runId,
        summary: prTitle || `Agent SDLC update preview for ${runId}`,
        changedFiles,
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
