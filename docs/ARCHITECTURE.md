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

Main source and entrypoint:

```text
src/main.mjs                         thin public source entrypoint
src/app.mjs                          thin command dispatcher
src/cli/args.mjs                     CLI argument parsing
src/adapters/types.mjs                provider adapter phase contract
src/adapters/index.mjs                provider adapter resolver
src/adapters/mock-agent.mjs           deterministic local mock execution adapter
src/adapters/amp.mjs                  Amp adapter skeleton with request-artifact-only provider metadata
src/commands/feature.mjs             feature execution, PR preview/request, enterprise previews
src/commands/run.mjs                 run init/list/status/audit-report commands
src/commands/approval.mjs            approval gate commands
src/commands/safety.mjs              repo scan, policy validation, config validation commands
src/core/io.mjs                      JSON/text artifact IO helpers
src/core/git.mjs                     git and shell command wrappers
src/core/policy.mjs                  policy defaults/loading/validation
src/core/approvals.mjs               approval JSONL semantics
src/core/config.mjs                  config editing and validation helpers
src/core/amp-runtime.mjs             Amp runtime config/readiness checks without secret logging
src/core/confidence.mjs              validation command selection and confidence scoring
src/core/repo.mjs                    repo scanning, stack detection, config file discovery
src/core/run-context.mjs             run loading, run discovery, CLI failure helper
src/core/text.mjs                    text/list formatting helpers
src/daemon/server.mjs                local mission-control HTTP API/server
src/daemon/mission-control-html.mjs  standalone mission-control HTML
bin/agent-sdlc.mjs                   thin executable entrypoint
```

Implements repo scan, config validation, policy validation, provider readiness checks, run initialization, approvals, controlled execution, PR preview, PR request dry-run, enterprise previews, audit report, and local daemon startup.

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

Recommended next production hardening after this module split:

```text
src/providers/*.mjs        future Stash/Jira/Confluence clients behind approval gates
src/policy/*.mjs           richer enterprise policy rules and violations
src/testing/*.mjs          shared test fixture builders as tests grow
```

The command handlers now live in `src/commands/`, daemon HTTP handling lives in `src/daemon/server.mjs`, repo/run helpers live in `src/core/`, and provider execution is behind `src/adapters/`.

Current provider adapter shape:

```text
interpret_requirement
create_task_breakdown
create_implementation_plan
execute_approved_plan
review_changes
generate_update_previews
```

The first implemented adapter is `mock-agent`, which supports deterministic local requirement interpretation through `interpret_requirement`, task breakdown + implementation planning through `create_task_breakdown`/`create_implementation_plan`, deterministic local config changes through `execute_approved_plan`, deterministic review through `review_changes`, and update-preview metadata through `generate_update_previews`. It writes adapter artifacts for auditability.

The second adapter is `amp`, a guarded live-capable adapter behind the same phase contract. It records Amp provider request prompts/schemas and audit metadata for every phase while keeping execution controlled by the platform. Its provider requests include readiness/config metadata from `src/core/amp-runtime.mjs`, including command availability, live-invocation opt-in state, blockers/warnings, phase-specific args, and secret-safe API-key presence. Live provider phases currently implemented are `interpret_requirement`, `create_task_breakdown`, `create_implementation_plan`, `review_changes`, `generate_update_previews`, and an advisory `execute_approved_plan` proposal. They run only when `AGENT_SDLC_AMP_LIVE=true`, `AGENT_SDLC_AMP_ALLOW_NETWORK=true`, and readiness passes. Live provider calls send prompts on stdin to the configured command, validate JSON schemas, and persist raw/parsed provider output artifacts. Execution remains controlled: Amp can provide an execution proposal, but the control plane applies only the explicit local config edit (`--target-file`, `--set-key`, `--set-value`) so Amp cannot perform uncontrolled SDK/CLI writes.
