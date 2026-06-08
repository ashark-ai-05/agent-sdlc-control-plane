# Architecture

This repository is a local-first Agentic SDLC workflow control plane.

Open the visual architecture diagram in a browser:

```bash
open docs/architecture.html
```

Or on Linux:

```bash
xdg-open docs/architecture.html
```

## High-level architecture

```text
CLI / Mission Control UI
        ↓
Local Daemon API
        ↓
Workflow Orchestrator + Run State Machine
        ↓
Policy + Approval Gates
        ↓
Repo Layer + Validation + Confidence Scoring
        ↓
Repo-local .agentic-sdlc/ artifacts
        ↓
Dry-run provider request artifacts
```

## Core principle

The platform is not “an agent that does everything.” It is a workflow control plane around replaceable agent execution providers.

```text
request
  → context pack
  → interpreted requirement
  → task breakdown
  → implementation plan
  → approval
  → controlled execution
  → validation
  → confidence scoring
  → PR preview / request
  → enterprise update preview / request
  → audit report
```

## Current implemented layers

### CLI

Main entrypoint:

```text
bin/agent-sdlc.mjs
```

Implements repo scan, config validation, policy validation, run initialization, approvals, controlled execution, PR preview, PR request dry-run, enterprise previews, audit report, and local daemon startup.

### Local daemon and mission-control UI

Start with:

```bash
node ./bin/agent-sdlc.mjs daemon start --repo /path/to/repo --port 4317
```

Open:

```text
http://127.0.0.1:4317
```

The daemon is local-only by default and exposes safe workflow endpoints.

### Repo-local storage

All run artifacts live under:

```text
.agentic-sdlc/
```

This directory is intended to be ignored in real target repositories unless the team intentionally wants to share run artifacts.

### Approval gates

Current gate names:

```text
implementation_plan
execution
pr_creation
enterprise_update
```

Approval records are append-only JSONL:

```text
.agentic-sdlc/runs/<run-id>/approvals.jsonl
```

Latest record wins per gate.

### Validation and confidence

The platform validates config shape, runs detected validation commands, captures output, and computes confidence from evidence:

```text
context sufficiency
requirement coverage
validation result
changed files risk
reviewer score placeholder
assumption penalty
```

### Provider request previews

Current external-write behavior is dry-run only:

```text
stash-create-pr-request.json
jira-update-preview.md
confluence-update-preview.md
jira-update-apply-request.json
confluence-update-apply-request.json
```

Real Stash/Jira/Confluence writes should only be added behind explicit configuration, environment-variable credentials, tests, and approval gates.

## Future architecture direction

Recommended next major refactor:

```text
bin/agent-sdlc.mjs          thin CLI entrypoint
src/cli/args.mjs           argument parsing
src/core/git.mjs           git wrapper
src/core/runs.mjs          run state + status
src/core/approvals.mjs     approval JSONL semantics
src/core/artifacts.mjs     artifact reads/writes
src/core/policy.mjs        policy loading/validation
src/commands/*.mjs         command handlers
src/daemon/server.mjs      daemon and UI
src/adapters/*.mjs         future agent/provider adapters
```

Future provider adapter shape:

```text
interpret_requirement
create_task_breakdown
create_implementation_plan
execute_approved_plan
review_changes
generate_update_previews
```

Start with a mock adapter, then add Amp SDK, then Copilot or other providers.
