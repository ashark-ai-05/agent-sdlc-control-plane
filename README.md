# agent-sdlc

Local-first Agentic SDLC workflow control CLI.

Implemented MVP commands:

```bash
agent-sdlc run init \
  --repo /path/to/repo \
  --run <run-id> \
  --workflow-type feature_config_change

agent-sdlc feature execute \
  --repo /path/to/repo \
  --run <run-id> \
  --target-file service-a/src/main/resources/application.yml \
  --set-key feature.enabled \
  --set-value true \
  --mock-agent \
  --auto-approve

agent-sdlc feature pr-preview \
  --repo /path/to/repo \
  --run <run-id>

agent-sdlc feature create-pr \
  --repo /path/to/repo \
  --run <run-id> \
  --provider stash \
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
.agentic-sdlc/runs/<run-id>/changed-files.json
.agentic-sdlc/runs/<run-id>/diff.patch
.agentic-sdlc/runs/<run-id>/maven-output.txt
.agentic-sdlc/runs/<run-id>/validation-summary.json
.agentic-sdlc/runs/<run-id>/confidence.json
.agentic-sdlc/runs/<run-id>/events.jsonl
```

The `feature execute` command creates/checks out `manifest.workingBranch` or `agent-sdlc/<run-id>`, applies a deterministic config change, captures diff and changed files, runs validation commands from the manifest/context pack, computes evidence-based confidence, then stops at `waiting_pr_approval`.

For `.yaml`/`.yml` target files, dotted keys are written as nested YAML. For example `--set-key feature.enabled --set-value true` writes:

```yaml
feature:
  enabled: true
```

Policy config is loaded from `.agentic-sdlc/policy.json` when present. It controls protected branches and validation gating defaults.

The `feature pr-preview` command reads the execution artifacts and generates PR preview artifacts only. It does not push branches, create PRs, or write to enterprise systems.

Additional preview artifacts:

```text
.agentic-sdlc/runs/<run-id>/pr-preview.md
.agentic-sdlc/runs/<run-id>/pr-title.txt
.agentic-sdlc/runs/<run-id>/pr-body.md
.agentic-sdlc/runs/<run-id>/review-checklist.md
```

The `feature create-pr` command is a gated dry-run skeleton. It requires the preview artifacts and a `pr_creation` approval record, refuses failed validation unless `--allow-failed-validation` is supplied, refuses protected source/current branches, and writes the provider request payload without calling Bitbucket/Stash.

Dry-run request artifact:

```text
.agentic-sdlc/runs/<run-id>/stash-create-pr-request.json
```

The `feature enterprise-preview` command generates proposed Jira/Confluence updates only. It requires the PR request artifact, writes preview/request artifacts, and stops at `waiting_enterprise_update_approval`.

Enterprise preview artifacts:

```text
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

The `approval` commands manage `approvals.jsonl` without manual editing. Latest record wins per gate, so a later reject supersedes an earlier approve.

The `run audit-report` command writes `audit-report.md` with run metadata, gate history, validation, confidence, changed files, artifact checklist, and event timeline.
