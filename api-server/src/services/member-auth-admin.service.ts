import { getSupabase, hasSupabaseServerKey } from '../lib/supabase';

export function memberPasswordResetAvailable() {
  return hasSupabaseServerKey();
}

export async function resetMemberPasswordCredential(targetUserId: string, temporaryPassword: string) {
  if (!memberPasswordResetAvailable()) {
    throw new Error('PASSWORD_RESET_UNAVAILABLE');
  }
  const { error } = await getSupabase().auth.admin.updateUserById(targetUserId, {
    password: temporaryPassword,
  });
  if (error) throw new Error('PASSWORD_RESET_FAILED');
}
