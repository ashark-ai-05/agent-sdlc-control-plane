import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, relative, resolve } from 'node:path';
import { URL } from 'node:url';
import { appendJsonl, writeJson } from '../core/io.mjs';
import { git } from '../core/git.mjs';
import { buildRepoScan, resolveGitRoot } from '../core/repo.mjs';
import { listRunIds, loadRun } from '../core/run-context.mjs';
import { parseCsv } from '../core/text.mjs';
import { buildRunListPayload, buildRunStatusPayload } from '../commands/run.mjs';
import { missionControlHtml } from './mission-control-html.mjs';

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(text);
}

function readRequestJson(req) {
  return new Promise((resolveBody, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) reject(new Error('request body too large'));
    });
    req.on('end', () => {
      if (!body.trim()) resolveBody({});
      else {
        try { resolveBody(JSON.parse(body)); } catch (error) { reject(error); }
      }
    });
    req.on('error', reject);
  });
}

function runCliAction(root, runId, action, body = {}) {
  const baseArgs = ['--repo', root, '--run', runId];
  const actionArgs = {
    'interpret': ['feature', 'interpret', ...baseArgs, '--requirement', String(body.requirement || ''), '--agent-adapter', String(body.agentAdapter || body['agent-adapter'] || 'mock-agent')],
    'plan': ['feature', 'plan', ...baseArgs, '--agent-adapter', String(body.agentAdapter || body['agent-adapter'] || 'mock-agent')],
    'execute': ['feature', 'execute', ...baseArgs, '--target-file', String(body.targetFile || body['target-file'] || ''), '--set-key', String(body.setKey || body['set-key'] || ''), '--set-value', String(body.setValue ?? body['set-value'] ?? ''), '--mock-agent', '--auto-approve'],
    'review': ['feature', 'review', ...baseArgs, '--agent-adapter', String(body.agentAdapter || body['agent-adapter'] || 'mock-agent')],
    'pr-preview': ['feature', 'pr-preview', ...baseArgs],
    'audit-report': ['run', 'audit-report', ...baseArgs],
    'create-pr': ['feature', 'create-pr', ...baseArgs, '--provider', String(body.provider || 'stash'), '--project-key', String(body.projectKey || body['project-key'] || 'TBD_PROJECT'), '--repo-slug', String(body.repoSlug || body['repo-slug'] || 'TBD_REPO'), '--reviewers', parseCsv(body.reviewers).join(','), '--dry-run'],
    'enterprise-preview': ['feature', 'enterprise-preview', ...baseArgs, '--jira-key', String(body.jiraKey || body['jira-key'] || 'TBD-JIRA'), '--confluence-page-id', String(body.confluencePageId || body['confluence-page-id'] || 'TBD-CONFLUENCE-PAGE')],
    'apply-enterprise-updates': ['feature', 'apply-enterprise-updates', ...baseArgs, '--dry-run'],
  };
  const args = actionArgs[action];
  if (!args) return { ok: false, status: 400, payload: { error: `unsupported action: ${action}` } };
  if (body.allowFailedValidation || body['allow-failed-validation']) args.push('--allow-failed-validation');
  const result = spawnSync(process.execPath, [process.argv[1], ...args], { cwd: root, encoding: 'utf8' });
  let payload;
  try { payload = JSON.parse(result.stdout || '{}'); }
  catch { payload = { stdout: result.stdout }; }
  if (result.status !== 0) return { ok: false, status: 400, payload: { error: result.stderr || result.stdout || `action failed: ${action}`, action, exitStatus: result.status } };
  return { ok: true, status: 200, payload: { action, result: payload, state: buildRunStatusPayload(root, runId) } };
}

async function handleDaemonRequest(req, res, root) {
  const url = new URL(req.url, 'http://localhost');
  const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  try {
    if (req.method === 'GET' && url.pathname === '/') return sendText(res, 200, missionControlHtml(), 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, repo: root, currentBranch: git(root, ['branch', '--show-current']).stdout.trim(), runs: listRunIds(root) });
    }
    if (req.method === 'GET' && url.pathname === '/api/repo/scan') {
      const scan = buildRepoScan(root);
      const artifact = join(root, '.agentic-sdlc', 'repo-scan.json');
      writeJson(artifact, scan);
      return sendJson(res, 200, { ...scan, artifact });
    }
    if (req.method === 'GET' && url.pathname === '/api/runs') {
      return sendJson(res, 200, buildRunListPayload(root));
    }
    if (segments[0] === 'api' && segments[1] === 'runs' && segments[2]) {
      const runId = segments[2];
      const { runDir, approvalPath, eventsPath } = loadRun(root, runId);
      if (req.method === 'GET' && segments[3] === 'status') return sendJson(res, 200, buildRunStatusPayload(root, runId));
      if (req.method === 'GET' && segments[3] === 'artifacts' && segments[4]) {
        const artifactName = segments.slice(4).join('/');
        const artifactPath = resolve(runDir, artifactName);
        const rel = relative(runDir, artifactPath);
        if (rel.startsWith('..') || !existsSync(artifactPath)) return sendJson(res, 404, { error: 'artifact not found' });
        const contentType = artifactName.endsWith('.json') || artifactName.endsWith('.jsonl') ? 'application/json; charset=utf-8' : artifactName.endsWith('.md') ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8';
        return sendText(res, 200, readFileSync(artifactPath, 'utf8'), contentType);
      }
      if (req.method === 'POST' && segments[3] === 'actions' && segments[4]) {
        const body = await readRequestJson(req);
        const result = runCliAction(root, runId, segments[4], body);
        return sendJson(res, result.status, result.payload);
      }
      if (req.method === 'POST' && segments[3] === 'approvals') {
        const body = await readRequestJson(req);
        const gate = String(body.gate || '');
        const status = String(body.status || '');
        const actor = String(body.actor || 'mission-control');
        const reason = body.reason ? String(body.reason) : undefined;
        const validGates = ['context_pack', 'requirement', 'implementation_plan', 'execution', 'pr_creation', 'enterprise_update'];
        if (!validGates.includes(gate)) return sendJson(res, 400, { error: `invalid gate: ${gate}` });
        if (!['approved', 'rejected'].includes(status)) return sendJson(res, 400, { error: 'status must be approved or rejected' });
        appendJsonl(approvalPath, { gate, status, actor, reason });
        appendJsonl(eventsPath, { type: 'approval_recorded', gate, status, actor, reason, source: 'mission-control' });
        return sendJson(res, 200, { runId, gate, status, actor, approvalPath, state: buildRunStatusPayload(root, runId).state });
      }
    }
    return sendJson(res, 404, { error: 'not found' });
  } catch (error) {
    return sendJson(res, 500, { error: error.message, stack: process.env.AGENT_SDLC_DEBUG ? error.stack : undefined });
  }
}

export function daemonStart(args) {
  const root = resolveGitRoot(args.repo || '.');
  const port = Number(args.port || 4317);
  const host = String(args.host || '127.0.0.1');
  const server = createServer((req, res) => {
    handleDaemonRequest(req, res, root);
  });
  server.listen(port, host, () => {
    console.log(JSON.stringify({ state: 'daemon_started', repo: root, url: `http://${host}:${server.address().port}`, endpoints: ['/api/health', '/api/repo/scan', '/api/runs'] }, null, 2));
  });
}
