# agent-sdlc

Local-first Agentic SDLC workflow control CLI.

Source code layout:

```text
src/main.mjs                         # thin public source entrypoint
src/app.mjs                          # thin application command dispatcher
src/cli/args.mjs                     # CLI argument parsing
src/adapters/types.mjs                # provider adapter contract phases
src/adapters/index.mjs                # provider adapter resolver
src/adapters/mock-agent.mjs           # deterministic local mock execution adapter
src/adapters/amp.mjs                  # Amp adapter skeleton with provider request artifacts
src/commands/feature.mjs             # feature execution, PR preview/request, enterprise previews
src/commands/run.mjs                 # run init/list/status/audit-report commands
src/commands/approval.mjs            # approval gate commands
src/commands/safety.mjs              # repo scan, policy validation, config validation commands
src/core/io.mjs                      # JSON/text artifact IO helpers
src/core/git.mjs                     # git and shell command wrappers
src/core/policy.mjs                  # policy defaults/loading/validation
src/core/approvals.mjs               # approval JSONL semantics
src/core/config.mjs                  # config editing and validation helpers
src/core/amp-runtime.mjs             # Amp runtime config/readiness checks without secret logging
src/core/confidence.mjs              # validation command selection and confidence scoring
src/core/repo.mjs                    # repo scanning, stack detection, config file discovery
src/core/run-context.mjs             # run loading, run discovery, CLI failure helper
src/core/text.mjs                    # text/list formatting helpers
src/daemon/server.mjs                # local mission-control HTTP API/server
src/daemon/mission-control-html.mjs  # standalone mission-control HTML
bin/agent-sdlc.mjs                   # thin executable entrypoint
```

Handoff docs for continuing on another PC:

```text
docs/CONTINUATION_PROMPT.md  # prompt to paste into a new AI coding session
docs/ARCHITECTURE.md         # architecture notes and future direction
docs/architecture.html       # browser-openable SVG architecture diagram
```

Implemented MVP commands:

```bash
agent-sdlc daemon start \
  --repo /path/to/repo \
  --port 4317

agent-sdlc repo scan \
  --repo /path/to/repo

agent-sdlc policy validate \
  --repo /path/to/repo

agent-sdlc config validate \
  --repo /path/to/repo \
  --target-file service-a/src/main/resources/application.yml

agent-sdlc provider check \
  --repo /path/to/repo \
  --provider amp \
  --run <run-id>

agent-sdlc run init \
  --repo /path/to/repo \
  --run <run-id> \
  --workflow-type feature_config_change

agent-sdlc run list \
  --repo /path/to/repo \
  --json

agent-sdlc feature interpret \
  --repo /path/to/repo \
  --run <run-id> \
  --requirement "Enable feature flag for service-a" \
  --agent-adapter mock-agent

agent-sdlc feature plan \
  --repo /path/to/repo \
  --run <run-id> \
  --agent-adapter mock-agent

agent-sdlc feature execute \
  --repo /path/to/repo \
  --run <run-id> \
  --target-file service-a/src/main/resources/application.yml \
  --set-key feature.enabled \
  --set-value true \
  --mock-agent \
  --auto-approve

agent-sdlc feature review \
  --repo /path/to/repo \
  --run <run-id> \
  --agent-adapter mock-agent

agent-sdlc feature pr-preview \
  --repo /path/to/repo \
  --run <run-id>

agent-sdlc feature create-pr \
  --repo /path/to/repo \
  --run <run-id> \
  --provider stash \
  --project-key ABC \
  --repo-slug service-a \
  --reviewers alice,bob \
  --dry-run

agent-sdlc feature enterprise-preview \
  --repo /path/to/repo \
  --run <run-id> \
  --jira-key ABC-123 \
  --confluence-page-id 12345

agent-sdlc feature apply-enterprise-updates \
  --repo /path/to/repo \
  --run <run-id> \
  --dry-run

agent-sdlc run status \
  --repo /path/to/repo \
  --run <run-id> \
  --json

agent-sdlc run audit-report \
  --repo /path/to/repo \
  --run <run-id>

agent-sdlc approval list \
  --repo /path/to/repo \
  --run <run-id> \
  --json

agent-sdlc approval approve \
  --repo /path/to/repo \
  --run <run-id> \
  --gate pr_creation \
  --actor alice

agent-sdlc approval reject \
  --repo /path/to/repo \
  --run <run-id> \
  --gate enterprise_update \
  --reason "needs changes"
```

## Required preconditions

The target repo must already contain:

```text
.agentic-sdlc/runs/<run-id>/manifest.json
.agentic-sdlc/runs/<run-id>/context-pack.json
.agentic-sdlc/runs/<run-id>/approvals.jsonl
```

Use `agent-sdlc run init` to scaffold `manifest.json`, `context-pack.json`, `approvals.jsonl`, `events.jsonl`, and repo policy config at `.agentic-sdlc/policy.json`. It detects basic validation commands from common repo files (`pom.xml`, Gradle files, `package.json`, `go.mod`).

`approvals.jsonl` must contain an approved implementation plan gate:

```json
{"gate":"implementation_plan","status":"approved"}
```

With `--auto-approve`, the command records the `execution` approval gate for demo/mock mode.

## Produced artifacts

```text
.agentic-sdlc/repo-scan.json
.agentic-sdlc/provider-readiness/amp.json
.agentic-sdlc/policy-validation.json
.agentic-sdlc/config-validation.json
.agentic-sdlc/runs/<run-id>/agent-adapter-interpret-requirement.json
.agentic-sdlc/runs/<run-id>/agent-adapter-interpret-result.json        # only when live Amp interpret runs
.agentic-sdlc/runs/<run-id>/amp-interpret-raw-output.txt               # only when live Amp interpret runs
.agentic-sdlc/runs/<run-id>/interpreted-requirement.json
.agentic-sdlc/runs/<run-id>/interpreted-requirement.md
.agentic-sdlc/runs/<run-id>/agent-adapter-plan.json
.agentic-sdlc/runs/<run-id>/agent-adapter-task-breakdown-result.json     # only when live Amp planning runs
.agentic-sdlc/runs/<run-id>/amp-task-breakdown-raw-output.txt            # only when live Amp planning runs
.agentic-sdlc/runs/<run-id>/agent-adapter-implementation-plan-result.json # only when live Amp planning runs
.agentic-sdlc/runs/<run-id>/amp-implementation-plan-raw-output.txt        # only when live Amp planning runs
.agentic-sdlc/runs/<run-id>/task-breakdown.json
.agentic-sdlc/runs/<run-id>/task-breakdown.md
.agentic-sdlc/runs/<run-id>/implementation-plan.json
.agentic-sdlc/runs/<run-id>/implementation-plan.md
.agentic-sdlc/runs/<run-id>/agent-adapter.json
.agentic-sdlc/runs/<run-id>/changed-files.json
.agentic-sdlc/runs/<run-id>/diff.patch
.agentic-sdlc/runs/<run-id>/maven-output.txt
.agentic-sdlc/runs/<run-id>/config-validation.json
.agentic-sdlc/runs/<run-id>/validation-summary.json
.agentic-sdlc/runs/<run-id>/confidence.json
.agentic-sdlc/runs/<run-id>/agent-adapter-review.json
.agentic-sdlc/runs/<run-id>/change-review.json
.agentic-sdlc/runs/<run-id>/change-review.md
.agentic-sdlc/runs/<run-id>/events.jsonl
```

The `feature interpret` command runs the adapter `interpret_requirement` phase and writes `interpreted-requirement.json`, `interpreted-requirement.md`, and `agent-adapter-interpret-requirement.json`. The mock adapter is deterministic/local-only and stops at `waiting_requirement_approval` so a human can approve or correct the interpretation before planning/execution. The `amp` adapter is also available; by default it records provider request artifacts without calling Amp. If `AGENT_SDLC_AMP_LIVE=true`, `AGENT_SDLC_AMP_ALLOW_NETWORK=true`, and readiness passes, only the `interpret_requirement` phase invokes the configured Amp command. That live path is read-only/no-write and persists `agent-adapter-interpret-result.json` plus `amp-interpret-raw-output.txt` for audit.

The `feature plan` command runs `create_task_breakdown` and `create_implementation_plan`, writes task breakdown and implementation plan artifacts, and stops at `waiting_plan_approval` for human approval. With `--agent-adapter amp`, these phases default to request-artifact-only mode. If the same live/readiness opt-in is enabled, Amp can provide JSON task breakdown and implementation plan outputs; raw and parsed planning artifacts are persisted, but execution remains local-only.

The `feature execute` command creates/checks out `manifest.workingBranch` or `agent-sdlc/<run-id>`, resolves an agent adapter, applies the deterministic safe config change, captures adapter metadata, captures diff and changed files, validates the edited config file, runs validation commands from the manifest/context pack, computes evidence-based confidence, then stops at `waiting_pr_approval`. The Amp skeleton keeps execution controlled by applying only the same explicit `--target-file`/`--set-key`/`--set-value` local config change and recording `providerInvocationExecuted: false`.

The `feature review` command runs `review_changes` against the execution diff, validation summary, confidence, and changed files, then writes deterministic change-review artifacts before PR preview/approval.

For `.yaml`/`.yml` target files, dotted keys are written as nested YAML. For example `--set-key feature.enabled --set-value true` writes:

```yaml
feature:
  enabled: true
```

Policy config is loaded from `.agentic-sdlc/policy.json` when present. It controls protected branches and validation gating defaults.

The `repo scan` command writes `.agentic-sdlc/repo-scan.json` with current branch, branches, remotes, detected stack, detected validation commands, tracked/scanned/config/dirty file counts, config files, dirty files, and policy presence.

The `provider check --provider amp` command writes `.agentic-sdlc/provider-readiness/amp.json` with Amp command availability, opt-in live invocation settings, blockers/warnings, and safe-default metadata. It records whether the configured API-key environment variable is present, but never logs the secret value.

The `policy validate` command writes `.agentic-sdlc/policy-validation.json` with the effective policy, hard errors, and warnings for weakened safety settings.

The `config validate` command writes `.agentic-sdlc/config-validation.json` for one target file or all detected config files. It validates JSON parsing and basic YAML/properties/TOML shape without external dependencies.

The `daemon start` command runs a localhost mission-control server. Open the printed URL to view runs, current state, validation/confidence, available artifacts, and approval controls. API endpoints include:

```text
GET  /
GET  /api/health
GET  /api/repo/scan
GET  /api/runs
GET  /api/runs/<run-id>/status
GET  /api/runs/<run-id>/artifacts/<artifact-name>
POST /api/runs/<run-id>/actions/<action>
POST /api/runs/<run-id>/approvals
```

The daemon is local-only by default (`127.0.0.1`) and writes the same approval JSONL records as the CLI. Supported action names are `interpret`, `plan`, `execute`, `review`, `pr-preview`, `audit-report`, `create-pr`, `enterprise-preview`, and `apply-enterprise-updates`; each action shells back through the CLI and returns the resulting status/artifacts.

The `feature pr-preview` command reads the execution artifacts and generates PR preview artifacts only. It does not push branches, create PRs, or write to enterprise systems.

Additional preview artifacts:

```text
.agentic-sdlc/runs/<run-id>/pr-preview.md
.agentic-sdlc/runs/<run-id>/pr-title.txt
.agentic-sdlc/runs/<run-id>/pr-body.md
.agentic-sdlc/runs/<run-id>/review-checklist.md
```

The `feature create-pr` command is a gated dry-run skeleton. It requires the preview artifacts and a `pr_creation` approval record, refuses failed validation unless `--allow-failed-validation` is supplied, refuses protected source/current branches, and writes the provider request payload without calling Bitbucket/Stash. The request includes enterprise-friendly Stash/Bitbucket fields: `projectKey`, `repoSlug`, reviewers, source/target refs, and a `stashRestPayload` preview body.

Dry-run request artifact:

```text
.agentic-sdlc/runs/<run-id>/stash-create-pr-request.json
```

The `feature enterprise-preview` command generates proposed Jira/Confluence updates only. It requires the PR request artifact, writes preview/request artifacts, and stops at `waiting_enterprise_update_approval`.

Enterprise preview artifacts:

```text
.agentic-sdlc/runs/<run-id>/agent-adapter-update-previews.json
.agentic-sdlc/runs/<run-id>/jira-update-preview.md
.agentic-sdlc/runs/<run-id>/confluence-update-preview.md
.agentic-sdlc/runs/<run-id>/enterprise-update-request.json
```

The `feature apply-enterprise-updates` command is still a dry-run apply skeleton. It requires `enterprise-update-request.json` and an approved `enterprise_update` gate, then writes provider apply request artifacts without calling Jira or Confluence.

Enterprise apply request artifacts:

```text
.agentic-sdlc/runs/<run-id>/jira-update-apply-request.json
.agentic-sdlc/runs/<run-id>/confluence-update-apply-request.json
```

The `run status` command provides a mission-control-friendly snapshot of one run: inferred state, approved/missing gates, artifact checklist, validation status, confidence score, changed files, and the next recommended command. Use `--json` for UI/API consumption.

The `run list` command summarizes all local run directories with state, workflow, gates, validation, confidence, artifact checklist, and next command. Use `--json` for mission-control/API consumption.

The `approval` commands manage `approvals.jsonl` without manual editing. Latest record wins per gate, so a later reject supersedes an earlier approve.

The `run audit-report` command writes `audit-report.md` with run metadata, gate history, validation, confidence, changed files, artifact checklist, and event timeline.
