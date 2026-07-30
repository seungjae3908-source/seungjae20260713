import { Router, type Request, type Response } from 'express';
import { requireCommandHubToken } from '../middleware/command-hub-auth';
import {
  createCheckJob,
  getCheckJob,
  getCommandHubRunnerConfig,
  listCheckJobs,
} from '../services/command-hub-job.service';
import {
  getCommandHubConfig,
  getDiskStatus,
  getGitStatus,
  getPm2Logs,
  getPm2Status,
  getReadOnlySnapshot,
  getSystemStatus,
  writeCommandHubAuditEvent,
} from '../services/command-hub.service';

const router = Router();

function getRequestMetadata(req: Request) {
  return {
    remoteIp: req.ip,
    userAgent: req.get('user-agent'),
  };
}

async function audit(
  req: Request,
  action: string,
  success: boolean,
  details?: Record<string, unknown>,
): Promise<void> {
  await writeCommandHubAuditEvent({
    action,
    success,
    ...getRequestMetadata(req),
    details,
  });
}

function sendUnexpectedError(
  req: Request,
  res: Response,
  action: string,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : 'Unknown error';

  void audit(req, action, false, { message });

  res.status(500).json({
    ok: false,
    error: 'COMMAND_HUB_OPERATION_FAILED',
    action,
    message,
  });
}

router.use(requireCommandHubToken);

router.get('/health', async (req, res) => {
  const config = getCommandHubConfig();
  const runner = getCommandHubRunnerConfig();

  await audit(req, 'health', true);

  res.json({
    ok: true,
    service: 'ai-command-hub',
    mode: config.mode,
    writeActionsEnabled: config.writeActionsEnabled,
    projectRoot: config.projectRoot,
    pm2AppName: config.pm2AppName,
    runner,
    checkedAt: new Date().toISOString(),
  });
});

router.get('/server/status', async (req, res) => {
  try {
    const [disk, pm2] = await Promise.all([
      getDiskStatus(),
      getPm2Status(),
    ]);
    const success = disk.exitCode === 0 && pm2.ok;

    await audit(req, 'server.status', success, {
      diskExitCode: disk.exitCode,
      pm2Ok: pm2.ok,
    });

    res.json({
      ok: success,
      mode: 'read-only',
      system: getSystemStatus(),
      disk,
      pm2,
    });
  } catch (error) {
    sendUnexpectedError(req, res, 'server.status', error);
  }
});

router.get('/pm2/status', async (req, res) => {
  try {
    const pm2 = await getPm2Status();
    await audit(req, 'pm2.status', pm2.ok);

    res.json({
      ok: pm2.ok,
      mode: 'read-only',
      pm2,
    });
  } catch (error) {
    sendUnexpectedError(req, res, 'pm2.status', error);
  }
});

router.get('/pm2/logs', async (req, res) => {
  try {
    const logs = await getPm2Logs(req.query.lines);
    const success = logs.command.exitCode === 0;

    await audit(req, 'pm2.logs', success, {
      lines: logs.lines,
      exitCode: logs.command.exitCode,
    });

    res.json({
      ok: success,
      mode: 'read-only',
      logs,
    });
  } catch (error) {
    sendUnexpectedError(req, res, 'pm2.logs', error);
  }
});

router.get('/git/status', async (req, res) => {
  try {
    const git = await getGitStatus();
    const success =
      git.status.exitCode === 0 &&
      git.branch.length > 0 &&
      git.commit.length > 0;

    await audit(req, 'git.status', success, {
      branch: git.branch,
      commit: git.commit,
    });

    res.json({
      ok: success,
      mode: 'read-only',
      git,
    });
  } catch (error) {
    sendUnexpectedError(req, res, 'git.status', error);
  }
});

router.get('/snapshot', async (req, res) => {
  try {
    const snapshot = await getReadOnlySnapshot(req.query.lines);
    const success =
      snapshot.disk.exitCode === 0 &&
      snapshot.git.status.exitCode === 0 &&
      snapshot.git.branch.length > 0 &&
      snapshot.git.commit.length > 0 &&
      snapshot.pm2.ok &&
      snapshot.logs.command.exitCode === 0;

    await audit(req, 'snapshot', success, {
      logLines: snapshot.logs.lines,
    });

    res.json({
      ok: success,
      snapshot,
    });
  } catch (error) {
    sendUnexpectedError(req, res, 'snapshot', error);
  }
});

router.get('/checks', async (req, res) => {
  const jobs = listCheckJobs().map((job) => ({
    id: job.id,
    action: job.action,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    durationMs: job.durationMs,
    exitCode: job.exitCode,
  }));

  await audit(req, 'checks.list', true, { count: jobs.length });

  res.json({
    ok: true,
    runner: getCommandHubRunnerConfig(),
    jobs,
  });
});

router.post('/checks', async (req, res) => {
  try {
    const job = createCheckJob(req.body?.action);

    await audit(req, 'checks.create', true, {
      jobId: job.id,
      action: job.action,
    });

    res.status(202).json({
      ok: true,
      message: 'Fixed validation job queued.',
      job,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const status =
      message === 'COMMAND_HUB_RUNNER_DISABLED'
        ? 503
        : message === 'COMMAND_HUB_INVALID_CHECK_ACTION'
          ? 400
          : 500;

    await audit(req, 'checks.create', false, { message });

    res.status(status).json({
      ok: false,
      error: message,
      allowedActions: getCommandHubRunnerConfig().actions,
    });
  }
});

router.get('/checks/:jobId', async (req, res) => {
  const job = getCheckJob(req.params.jobId);

  if (!job) {
    await audit(req, 'checks.get', false, {
      jobId: req.params.jobId,
      reason: 'not_found',
    });

    res.status(404).json({
      ok: false,
      error: 'COMMAND_HUB_JOB_NOT_FOUND',
    });
    return;
  }

  await audit(req, 'checks.get', true, {
    jobId: job.id,
    action: job.action,
    status: job.status,
  });

  res.json({
    ok: true,
    job,
  });
});

export default router;
