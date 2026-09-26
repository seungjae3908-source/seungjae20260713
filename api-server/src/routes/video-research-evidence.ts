import { Router, type IRouter } from 'express';
import sourceEvidenceRouter from './video-research-source-evidence';
import workspaceRouter from './research-workspace';

// Existing source reader is preserved byte-for-byte in its extracted module.
export {
  createVideoResearchEvidenceRouter,
  loadVideoResearchRuntimeEvidenceSnapshot,
  sanitizeVideoResearchRuntimeEvidence,
} from './video-research-source-evidence';

const router: IRouter = Router();
// Parent already requires auth/basic capability; workspace adds its own current admin gate.
router.use('/workspace', workspaceRouter);
router.use('/', sourceEvidenceRouter);
export default router;
