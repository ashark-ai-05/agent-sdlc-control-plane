import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { appendJsonl } from '../core/io.mjs';
import { approvals, approvedGates } from '../core/approvals.mjs';
import { die, loadRun } from '../core/run-context.mjs';

export function approvalCommand(args, action) {
  const repo = resolve(String(args.repo || ''));
  const runId = String(args.run || '');
  if (!repo || !existsSync(repo)) die('--repo must point to an existing repository');
  if (!runId) die('--run is required');

  const { root, runDir, approvalPath, eventsPath } = loadRun(repo, runId);
  const validGates = ['context_pack', 'requirement', 'implementation_plan', 'execution', 'pr_creation', 'enterprise_update'];

  if (action === 'list') {
    const records = approvals(approvalPath);
    const latest = new Map();
    for (const record of records) {
      if (record.gate) latest.set(record.gate, record);
    }
    const payload = {
      runId,
      repo: root,
      approvalPath,
      approvals: records,
      latestByGate: Object.fromEntries(latest),
      approvedGates: approvedGates(approvalPath),
    };
    if (args.json) console.log(JSON.stringify(payload, null, 2));
    else {
      console.log(`Run: ${runId}`);
      console.log(`Approvals file: ${approvalPath}`);
      if (!records.length) console.log('No approval records.');
      for (const record of records) {
        console.log(`${record.timestamp || '-'}  ${record.gate || '-'}  ${record.status || '-'}  actor=${record.actor || '-'}${record.reason ? `  reason=${record.reason}` : ''}`);
      }
    }
    return;
  }

  const gate = String(args.gate || '');
  if (!gate) die('--gate is required');
  if (!validGates.includes(gate)) die(`--gate must be one of: ${validGates.join(', ')}`);

  if (action === 'approve') {
    const actor = String(args.actor || process.env.USER || 'unknown');
    const record = { gate, status: 'approved', actor, reason: args.reason ? String(args.reason) : undefined };
    appendJsonl(approvalPath, record);
    appendJsonl(eventsPath, { type: 'approval_recorded', gate, status: 'approved', actor });
    console.log(JSON.stringify({ runId, repo: root, gate, status: 'approved', actor, approvalPath }, null, 2));
    return;
  }

  if (action === 'reject') {
    const actor = String(args.actor || process.env.USER || 'unknown');
    const reason = String(args.reason || 'rejected');
    const record = { gate, status: 'rejected', actor, reason };
    appendJsonl(approvalPath, record);
    appendJsonl(eventsPath, { type: 'approval_recorded', gate, status: 'rejected', actor, reason });
    console.log(JSON.stringify({ runId, repo: root, gate, status: 'rejected', actor, reason, approvalPath }, null, 2));
    return;
  }

  die(`unknown approval action: ${action}`);
}
