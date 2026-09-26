export function isSearchRequestAbort(
  error: unknown,
  signal?: AbortSignal,
): boolean {
  if (signal?.aborted) {
    return true;
  }

  return error instanceof Error && error.name === 'AbortError';
}
