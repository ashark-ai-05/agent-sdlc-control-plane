

export function firstLine(text, fallback) {
  const line = String(text || '').split('\n').map((value) => value.trim()).find(Boolean);
  return line || fallback;
}

export function bulletList(items, fallback = '- none') {
  if (!Array.isArray(items) || items.length === 0) return fallback;
  return items.map((item) => `- ${item}`).join('\n');
}

export function fileListFromChangedFiles(changedFilesArtifact) {
  if (Array.isArray(changedFilesArtifact)) return changedFilesArtifact;
  if (Array.isArray(changedFilesArtifact?.changedFiles)) return changedFilesArtifact.changedFiles;
  return [];
}

export function validationLines(validationSummary) {
  const commands = Array.isArray(validationSummary?.commands) ? validationSummary.commands : [];
  if (!commands.length) return '- validation not run or summary unavailable';
  return commands.map((cmd) => `- ${cmd.ok ? 'PASS' : 'FAIL'}: \`${cmd.command}\` (exit ${cmd.status})`).join('\n');
}

export function parseCsv(value) {
  if (Array.isArray(value)) return value;
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}
