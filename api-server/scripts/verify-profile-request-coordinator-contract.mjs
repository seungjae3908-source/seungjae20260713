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

const beginIndex = auth.indexOf('const coordinatorDrain = profileRequestsRef.current.beginLogout();');
const queueDrainIndex = auth.indexOf('await profileLoadQueueRef.current;', beginIndex);
const coordinatorDrainIndex = auth.indexOf('await coordinatorDrain;', queueDrainIndex);
const signOutIndex = auth.indexOf('await getSupabase().auth.signOut();', coordinatorDrainIndex);
assert(
  beginIndex >= 0
    && queueDrainIndex > beginIndex
    && coordinatorDrainIndex > queueDrainIndex
    && signOutIndex > coordinatorDrainIndex,
  'logout must block, drain queued and active profile work, then call Supabase signOut',
);
assert(auth.includes('profileRequestsRef.current.finishLogout();'), 'successful logout must release the coordinator in a null identity');
assert(auth.includes('profileRequestsRef.current.restoreAfterFailedLogout('), 'failed logout must restore the verified session identity');
assert(!auth.includes('new AbortController'), 'profile lifecycle must not manufacture browser request aborts');
assert(!auth.includes('.abort('), 'profile lifecycle must drain requests instead of aborting them');

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
