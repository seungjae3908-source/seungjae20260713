/**
 * An authenticated user switch must invalidate the previous user's member
 * capabilities before rendering the new identity. Refreshes of the same
 * user may retain the cached profile while a new read is in flight.
 */
export function shouldClearMemberProfileOnSessionChange(
  previousUserId: string | null,
  nextUserId: string | null,
): boolean {
  return previousUserId !== nextUserId;
}
