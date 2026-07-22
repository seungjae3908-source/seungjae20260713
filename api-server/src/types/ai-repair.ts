// AI_REPAIR_COST_CONSENT_V1
// AI_REPAIR_LIVE_DIAGNOSTIC_V1
// AI_REPAIR_HISTORY_SETTINGS_V1
export type AiRepairJobKind = 'diagnosis' | 'improvement';

export type AiRepairJobStatus =
  | 'queued'
  | 'preparing'
  | 'diagnosing'
  | 'repairing'
  | 'verifying'
  | 'awaiting_ai_approval'
  | 'awaiting_approval'
  | 'applying'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type AiRepairCheckName =
  | 'front-typecheck'
  | 'api-typecheck'
  | 'front-build'
  | 'api-build'
  | 'api-smoke'
  | 'browser-smoke';

export type AiRepairCheckResult = {
  name: AiRepairCheckName;
  label: string;
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  output: string;
  startedAt: string;
  completedAt: string;
};


export type AiRepairCurrentCheck = {
  name: AiRepairCheckName;
  label: string;
  startedAt: string;
};

export type AiRepairDiagnosticError = {
  name: AiRepairCheckName;
  label: string;
  output: string;
  detectedAt: string;
};

export type AiRepairChangedFile = {
  path: string;
  explanation: string;
  beforeHash: string;
  afterHash: string;
  diff: string;
};

export type AiRepairAttempt = {
  number: number;
  startedAt: string;
  completedAt?: string;
  summary?: string;
  findings: string[];
  checks: AiRepairCheckResult[];
  changes: AiRepairChangedFile[];
  error?: string;
};


export type AiRepairCostEstimate = {
  currency: 'USD';
  model: string;
  free: boolean;
  minUsd: number;
  likelyUsd: number;
  maxUsd: number;
  maxAttempts: number;
  note: string;
};

export type AiRepairUsage = {
  month: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  recordedAt: string;
};

export type AiRepairCostSummary = {
  month: string;
  currency: 'USD';
  estimatedCostUsd: number;
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  modelRates: {
    model: string;
    inputUsdPerMillion: number;
    cachedInputUsdPerMillion: number;
    outputUsdPerMillion: number;
  };
};


export type AiRepairBillingMode = 'free' | 'paid';

export type AiRepairFeatureSettings = {
  freeDiagnosisEnabled: boolean;
  paidDiagnosisEnabled: boolean;
  improvementEnabled: boolean;
  updatedAt: string;
};

export type AiRepairPagination = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export type AiRepairCostHistoryItem = {
  jobId: string;
  title: string;
  kind: AiRepairJobKind;
  model: string;
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  recordedAt: string;
};

export type AiRepairCostHistoryPage = {
  items: AiRepairCostHistoryItem[];
  pagination: AiRepairPagination;
};

export type AiRepairJob = {
  id: string;
  kind: AiRepairJobKind;
  title: string;
  request: string;
  createdBy: string;
  status: AiRepairJobStatus;
  progress: number;
  message: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  maxAttempts: number;
  currentAttempt: number;
  billingMode?: AiRepairBillingMode;
  costEstimate?: AiRepairCostEstimate;
  aiCostApproved?: boolean;
  aiCostApprovedAt?: string;
  aiCostApprovedBy?: string;
  actualCostUsd?: number;
  usage?: AiRepairUsage[];
  attempts: AiRepairAttempt[];
  checks: AiRepairCheckResult[];
  currentCheck?: AiRepairCurrentCheck;
  diagnosticErrors?: AiRepairDiagnosticError[];
  changedFiles: AiRepairChangedFile[];
  logs: string[];
  branch?: string;
  commitSha?: string;
  approvalPhrase?: string;
  approvedAt?: string;
  approvedBy?: string;
  deployedAt?: string;
  cancelledAt?: string;
  cancellationRequested?: boolean;
  error?: string;
  workspacePath?: string;
  notification?: {
    sentAt: string;
    pushSent: number;
    appStored: boolean;
    skipped?: string;
  };
};

export type AiRepairPublicConfig = {
  enabled: boolean;
  aiConfigured: boolean;
  repositoryReady: boolean;
  deploymentReady: boolean;
  repoPath: string | null;
  baseBranch: string;
  maxAttempts: number;
  features: AiRepairFeatureSettings;
  checks: Array<{ name: AiRepairCheckName; label: string }>;
  healthUrl: string | null;
};
