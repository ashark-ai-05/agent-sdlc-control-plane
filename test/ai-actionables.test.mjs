import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const repoRoot = new URL('../', import.meta.url);

async function readRepoFile(path) {
  return readFile(new URL(path, repoRoot), 'utf8');
}

test('agentic control-plane diagram captures inputs, runtime, controls, outputs and metrics', async () => {
  const doc = await readRepoFile('docs/AGENTIC_SDLC_CONTROL_PLANE.md');

  for (const expected of [
    'SDLC inputs',
    'Context pack',
    'Agent runtime',
    'Governance controls',
    'Agent outputs',
    'Operating metrics',
    'CI/CD-native execution',
  ]) {
    assert.match(doc, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('CI failure explainer workflow prototype uses GITHUB_TOKEN-compatible permissions and mock provider', async () => {
  const workflow = await readRepoFile('docs/prototypes/agentic-ci-failure-explainer.yml');

  assert.match(workflow, /permissions:/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /actions: read/);
  assert.match(workflow, /pull-requests: write/);
  assert.match(workflow, /agent-adapter mock-agent/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.doesNotMatch(workflow, /PAT|PERSONAL_ACCESS_TOKEN/);
});

test('blog thesis and side-hustle scan preserve actionable product framing', async () => {
  const blog = await readRepoFile('docs/blog-agentic-sdlc-control-plane.md');
  const scan = await readRepoFile('docs/side-hustle-agent-risk-gate.md');

  assert.match(blog, /control-plane problem, not a chatbot problem/i);
  assert.match(blog, /GitHub Agentic Workflows/);
  assert.match(scan, /Agent Risk Gate/);
  assert.match(scan, /shell\/file\/network\/git actions/);
  assert.match(scan, /YAML policy/);
});
