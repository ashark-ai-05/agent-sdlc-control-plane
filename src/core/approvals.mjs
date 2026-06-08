import { existsSync, readFileSync } from 'node:fs';

export function approvals(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function hasApproval(path, gate) {
  const record = [...approvals(path)].reverse().find((entry) => entry.gate === gate);
  return record?.status === 'approved';
}

export function approvedGates(path) {
  const latest = new Map();
  for (const entry of approvals(path)) {
    if (entry.gate) latest.set(entry.gate, entry);
  }
  return [...latest.values()].filter((entry) => entry.status === 'approved').map((entry) => entry.gate);
}
