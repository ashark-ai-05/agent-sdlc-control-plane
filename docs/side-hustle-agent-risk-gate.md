# Side-hustle scan: Agent Risk Gate

## One-liner

**Agent Risk Gate** is a lightweight policy and audit layer for coding agents, MCP tools, and CI agent workflows. It classifies proposed shell/file/network/git actions before execution, applies team policy, and emits an audit report.

## Why now

Agentic workflows are moving into CI/CD and local development environments. That puts agents near:

- source code
- secrets and environment variables
- package managers
- git remotes
- MCP tools
- deployment scripts
- production-like data

Enterprises will not accept “trust the agent”. They need a small control layer that answers: what action was proposed, why was it allowed, what policy applied, and what evidence was retained?

## Target users

- small engineering teams adopting Cursor, Copilot, Codex, Amp, Claude Code, or local agents
- security-conscious teams experimenting with MCP servers
- platform teams creating internal agentic workflows
- consultants/pilots that need a quick governance story before wider rollout

## MVP scope

### Inputs

- proposed command or tool call
- working directory/repo metadata
- changed file paths
- environment risk hints, without exposing secret values
- YAML policy file

### Classifier categories

- safe read-only
- local write
- dependency/package-manager change
- git mutation
- network access
- secret-adjacent action
- destructive file operation
- deployment/prod-adjacent action
- unknown / requires human review

### Policy format

```yaml
version: 1
rules:
  - match:
      category: safe_read_only
    action: allow
  - match:
      category: destructive_file_operation
    action: block
  - match:
      category: git_mutation
      branch: main
    action: block
  - match:
      category: network_access
    action: review
```

### Outputs

- allow/block/review decision
- human-readable reason
- matched policy rule
- risk score
- suggested safer alternative
- JSONL audit event
- Markdown run report

## GitHub Action wedge

Package the MVP as a GitHub Action that can sit before an agent workflow step:

```yaml
- name: Agent risk gate
  uses: ashark-ai-05/agent-risk-gate@v0
  with:
    proposed-action-file: .agentic-sdlc/proposed-action.json
    policy-file: .agentic-sdlc/agent-risk-policy.yaml
```

## Local CLI wedge

```bash
agent-risk-gate check \
  --repo . \
  --policy .agentic-sdlc/agent-risk-policy.yaml \
  --command "rm -rf dist && npm install"
```

## Differentiation

- not another agent runtime
- provider-neutral
- easy to adopt in CI or local hooks
- works with MCP/coding agents rather than replacing them
- produces artifacts security/platform teams understand

## Monetization paths

1. Open-source CLI + paid hosted policy templates and dashboards.
2. Enterprise package with SOC2-friendly audit retention and SSO.
3. Consulting/pilot wedge for teams adopting Agentic SDLC.
4. Marketplace GitHub Action with paid private-policy packs.

## Risks

- classifier quality must be high enough to avoid both false confidence and noisy blocks
- needs integrations with real agent outputs, not imaginary schemas
- should avoid collecting secrets or sensitive code
- must be clear that it reduces risk; it does not prove safety

## Next validation step

Build a tiny static classifier first:

- parse command strings
- classify obvious categories
- apply YAML rules
- write JSONL + Markdown report
- integrate with one GitHub Action workflow

Only add LLM-based/context-aware classification after the deterministic baseline is useful.
