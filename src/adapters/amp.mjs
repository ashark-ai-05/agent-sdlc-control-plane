import { relative, resolve } from 'node:path';
import { applyConfigChange, validateConfigFile } from '../core/config.mjs';
import { adapterContract } from './types.mjs';

function providerRequest({ phase, runId, prompt, schema }) {
  return {
    provider: 'amp',
    phase,
    runId,
    mode: 'request_artifact_only',
    command: 'amp',
    prompt,
    expectedSchema: schema,
    externalCallExecuted: false,
    note: 'Amp provider invocation is intentionally not executed by this skeleton; the control plane records the phase request and keeps local safety gates/artifacts authoritative.',
  };
}

function audit({ localWrite = false } = {}) {
  return {
    deterministic: true,
    providerInvocationExecuted: false,
    controlledLocalWrite: localWrite,
    arbitraryCodeExecution: false,
    externalWrites: false,
  };
}

export function createAmpAdapter() {
  const contract = adapterContract('amp', ['provider_request_artifacts', 'safe_local_config_change']);
  return {
    ...contract,
    interpretRequirement({ requirement, runId, manifest = {}, contextPack = {} }) {
      const intent = String(requirement || '').trim();
      if (!intent) throw new Error('--requirement is required');
      const request = providerRequest({
        phase: 'interpret_requirement',
        runId,
        prompt: `Interpret this enterprise SDLC requirement for a controlled local workflow:\n\n${intent}`,
        schema: 'interpreted-requirement-v1',
      });
      return {
        provider: contract.provider,
        contractVersion: contract.contractVersion,
        phase: 'interpret_requirement',
        capabilities: contract.capabilities,
        runId,
        intent,
        workflowType: manifest.workflowType || contextPack.workflowType || 'feature_config_change',
        summary: intent,
        constraints: [
          'amp adapter skeleton records provider request artifacts only',
          'no Amp SDK/CLI call is executed in skeleton mode',
          'human approval required before planning or execution in normal workflow mode',
        ],
        assumptions: Array.isArray(contextPack.assumptions) ? contextPack.assumptions : [],
        unknowns: Array.isArray(contextPack.unknowns) ? contextPack.unknowns : [],
        providerRequest: request,
        audit: audit(),
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
            title: `Ask Amp to reason about impacted files for: ${intent}`,
            type: 'provider_planning_request',
            risk: 'low',
          },
          {
            id: 'task-2',
            title: 'Keep execution constrained to explicit target-file, set-key, and set-value until live Amp writes are enabled',
            type: 'control_plane_safety',
            risk: 'low',
          },
        ],
        providerRequest: providerRequest({
          phase: 'create_task_breakdown',
          runId,
          prompt: `Create a task breakdown for this requirement without writing files:\n\n${intent}`,
          schema: 'task-breakdown-v1',
        }),
        audit: audit(),
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
        summary: `Amp skeleton implementation plan request for: ${intent}`,
        steps: [
          'Record the Amp planning prompt and expected output schema as an audit artifact.',
          'Require explicit target-file, set-key, and set-value for the safe local execution slice.',
          'Apply only the deterministic control-plane config change until live Amp execution is configured.',
          'Capture diff, validation, confidence, and review artifacts before PR creation.',
        ],
        tasks: Array.isArray(taskBreakdown.tasks) ? taskBreakdown.tasks.map((task) => task.id) : [],
        requiredApprovals: ['implementation_plan', 'execution', 'pr_creation'],
        providerRequest: providerRequest({
          phase: 'create_implementation_plan',
          runId,
          prompt: `Create an implementation plan for this requirement without writing files:\n\n${intent}`,
          schema: 'implementation-plan-v1',
        }),
        audit: audit(),
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
          'Amp review request recorded but not sent in skeleton mode',
          changedFiles.length === 1 ? 'single-file change detected' : `${changedFiles.length} changed files detected`,
          diff ? 'diff artifact available for future Amp/human review' : 'diff artifact missing or empty',
        ],
        humanReviewFocus: confidence.recommendedHumanReviewFocus || ['inspect diff.patch before PR approval'],
        providerRequest: providerRequest({
          phase: 'review_changes',
          runId,
          prompt: `Review this change set and validation evidence without creating external writes. Changed files: ${changedFiles.join(', ') || 'none'}`,
          schema: 'change-review-v1',
        }),
        audit: audit(),
      };
    },
    generateUpdatePreviews({ runId, prTitle = '', changedFiles = [] }) {
      return {
        provider: contract.provider,
        contractVersion: contract.contractVersion,
        phase: 'generate_update_previews',
        capabilities: contract.capabilities,
        runId,
        summary: prTitle || `Amp skeleton update preview for ${runId}`,
        changedFiles,
        providerRequest: providerRequest({
          phase: 'generate_update_previews',
          runId,
          prompt: `Generate Jira and Confluence update preview text for ${runId}. Changed files: ${changedFiles.join(', ') || 'none'}`,
          schema: 'enterprise-update-preview-v1',
        }),
        audit: audit(),
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
        providerRequest: providerRequest({
          phase: 'execute_approved_plan',
          runId,
          prompt: `Execute approved plan for ${relativeTarget} by setting ${setKey}. Live Amp execution is disabled; control plane performed deterministic local config write instead.`,
          schema: 'execution-result-v1',
        }),
        audit: audit({ localWrite: true }),
      };
    },
  };
}
