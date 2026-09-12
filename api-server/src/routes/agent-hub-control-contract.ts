export const AGENT_HUB_REPOSITORY = 'seungjae3908-source/seungjae20260713';
export const AGENT_HUB_ISSUE = 838;

const COMMAND_MAX_LENGTH = 1200;
const TRANSPORT_MARKERS = ['[WORKER_REPORT]', '[HUB_COMMAND]', '[HUB_STATE]', '<!-- agent-hub-', '<!-- agent-executor-'];
const ALLOWED_WORKERS = new Set(['ai-chart', 'ai-signal-scanner', 'test-runner', 'security-inspector', 'integration-planner']);

export function sanitizeAgentHubCommand(value: unknown) {
  if (typeof value !== 'string') return null;
  const command = value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!command || command.length > COMMAND_MAX_LENGTH) return null;
  if (TRANSPORT_MARKERS.some((marker) => command.includes(marker))) return null;
  return command;
}

export function normalizeWorkerHint(value: unknown) {
  const worker = typeof value === 'string' ? value.trim() : '';
  return ALLOWED_WORKERS.has(worker) ? worker : 'integration-planner';
}

export function buildAgentHubWorkerReport(params: {
  command: string;
  workerHint: string;
  currentMainSha: string;
  requestedBy: string;
}) {
  const { command, workerHint, currentMainSha, requestedBy } = params;
  return [
    '[WORKER_REPORT][APP_CONTROL_COMMAND]',
    `actual_main: ${currentMainSha}`,
    `FIRST_ZERO: APP_USER_COMMAND ${command}`,
    `worker_hint: ${workerHint}`,
    `requested_by: ${requestedBy}`,
    'code_mutation: 0',
    'workflow_mutation: 0',
    'new_pr: 0',
    'new_branch: 0',
    'merge: 0',
    'production_deploy: 0',
    'staging_deploy: 0',
    'private_api: 0',
    'real_orders: 0',
    'replit_agent: 0',
  ].join('\n');
}
