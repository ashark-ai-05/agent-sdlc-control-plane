export const adapterPhases = Object.freeze([
  'interpret_requirement',
  'create_task_breakdown',
  'create_implementation_plan',
  'execute_approved_plan',
  'review_changes',
  'generate_update_previews',
]);

export function assertAdapterPhase(phase) {
  if (!adapterPhases.includes(phase)) {
    throw new Error(`unsupported adapter phase: ${phase}`);
  }
}

export function adapterContract(provider, capabilities = []) {
  return {
    provider,
    contractVersion: '0.1.0',
    phases: adapterPhases,
    capabilities,
  };
}
