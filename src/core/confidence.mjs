export function chooseValidationCommands(contextPack, manifest) {
  const candidates = [
    ...(Array.isArray(manifest.validationCommands) ? manifest.validationCommands : []),
    ...(Array.isArray(contextPack.validationCommands) ? contextPack.validationCommands : []),
    ...(contextPack.build?.mavenCommand ? [contextPack.build.mavenCommand] : []),
    ...(manifest.mavenCommand ? [manifest.mavenCommand] : []),
  ];
  const deduped = [...new Set(candidates.filter(Boolean))];
  return deduped.length ? deduped : ['mvn test'];
}

export function scoreConfidence({ contextPack, validationSummary, changedFiles }) {
  const contextSufficiency = Number(contextPack.contextSufficiencyScore ?? contextPack.contextSufficiency ?? 0.6);
  const requirementCoverage = 0.75;
  const validationScore = validationSummary.ok ? 1 : 0;
  const changedFilesRiskScore = changedFiles.length === 1 ? 0.9 : changedFiles.length <= 3 ? 0.75 : 0.45;
  const reviewerScore = 0.7;
  const unknowns = Array.isArray(contextPack.unknowns) ? contextPack.unknowns.length : 2;
  const assumptionsScore = Math.max(0.35, 1 - unknowns * 0.1);
  const inputs = { contextSufficiency, requirementCoverage, validationScore, changedFilesRiskScore, reviewerScore, assumptionsScore };
  const overallConfidence = Number((
    contextSufficiency * 0.20 +
    requirementCoverage * 0.20 +
    validationScore * 0.25 +
    0.8 * 0.10 +
    reviewerScore * 0.10 +
    changedFilesRiskScore * 0.10 +
    assumptionsScore * 0.05
  ).toFixed(2));
  const rating = overallConfidence >= 0.85 ? 'high' : overallConfidence >= 0.7 ? 'medium-high' : overallConfidence >= 0.5 ? 'medium' : 'low';
  const riskFactors = ['mock reviewer score used'];
  if (!validationSummary.ok) riskFactors.push('validation command failed');
  if (unknowns > 0) riskFactors.push(`${unknowns} unresolved unknown(s) in context pack`);
  if (changedFiles.length !== 1) riskFactors.push(`${changedFiles.length} changed files detected`);
  return {
    overallConfidence,
    rating,
    inputs,
    riskFactors,
    recommendedHumanReviewFocus: [
      'verify config key semantics',
      'confirm module-specific validation is sufficient',
      'inspect diff.patch before PR creation approval',
    ],
  };
}
