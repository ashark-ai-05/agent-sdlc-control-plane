import { parseArgs } from './cli/args.mjs';
import { approvalCommand } from './commands/approval.mjs';
import { featureApplyEnterpriseUpdates, featureCreatePr, featureEnterprisePreview, featureExecute, featureInterpret, featurePlan, featurePrPreview, featureReview } from './commands/feature.mjs';
import { runAuditReport, runInit, runList, runStatus } from './commands/run.mjs';
import { configValidate, policyValidate, repoScan } from './commands/safety.mjs';
import { daemonStart } from './daemon/server.mjs';

function usage() {
  console.log(`Usage:
  agent-sdlc daemon start --repo <repo> [--host 127.0.0.1] [--port 4317]
  agent-sdlc repo scan --repo <repo>
  agent-sdlc policy validate --repo <repo>
  agent-sdlc config validate --repo <repo> [--target-file <path>]
  agent-sdlc run init --repo <repo> --run <run-id> [--workflow-type feature_config_change] [--validation-command 'npm test'] [--force]
  agent-sdlc run list --repo <repo> [--json]
  agent-sdlc feature interpret --repo <repo> --run <run-id> --requirement <text> [--agent-adapter mock-agent|amp]
  agent-sdlc feature plan --repo <repo> --run <run-id> [--agent-adapter mock-agent|amp]
  agent-sdlc feature execute --repo <repo> --run <run-id> --target-file <path> --set-key <key> --set-value <value> [--mock-agent|--agent-adapter amp] [--auto-approve]
  agent-sdlc feature review --repo <repo> --run <run-id> [--agent-adapter mock-agent|amp]
  agent-sdlc feature pr-preview --repo <repo> --run <run-id>
  agent-sdlc feature create-pr --repo <repo> --run <run-id> --provider stash [--dry-run] [--project-key ABC] [--repo-slug service] [--reviewers alice,bob] [--allow-failed-validation]
  agent-sdlc feature enterprise-preview --repo <repo> --run <run-id> [--jira-key ABC-123] [--confluence-page-id 12345]
  agent-sdlc feature apply-enterprise-updates --repo <repo> --run <run-id> [--dry-run]
  agent-sdlc run status --repo <repo> --run <run-id> [--json]
  agent-sdlc run audit-report --repo <repo> --run <run-id>
  agent-sdlc approval list --repo <repo> --run <run-id> [--json]
  agent-sdlc approval approve --repo <repo> --run <run-id> --gate <gate> [--actor <name>] [--reason <reason>]
  agent-sdlc approval reject --repo <repo> --run <run-id> --gate <gate> --reason <reason> [--actor <name>]
`);
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const [domain, action] = args._;
  if (domain === 'daemon' && action === 'start') daemonStart(args);
  else if (domain === 'repo' && action === 'scan') repoScan(args);
  else if (domain === 'policy' && action === 'validate') policyValidate(args);
  else if (domain === 'config' && action === 'validate') configValidate(args);
  else if (domain === 'run' && action === 'init') runInit(args);
  else if (domain === 'run' && action === 'list') runList(args);
  else if (domain === 'feature' && action === 'interpret') featureInterpret(args);
  else if (domain === 'feature' && action === 'plan') featurePlan(args);
  else if (domain === 'feature' && action === 'execute') featureExecute(args);
  else if (domain === 'feature' && action === 'review') featureReview(args);
  else if (domain === 'feature' && action === 'pr-preview') featurePrPreview(args);
  else if (domain === 'feature' && action === 'create-pr') featureCreatePr(args);
  else if (domain === 'feature' && action === 'enterprise-preview') featureEnterprisePreview(args);
  else if (domain === 'feature' && action === 'apply-enterprise-updates') featureApplyEnterpriseUpdates(args);
  else if (domain === 'run' && action === 'status') runStatus(args);
  else if (domain === 'run' && action === 'audit-report') runAuditReport(args);
  else if (domain === 'approval' && ['list', 'approve', 'reject'].includes(action)) approvalCommand(args, action);
  else {
    usage();
    process.exit(domain ? 1 : 0);
  }
}
