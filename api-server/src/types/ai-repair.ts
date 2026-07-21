export type AiRepairJobKind = 'diagnosis' | 'improvement';

export type AiRepairJobStatus =
  | 'queued'
  | 'preparing'
  | 'diagnosing'
  | 'repairing'
  | 'verifying'
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
  attempts: AiRepairAttempt[];
  checks: AiRepairCheckResult[];
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
  checks: Array<{ name: AiRepairCheckName; label: string }>;
  healthUrl: string | null;
};
