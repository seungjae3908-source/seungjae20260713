let activeQuerySignal: AbortSignal | undefined;

export function withActiveQuerySignal<Result>(
  signal: AbortSignal,
  execute: () => Result,
): Result {
  const previous = activeQuerySignal;
  activeQuerySignal = signal;
  try {
    return execute();
  } finally {
    activeQuerySignal = previous;
  }
}

export function getActiveQuerySignal(): AbortSignal | undefined {
  return activeQuerySignal;
}
