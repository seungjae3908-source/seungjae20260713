export const LEARN_PROGRESS_STORAGE_KEY = 'investment-learn-progress-v1';

export type LearnProgress = {
  schemaVersion: 1;
  completedTopicIds: string[];
  updatedAt: string;
};

export function normalizeLearnProgress(value: unknown, validTopicIds: readonly string[]): LearnProgress {
  const valid = new Set(validTopicIds);
  const row = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const raw = Array.isArray(row.completedTopicIds) ? row.completedTopicIds : [];
  const completedTopicIds = [...new Set(raw
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => valid.has(item)))];
  const updatedAt = typeof row.updatedAt === 'string' && Number.isFinite(Date.parse(row.updatedAt))
    ? row.updatedAt
    : new Date(0).toISOString();
  return { schemaVersion: 1, completedTopicIds, updatedAt };
}

export function readLearnProgress(
  storage: Pick<Storage, 'getItem'> | null,
  validTopicIds: readonly string[],
): LearnProgress {
  if (!storage) return normalizeLearnProgress(null, validTopicIds);
  try {
    const raw = storage.getItem(LEARN_PROGRESS_STORAGE_KEY);
    return normalizeLearnProgress(raw ? JSON.parse(raw) : null, validTopicIds);
  } catch {
    return normalizeLearnProgress(null, validTopicIds);
  }
}

export function writeLearnProgress(
  storage: Pick<Storage, 'setItem'> | null,
  completedTopicIds: readonly string[],
  validTopicIds: readonly string[],
  now = new Date(),
): LearnProgress {
  const normalized = normalizeLearnProgress({
    completedTopicIds: [...completedTopicIds],
    updatedAt: now.toISOString(),
  }, validTopicIds);
  const value = { ...normalized, updatedAt: now.toISOString() };
  try {
    storage?.setItem(LEARN_PROGRESS_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Progress is optional local UX state. A blocked storage surface must not break learning.
  }
  return value;
}

export function toggleLearnTopic(
  current: readonly string[],
  topicId: string,
  validTopicIds: readonly string[],
): string[] {
  const valid = new Set(validTopicIds);
  if (!valid.has(topicId)) return [...current];
  const next = new Set(current);
  if (next.has(topicId)) next.delete(topicId);
  else next.add(topicId);
  return [...next];
}
