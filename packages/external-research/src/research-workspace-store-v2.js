import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { createResearchWorkspaceReader } from './research-workspace-reader-v1.js';

const HASH = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/** Fixed names only; the root is trusted server configuration, never a request parameter. */
export function createResearchWorkspaceStore(root) {
  if (typeof root !== 'string' || !isAbsolute(root)) fail('ABSOLUTE_TRUSTED_ROOT_REQUIRED');
  async function readFixed(name, limit) {
    const dir = await lstat(root);
    if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o022)) fail('UNSAFE_STORE_DIRECTORY');
    const resolved = await realpath(root);
    const path = join(resolved, name);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > limit || (before.mode & 0o022)) fail('UNSAFE_STORE_FILE');
      // Read limit+1 rather than unbounded readFile: a concurrently growing file stays bounded.
      const bytes = Buffer.alloc(limit + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const read = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (read.bytesRead === 0) break;
        offset += read.bytesRead;
      }
      const after = await handle.stat();
      if (offset > limit || offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail('STORE_CHANGED_DURING_READ');
      return bytes.subarray(0, offset);
    } finally { await handle.close(); }
  }
  return Object.freeze({
    async openSnapshot() {
      const bytes = await readFixed('policy.json', 8192);
      let p;
      try { p = JSON.parse(bytes.toString('utf8')); } catch { fail('STORE_POLICY_INVALID'); }
      const keys = ['schemaVersion', 'expectedSourceHeadSha', 'maxAgeMs', 'registrySha256', 'scope', 'executionAuthority'];
      if (!exactKeys(p, keys) || p.schemaVersion !== 'research-workspace-store-policy-v2' || !SHA.test(p.expectedSourceHeadSha)
        || !Number.isSafeInteger(p.maxAgeMs) || p.maxAgeMs <= 0 || p.maxAgeMs > 31 * 86400000
        || !HASH.test(p.registrySha256) || p.scope !== 'ADMIN_RESEARCH_SHARED' || p.executionAuthority !== 'NONE') fail('STORE_POLICY_INVALID');
      const pinned = Object.freeze({ ...p });
      return Object.freeze({
        policy: Object.freeze({ expectedSourceHeadSha: pinned.expectedSourceHeadSha, maxAgeMs: pinned.maxAgeMs }),
        policySha256: hash(bytes),
        async loadRegistry() {
          // The selected name and hash remain pinned even if policy.json is replaced later.
          const raw = await readFixed(`registry-${pinned.registrySha256}.json`, 2 * 1024 * 1024);
          if (hash(raw) !== pinned.registrySha256) fail('REGISTRY_BYTES_MISMATCH');
          let registry;
          try { registry = JSON.parse(raw.toString('utf8')); } catch { fail('REGISTRY_JSON_INVALID'); }
          if (!plain(registry)) fail('REGISTRY_JSON_INVALID');
          return registry;
        },
      });
    },
  });
}

/** Per-request pinned disk snapshot. Reuses the existing Phase1 reader, never calls a provider. */
export function createStoredWorkspaceHandler({ authorize, loadSanitizedSnapshot, root, clock = () => new Date().toISOString() }) {
  if (typeof authorize !== 'function' || typeof loadSanitizedSnapshot !== 'function' || typeof clock !== 'function') fail('STORE_CALLER_DEPENDENCIES_REQUIRED');
  const store = createResearchWorkspaceStore(root);
  return async (req, res) => {
    let session;
    const read = createResearchWorkspaceReader({
      authorize,
      clock,
      loadVideoSnapshot: loadSanitizedSnapshot,
      loadPolicy: async () => { session = await store.openSnapshot(); return session.policy; },
      loadRegistry: async () => { if (!session) fail('STORE_SESSION_MISSING'); return session.loadRegistry(); },
    });
    try { await read(req, res); }
    catch { res.status(503).json({ available: false, reason: 'WORKSPACE_READ_UNAVAILABLE' }); }
  };
}
