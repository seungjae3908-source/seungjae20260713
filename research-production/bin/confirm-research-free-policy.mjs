import { lstat, open, readFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { buildConfirmedResearchPolicies } from '../src/research-free-policy-confirmation.mjs';
import { readBoundedPrivateFile } from '../../ops/research-activation-preflight.mjs';

// Called only by the protected owner/exact-main activation workflow. No credentials are read.
if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('RESEARCH_CONFIRMATION_ROOT_REQUIRED');
const root = '/etc/investment-research';
const metadata = await lstat(root);
if (!metadata.isDirectory() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) throw new Error('RESEARCH_CONFIRMATION_UNSAFE_ROOT');
async function policyText(name) {
  const path = join(root, name);
  try {
    const meta = await lstat(path);
    if (!meta.isFile() || meta.uid !== 0 || (meta.mode & 0o022) !== 0 || meta.size > 16384) throw new Error('RESEARCH_CONFIRMATION_UNSAFE_POLICY');
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return readFile(new URL(`../deploy/${name}.example`, import.meta.url), 'utf8');
  }
}
const plan = buildConfirmedResearchPolicies({
  aiText: await policyText('research-ai.env'), videoText: await policyText('research-video.env'),
  targetSha: process.env.TARGET_SHA,
  appSha: readBoundedPrivateFile('/opt/stock-app/.deploy/current-sha').trim(),
  ownerCommentId: process.env.RESEARCH_FREE_ONLY_OWNER_COMMENT_ID, observedAt: Date.now(),
});
async function atomicWrite(name, value, mode) {
  const path = join(root, name), temp = path + '.' + process.pid + '.tmp';
  const fd = await open(temp, 'wx', mode);
  try { await fd.writeFile(value); await fd.sync(); } finally { await fd.close(); }
  await rename(temp, path);
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
await atomicWrite('research-ai.env', plan.aiText, 0o640);
await atomicWrite('research-video.env', plan.videoText, 0o640);
await atomicWrite('research-free-confirmation.json', JSON.stringify(plan.confirmation) + '\n', 0o644);
process.stdout.write('RESEARCH_FREE_ONLY_OWNER_CONFIRMATION=RECORDED\n');
