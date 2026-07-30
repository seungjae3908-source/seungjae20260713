import { Router, type Request, type Response } from 'express';
import { requireCommandHubToken } from '../middleware/command-hub-auth';
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
    error: 'COMMAND_HUB_READ_FAILED',
    action,
    message,
  });
}

router.use(requireCommandHubToken);

router.get('/health', async (req, res) => {
  const config = getCommandHubConfig();

  await audit(req, 'health', true);

  res.json({
    ok: true,
    service: 'ai-command-hub',
    mode: config.mode,
    writeActionsEnabled: config.writeActionsEnabled,
    projectRoot: config.projectRoot,
    pm2AppName: config.pm2AppName,
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

export default router;
