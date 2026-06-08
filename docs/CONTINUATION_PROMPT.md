# Continuation prompt for another PC

Use this prompt when you clone this repository on another machine and want an AI coding agent to continue the project from the current state.

```text
You are continuing work on the `agent-sdlc` repository, a local-first Agentic SDLC workflow control CLI and mission-control UI.

Repository purpose:
Build a standalone local control plane around replaceable agent execution providers. The product should orchestrate safe SDLC workflows using explicit run state, approval gates, repo-local artifacts, validation, confidence scoring, audit trails, and a localhost mission-control UI. Treat LLM/agent providers as replaceable execution adapters; the durable platform value is the workflow control plane.

Current repository:
https://github.com/ashark-ai-05/agent-sdlc-control-plane

Current known latest commit when this handoff was written:
fb15517 Add mission control execute action

Important design stance:
- local-first by default
- branch/PR-only code changes
- no protected-branch writes
- no merge/deploy/production mutation actions
- approval gates before risky writes
- dry-run provider request artifacts before real Stash/Bitbucket/Jira/Confluence calls
- evidence-based confidence, not raw LLM confidence
- repo-local `.agentic-sdlc/` run state and artifacts
- mission-control UI is local-only by default: `127.0.0.1`

What already exists:
- Node ESM CLI in `bin/agent-sdlc.mjs`
- Tests in `test/feature-execute.test.mjs`
- No runtime dependencies beyond Node >=20 and git
- Current commands:
  - `agent-sdlc daemon start --repo <repo> [--host 127.0.0.1] [--port 4317]`
  - `agent-sdlc repo scan --repo <repo>`
  - `agent-sdlc policy validate --repo <repo>`
  - `agent-sdlc config validate --repo <repo> [--target-file <path>]`
  - `agent-sdlc run init --repo <repo> --run <run-id> [--workflow-type feature_config_change] [--validation-command 'npm test'] [--force]`
  - `agent-sdlc run list --repo <repo> [--json]`
  - `agent-sdlc run status --repo <repo> --run <run-id> [--json]`
  - `agent-sdlc run audit-report --repo <repo> --run <run-id>`
  - `agent-sdlc approval list|approve|reject --repo <repo> --run <run-id> ...`
  - `agent-sdlc feature execute --repo <repo> --run <run-id> --target-file <path> --set-key <key> --set-value <value> --mock-agent --auto-approve`
  - `agent-sdlc feature pr-preview --repo <repo> --run <run-id>`
  - `agent-sdlc feature create-pr --repo <repo> --run <run-id> --provider stash --project-key <key> --repo-slug <slug> --reviewers alice,bob --dry-run`
  - `agent-sdlc feature enterprise-preview --repo <repo> --run <run-id> --jira-key ABC-123 --confluence-page-id 12345`
  - `agent-sdlc feature apply-enterprise-updates --repo <repo> --run <run-id> --dry-run`

Current daemon/API:
- `GET /`
- `GET /api/health`
- `GET /api/repo/scan`
- `GET /api/runs`
- `GET /api/runs/<run-id>/status`
- `GET /api/runs/<run-id>/artifacts/<artifact-name>`
- `POST /api/runs/<run-id>/actions/<action>`
- `POST /api/runs/<run-id>/approvals`

Supported daemon actions:
- `execute`
- `pr-preview`
- `audit-report`
- `create-pr`
- `enterprise-preview`
- `apply-enterprise-updates`

Current workflow shape:
1. `run init` scaffolds `.agentic-sdlc/runs/<run-id>/manifest.json`, `context-pack.json`, `approvals.jsonl`, `events.jsonl`, and `.agentic-sdlc/policy.json`.
2. Approve `implementation_plan`.
3. `feature execute` creates/checks out a safe working branch, applies an explicit deterministic config change, validates config, runs validation commands, writes changed-files/diff/output/summary/confidence artifacts, and stops at `waiting_pr_approval`.
4. `feature pr-preview` writes PR title/body/checklist/preview artifacts only.
5. Approve `pr_creation`.
6. `feature create-pr` writes a dry-run Stash/Bitbucket request artifact only.
7. `feature enterprise-preview` writes Jira/Confluence preview artifacts only.
8. Approve `enterprise_update`.
9. `feature apply-enterprise-updates` writes dry-run Jira/Confluence apply request artifacts only.
10. `run audit-report` writes a markdown audit report.

Core artifact paths:
- `.agentic-sdlc/policy.json`
- `.agentic-sdlc/repo-scan.json`
- `.agentic-sdlc/policy-validation.json`
- `.agentic-sdlc/config-validation.json`
- `.agentic-sdlc/runs/<run-id>/manifest.json`
- `.agentic-sdlc/runs/<run-id>/context-pack.json`
- `.agentic-sdlc/runs/<run-id>/approvals.jsonl`
- `.agentic-sdlc/runs/<run-id>/events.jsonl`
- `.agentic-sdlc/runs/<run-id>/changed-files.json`
- `.agentic-sdlc/runs/<run-id>/diff.patch`
- `.agentic-sdlc/runs/<run-id>/maven-output.txt`
- `.agentic-sdlc/runs/<run-id>/config-validation.json`
- `.agentic-sdlc/runs/<run-id>/validation-summary.json`
- `.agentic-sdlc/runs/<run-id>/confidence.json`
- `.agentic-sdlc/runs/<run-id>/pr-preview.md`
- `.agentic-sdlc/runs/<run-id>/pr-title.txt`
- `.agentic-sdlc/runs/<run-id>/pr-body.md`
- `.agentic-sdlc/runs/<run-id>/review-checklist.md`
- `.agentic-sdlc/runs/<run-id>/stash-create-pr-request.json`
- `.agentic-sdlc/runs/<run-id>/jira-update-preview.md`
- `.agentic-sdlc/runs/<run-id>/confluence-update-preview.md`
- `.agentic-sdlc/runs/<run-id>/enterprise-update-request.json`
- `.agentic-sdlc/runs/<run-id>/jira-update-apply-request.json`
- `.agentic-sdlc/runs/<run-id>/confluence-update-apply-request.json`
- `.agentic-sdlc/runs/<run-id>/audit-report.md`

How to verify immediately after clone:
```bash
git clone https://github.com/ashark-ai-05/agent-sdlc-control-plane.git
cd agent-sdlc-control-plane
npm test
node ./bin/agent-sdlc.mjs --help
node ./bin/agent-sdlc.mjs daemon start --repo . --port 4317
```
Then open:
```text
http://127.0.0.1:4317
```

Recommended next implementation chunks:
1. Split the single large CLI file into modules:
   - `src/cli/args.mjs`
   - `src/core/git.mjs`
   - `src/core/runs.mjs`
   - `src/core/approvals.mjs`
   - `src/core/artifacts.mjs`
   - `src/core/policy.mjs`
   - `src/commands/*.mjs`
   - `src/daemon/server.mjs`
   Keep `bin/agent-sdlc.mjs` as a thin entrypoint.
2. Add a real persistence model option:
   - continue repo-local artifacts
   - optionally add SQLite for daemon run index/event querying
3. Add first provider adapter interface:
   - `interpret_requirement`
   - `create_task_breakdown`
   - `create_implementation_plan`
   - `execute_approved_plan`
   Start with a mock adapter, then Amp SDK adapter, then Copilot adapter.
4. Add real Stash/Bitbucket integration behind explicit config and approval:
   - server URL
   - auth via environment variable only
   - projectKey/repoSlug/reviewers
   - create PR only after `pr_creation`
   - never merge
5. Add Jira/Confluence integration behind explicit config and approval:
   - preview first
   - write only after `enterprise_update`
   - auth via environment variable only
6. Add better validation:
   - real YAML parser if dependency policy allows
   - module-aware Maven/Gradle/npm validation
   - policy check command that blocks unsafe state
7. Improve mission-control UI:
   - forms for `run init`
   - forms for PR provider fields
   - forms for enterprise preview fields
   - event timeline
   - confidence/risk visualization
8. Add architecture docs and ADRs before wiring real enterprise writes.

When continuing, always:
- run `git status --short --branch` first
- run `npm test` before committing
- commit small stable chunks
- push to GitHub after each stable chunk
- do not introduce real external writes without explicit config, dry-run mode, tests, and approval gates
```

## Quick local demo command sequence

```bash
# inside this repo
npm test
node ./bin/agent-sdlc.mjs daemon start --repo . --port 4317
```

For a target repo demo:

```bash
TARGET=/path/to/target/repo
RUN=demo-run

node ./bin/agent-sdlc.mjs run init --repo "$TARGET" --run "$RUN"
node ./bin/agent-sdlc.mjs approval approve --repo "$TARGET" --run "$RUN" --gate implementation_plan --actor demo
node ./bin/agent-sdlc.mjs feature execute --repo "$TARGET" --run "$RUN" \
  --target-file src/main/resources/application.yml \
  --set-key feature.enabled \
  --set-value true \
  --mock-agent \
  --auto-approve
node ./bin/agent-sdlc.mjs feature pr-preview --repo "$TARGET" --run "$RUN"
node ./bin/agent-sdlc.mjs approval approve --repo "$TARGET" --run "$RUN" --gate pr_creation --actor demo
node ./bin/agent-sdlc.mjs feature create-pr --repo "$TARGET" --run "$RUN" \
  --provider stash \
  --project-key ABC \
  --repo-slug service-a \
  --reviewers alice,bob \
  --dry-run
node ./bin/agent-sdlc.mjs run audit-report --repo "$TARGET" --run "$RUN"
```
