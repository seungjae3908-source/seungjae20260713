import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.basename(process.cwd()) === 'api-server'
  ? path.resolve(process.cwd(), '..')
  : path.resolve(process.cwd());
const read = (relative) => readFile(path.join(root, relative), 'utf8');
const [auth, coordinator, test] = await Promise.all([
  read('stock-analyzer/src/lib/auth.tsx'),
  read('stock-analyzer/src/lib/profile-request-coordinator.ts'),
  read('stock-analyzer/src/lib/profile-request-coordinator.test.ts'),
]);
const assert = (condition, message) => {
  if (!condition) throw new Error(`[profile-request-coordinator-contract] ${message}`);
};

function awaitedDrainCompletionIndex(source, variableName, afterIndex, beforeIndex) {
  if (afterIndex < 0 || beforeIndex <= afterIndex) return -1;
  const segment = source.slice(afterIndex, beforeIndex);
  const directMatch = new RegExp(`await\\s+${variableName}\\s*;`).exec(segment);
  if (directMatch) return afterIndex + directMatch.index + directMatch[0].length;

  const promiseAllPattern = /await\s+Promise\.all\s*\(\s*\[([\s\S]*?)\]\s*\)\s*;/g;
  for (const match of segment.matchAll(promiseAllPattern)) {
    if (new RegExp(`\\b${variableName}\\b`).test(match[1])) {
      return afterIndex + match.index + match[0].length;
    }
  }
  return -1;
}

function hasSafeLogoutDrainOrdering(source) {
  const signOutStart = source.indexOf('async signOut() {');
  const beginIndex = source.indexOf(
    'const coordinatorDrain = profileRequestsRef.current.beginLogout();',
    signOutStart,
  );
  const queueDrainIndex = source.indexOf('await profileLoadQueueRef.current;', beginIndex);
  const signOutIndex = source.indexOf('await getSupabase().auth.signOut();', queueDrainIndex);
  if (
    signOutStart < 0
    || beginIndex <= signOutStart
    || queueDrainIndex <= beginIndex
    || signOutIndex <= queueDrainIndex
  ) {
    return false;
  }

  const coordinatorDrainCompletionIndex = awaitedDrainCompletionIndex(
    source,
    'coordinatorDrain',
    queueDrainIndex,
    signOutIndex,
  );
  if (coordinatorDrainCompletionIndex <= queueDrainIndex) return false;

  const backupDrainIndex = source.indexOf(
    'const backupDrain = prepareBackupForSessionEnd();',
    signOutStart,
  );
  if (backupDrainIndex > signOutStart && backupDrainIndex < signOutIndex) {
    const backupDrainCompletionIndex = awaitedDrainCompletionIndex(
      source,
      'backupDrain',
      queueDrainIndex,
      signOutIndex,
    );
    if (backupDrainCompletionIndex <= queueDrainIndex) return false;
  }

  return true;
}

for (const [name, source] of [
  ['direct coordinator await', `
    async signOut() {
      const coordinatorDrain = profileRequestsRef.current.beginLogout();
      await profileLoadQueueRef.current;
      await coordinatorDrain;
      await getSupabase().auth.signOut();
    }
  `],
  ['coordinator and backup Promise.all', `
    async signOut() {
      const backupDrain = prepareBackupForSessionEnd();
      const coordinatorDrain = profileRequestsRef.current.beginLogout();
      await profileLoadQueueRef.current;
      await Promise.all([
        coordinatorDrain,
        backupDrain,
      ]);
      await getSupabase().auth.signOut();
    }
  `],
]) {
  assert(hasSafeLogoutDrainOrdering(source), `logout ordering fixture must accept ${name}`);
}

for (const [name, source] of [
  ['unawaited coordinator drain', `
    async signOut() {
      const coordinatorDrain = profileRequestsRef.current.beginLogout();
      await profileLoadQueueRef.current;
      await getSupabase().auth.signOut();
    }
  `],
  ['Promise.all without coordinator drain', `
    async signOut() {
      const backupDrain = prepareBackupForSessionEnd();
      const coordinatorDrain = profileRequestsRef.current.beginLogout();
      await profileLoadQueueRef.current;
      await Promise.all([backupDrain]);
      await getSupabase().auth.signOut();
    }
  `],
  ['coordinator drain after signOut', `
    async signOut() {
      const coordinatorDrain = profileRequestsRef.current.beginLogout();
      await profileLoadQueueRef.current;
      await getSupabase().auth.signOut();
      await coordinatorDrain;
    }
  `],
  ['missing logout block', `
    async signOut() {
      const coordinatorDrain = Promise.resolve();
      await profileLoadQueueRef.current;
      await coordinatorDrain;
      await getSupabase().auth.signOut();
    }
  `],
  ['missing queued profile drain', `
    async signOut() {
      const coordinatorDrain = profileRequestsRef.current.beginLogout();
      await coordinatorDrain;
      await getSupabase().auth.signOut();
    }
  `],
  ['missing coordinator drain call', `
    async signOut() {
      await profileLoadQueueRef.current;
      await getSupabase().auth.signOut();
    }
  `],
]) {
  assert(!hasSafeLogoutDrainOrdering(source), `logout ordering fixture must reject ${name}`);
}

assert(
  auth.includes("import { ProfileRequestCoordinator } from '@/lib/profile-request-coordinator';"),
  'auth provider must use the profile request coordinator',
);
assert(
  auth.includes('const profileRequestsRef = useRef(new ProfileRequestCoordinator<MemberProfile | null>());'),
  'auth provider must retain one coordinator per mounted provider',
);
assert(auth.includes('function profileRequestKey(value: Session | null)'), 'profile flights must be scoped to a concrete session');
assert(auth.includes('`${value.user.id}:${value.access_token}`'), 'session refreshes must receive a distinct in-memory request key');
assert(auth.includes('profileRequestsRef.current.setIdentity('), 'every session transition must update coordinator identity');
assert(auth.includes('profileRequestsRef.current.request({'), 'profile reads must pass through the coordinator');
assert(auth.includes('maxAgeMs: options.maxAgeMs ?? PROFILE_AUTO_REFRESH_MS'), 'focus and reconnect refreshes must reuse a fresh profile');
assert(auth.includes("window.addEventListener('online', refresh);"), 'reconnect refresh must use the same guarded path');
assert(auth.includes('const signOutTaskRef = useRef<Promise<void> | null>(null);'), 'repeated logout clicks must share one task');
assert(auth.includes('const coordinatorDrain = profileRequestsRef.current.beginLogout();'), 'logout must block new profile starts before draining');
assert(
  hasSafeLogoutDrainOrdering(auth),
  'logout must block, drain queued and active profile work, then call Supabase signOut',
);
assert(auth.includes('profileRequestsRef.current.finishLogout();'), 'successful logout must release the coordinator in a null identity');
assert(auth.includes('profileRequestsRef.current.restoreAfterFailedLogout('), 'failed logout must restore the verified session identity');
const finiteDeadlineStart = auth.indexOf('function loadProfileWithDeadline(');
const finiteDeadlineEnd = auth.indexOf('function runInitialBootstrap()', finiteDeadlineStart);
const finiteDeadlineSource = auth.slice(finiteDeadlineStart, finiteDeadlineEnd);
assert(
  finiteDeadlineStart >= 0 && finiteDeadlineEnd > finiteDeadlineStart,
  'finite profile deadline helper must remain explicit',
);
assert(
  (auth.match(/new AbortController\(\)/g) ?? []).length === 1
    && finiteDeadlineSource.includes('const controller = new AbortController();'),
  'only the finite profile deadline helper may create a browser request abort controller',
);
assert(
  finiteDeadlineSource.includes('loadProfile(user, { ...options, signal: controller.signal })')
    && finiteDeadlineSource.includes('AUTH_PROFILE_BOOTSTRAP_TIMEOUT_MS')
    && finiteDeadlineSource.includes('(error) => controller.abort(error),')
    && (auth.match(/\.abort\(/g) ?? []).length === 1,
  'profile requests may abort only when the finite profile deadline expires',
);

assert(coordinator.includes('const sharedFlights = new Map<string, SharedFlight>();'), 'provider remounts must share an active session flight');
assert(coordinator.includes('if (existing) return existing as Promise<T>;'), 'same-session profile calls must be single-flight');
assert(coordinator.includes('if (!force && isFresh) return Promise.resolve();'), 'fresh focus/reconnect calls must not start provider requests');
assert(coordinator.includes('beginLogout(): Promise<void>'), 'coordinator must expose an explicit logout drain');
assert(coordinator.includes('this.blocked = true;'), 'logout drain must synchronously block new starts');
assert(coordinator.includes('this.generation += 1;'), 'identity changes must invalidate late responses');
assert(coordinator.includes('waitForSharedFlight(requestKey)'), 'logout must include remount-shared work in its drain');

assert((test.match(/iteration < 25/g) ?? []).length >= 2, 'race regression must repeat at least 25 times');
for (const marker of [
  'one shared /profiles request',
  'post-logout profile starts remain zero',
  'late profile response is not applied',
  'fresh focus/reconnect does not refetch',
  'stale focus/reconnect refreshes once',
  'old user response cannot cross into a new login',
  'expired/logged-out session cannot start a profile request',
]) {
  assert(test.includes(marker), `race test is missing ${marker}`);
}

console.log('[profile-request-coordinator-contract] same-session single-flight, logout drain, freshness, reconnect, remount, and 25-pass race coverage verified');
