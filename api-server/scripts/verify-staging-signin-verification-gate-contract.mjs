import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.basename(process.cwd()) === 'api-server'
  ? path.resolve(process.cwd(), '..')
  : path.resolve(process.cwd());
const auth = await readFile(
  path.join(root, 'stock-analyzer/src/lib/auth.tsx'),
  'utf8',
);

const assert = (condition, message) => {
  if (!condition) throw new Error(`[staging-signin-verification-gate-contract] ${message}`);
};

function firstIndexAfter(source, needles, start) {
  const matches = needles
    .map((needle) => source.indexOf(needle, start))
    .filter((index) => index >= 0);
  return matches.length ? Math.min(...matches) : -1;
}

function profileVerificationCompletion(source, verifiedApply, signUpStart) {
  const directProfileLoad = source.indexOf(
    'await loadProfileWithDeadline(nextSession.user);',
    verifiedApply,
  );
  if (directProfileLoad >= 0 && directProfileLoad < signUpStart) return directProfileLoad;

  const reconcileStart = source.indexOf(
    'await reconcileInitialSessionProfile({',
    verifiedApply,
  );
  if (reconcileStart < 0 || reconcileStart >= signUpStart) return -1;

  const loadProfile = source.indexOf('loadProfileWithDeadline(', reconcileStart);
  const hasProfile = source.indexOf('hasProfile:', reconcileStart);
  const identityCheck = source.indexOf('isSessionCurrent:', reconcileStart);
  const reconcileEnd = source.indexOf('});', reconcileStart);
  if (
    loadProfile < 0
    || hasProfile < 0
    || identityCheck < 0
    || reconcileEnd < 0
    || loadProfile > reconcileEnd
    || hasProfile > reconcileEnd
    || identityCheck > reconcileEnd
    || reconcileEnd >= signUpStart
  ) return -1;

  return reconcileEnd;
}

function hasVerifiedSignInGate(source) {
  const callbackStart = source.indexOf('getSupabase().auth.onAuthStateChange(');
  const callbackGuard = source.indexOf('if (signingInRef.current && next) return;', callbackStart);
  const callbackApply = source.indexOf('applySession(next);', callbackStart);

  const signInStart = source.indexOf('async signIn(loginName, password) {');
  const signUpStart = source.indexOf('async signUp(loginName, password) {', signInStart);
  const barrierStart = source.indexOf('signingInRef.current = true;', signInStart);
  const verifiedSession = firstIndexAfter(source, [
    'const nextSession = await signInWithSupabase(name, password);',
    'authenticatedSession = await signInWithSupabase(name, password);',
  ], signInStart);
  const verifiedApply = firstIndexAfter(source, [
    'applySession(nextSession);',
    'applySession(authenticatedSession);',
  ], verifiedSession);
  const profileCompletion = profileVerificationCompletion(source, verifiedApply, signUpStart);
  const barrierRelease = source.indexOf('signingInRef.current = false;', verifiedApply);

  return callbackStart >= 0
    && callbackGuard > callbackStart
    && callbackApply > callbackGuard
    && signInStart >= 0
    && signUpStart > signInStart
    && barrierStart > signInStart
    && barrierStart < verifiedSession
    && verifiedSession < verifiedApply
    && verifiedApply < profileCompletion
    && profileCompletion < barrierRelease
    && barrierRelease < signUpStart;
}

for (const [name, source] of [
  ['verified sign-in gate', `
    const signingInRef = useRef(false);
    getSupabase().auth.onAuthStateChange((_event, next) => {
      if (signingInRef.current && next) return;
      applySession(next);
    });
    async signIn(loginName, password) {
      signingInRef.current = true;
      try {
        const nextSession = await signInWithSupabase(name, password);
        applySession(nextSession);
        await loadProfileWithDeadline(nextSession.user);
      } finally {
        signingInRef.current = false;
      }
    },
    async signUp(loginName, password) {}
  `],
  ['verified recoverable profile reconciliation gate', `
    const signingInRef = useRef(false);
    getSupabase().auth.onAuthStateChange((_event, next) => {
      if (signingInRef.current && next) return;
      applySession(next);
    });
    async signIn(loginName, password) {
      signingInRef.current = true;
      let authenticatedSession = null;
      try {
        authenticatedSession = await signInWithSupabase(name, password);
        applySession(authenticatedSession);
        await reconcileInitialSessionProfile({
          loadProfile: () => loadProfileWithDeadline(authenticatedSession.user, { force: true }),
          hasProfile: () => profileRef.current !== null,
          isSessionCurrent: () => sessionRef.current?.user.id === authenticatedSession.user.id,
        });
      } finally {
        signingInRef.current = false;
      }
    },
    async signUp(loginName, password) {}
  `],
]) {
  assert(hasVerifiedSignInGate(source), `fixture must accept ${name}`);
}

for (const [name, source] of [
  ['missing auth event gate', `
    const signingInRef = useRef(false);
    getSupabase().auth.onAuthStateChange((_event, next) => {
      applySession(next);
    });
    async signIn(loginName, password) {
      signingInRef.current = true;
      try {
        const nextSession = await signInWithSupabase(name, password);
        applySession(nextSession);
        await loadProfileWithDeadline(nextSession.user);
      } finally {
        signingInRef.current = false;
      }
    },
    async signUp(loginName, password) {}
  `],
  ['gate raised after verification starts', `
    const signingInRef = useRef(false);
    getSupabase().auth.onAuthStateChange((_event, next) => {
      if (signingInRef.current && next) return;
      applySession(next);
    });
    async signIn(loginName, password) {
      const nextSession = await signInWithSupabase(name, password);
      signingInRef.current = true;
      applySession(nextSession);
      await loadProfileWithDeadline(nextSession.user);
      signingInRef.current = false;
    },
    async signUp(loginName, password) {}
  `],
  ['gate released before profile completion', `
    const signingInRef = useRef(false);
    getSupabase().auth.onAuthStateChange((_event, next) => {
      if (signingInRef.current && next) return;
      applySession(next);
    });
    async signIn(loginName, password) {
      signingInRef.current = true;
      const nextSession = await signInWithSupabase(name, password);
      applySession(nextSession);
      signingInRef.current = false;
      await loadProfileWithDeadline(nextSession.user);
    },
    async signUp(loginName, password) {}
  `],
  ['gate released before recoverable profile reconciliation completes', `
    const signingInRef = useRef(false);
    getSupabase().auth.onAuthStateChange((_event, next) => {
      if (signingInRef.current && next) return;
      applySession(next);
    });
    async signIn(loginName, password) {
      signingInRef.current = true;
      let authenticatedSession = null;
      authenticatedSession = await signInWithSupabase(name, password);
      applySession(authenticatedSession);
      signingInRef.current = false;
      await reconcileInitialSessionProfile({
        loadProfile: () => loadProfileWithDeadline(authenticatedSession.user, { force: true }),
        hasProfile: () => profileRef.current !== null,
        isSessionCurrent: () => sessionRef.current?.user.id === authenticatedSession.user.id,
      });
    },
    async signUp(loginName, password) {}
  `],
]) {
  assert(!hasVerifiedSignInGate(source), `fixture must reject ${name}`);
}

assert(auth.includes('const signingInRef = useRef(false);'), 'auth provider must track an explicit sign-in verification barrier');
assert(
  hasVerifiedSignInGate(auth),
  'SIGNED_IN events must stay hidden until getUser verification and profile loading complete',
);

const helperStart = auth.indexOf('async function signInWithSupabase(loginName: string, password: string)');
const passwordSignIn = auth.indexOf('await client.auth.signInWithPassword({', helperStart);
const getUser = auth.indexOf('await client.auth.getUser();', passwordSignIn);
const returnSession = auth.indexOf('return data.session;', getUser);
assert(
  helperStart >= 0 && passwordSignIn > helperStart && getUser > passwordSignIn && returnSession > getUser,
  'password sign-in must verify the server-side user before returning the session',
);

console.log('[staging-signin-verification-gate-contract] explicit sign-in blocks early auth-state exposure until token verification and finite profile verification/reconciliation complete');
