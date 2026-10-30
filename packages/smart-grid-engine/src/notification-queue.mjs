// notification-queue.mjs
// BLOCK 19 Step 7-Lite — 파일 기반 알림 큐 (네트워크 0건)
//
// 안전 원칙:
//   - 네트워크 호출 없음 (fs 경로만)
//   - 이벤트 순서 유지 (배열 append)
//   - eventId 중복 방지
//   - Atomic save (tmp + rename)
//   - 손상 파일 격리 (rename, 삭제 아님)

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const QUEUE_VERSION = 1;
export const STATUS = Object.freeze({
  PENDING: 'pending',
  DELIVERED_MOCK: 'delivered_mock',
  FAILED: 'failed',
});

export function createQueue() {
  return { version: QUEUE_VERSION, events: [] };
}

export function enqueueEvent(queue, event) {
  if (!queue || queue.version !== QUEUE_VERSION || !Array.isArray(queue.events)) {
    return { ok: false, reason: 'QUEUE_INVALID', queue };
  }
  if (!event || !event.eventId || !event.eventType) {
    return { ok: false, reason: 'EVENT_INVALID', queue };
  }
  if (queue.events.some((e) => e.eventId === event.eventId)) {
    return { ok: false, reason: 'DUPLICATE_EVENT_ID', duplicate: true, queue };
  }
  const stored = {
    ...event,
    status: STATUS.PENDING,
    addedAtMs: event.addedAtMs ?? Date.now(),
    processedAtMs: null,
    error: null,
  };
  return {
    ok: true,
    duplicate: false,
    event: stored,
    queue: { ...queue, events: [...queue.events, stored] },
  };
}

export function markDelivered(queue, eventId, nowMs = Date.now()) {
  const idx = queue.events.findIndex((e) => e.eventId === eventId);
  if (idx < 0) return { ok: false, reason: 'NOT_FOUND', queue };
  const events = queue.events.slice();
  events[idx] = { ...events[idx], status: STATUS.DELIVERED_MOCK, processedAtMs: nowMs };
  return { ok: true, event: events[idx], queue: { ...queue, events } };
}

export function markFailed(queue, eventId, error, nowMs = Date.now()) {
  const idx = queue.events.findIndex((e) => e.eventId === eventId);
  if (idx < 0) return { ok: false, reason: 'NOT_FOUND', queue };
  const events = queue.events.slice();
  events[idx] = {
    ...events[idx],
    status: STATUS.FAILED,
    processedAtMs: nowMs,
    error: error ?? 'UNKNOWN',
  };
  return { ok: true, event: events[idx], queue: { ...queue, events } };
}

export function getPending(queue) {
  return queue.events.filter((e) => e.status === STATUS.PENDING);
}

export function saveQueue(statePath, queue) {
  if (!statePath) return { saved: false, error: 'STATE_PATH_MISSING' };
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const tmp = `${statePath}.tmp.${Date.now()}.${randomUUID().slice(0, 8)}`;
    fs.writeFileSync(tmp, JSON.stringify(queue, null, 2), 'utf8');
    fs.renameSync(tmp, statePath);
    return { saved: true };
  } catch (err) {
    return { saved: false, error: err.message };
  }
}

function quarantineCorrupt(statePath) {
  try {
    const q = `${statePath}.corrupt.${Date.now()}.${randomUUID().slice(0, 8)}`;
    fs.renameSync(statePath, q);
    return { quarantined: true, path: q };
  } catch (err) {
    return { quarantined: false, error: err.message };
  }
}

export function loadQueueSafe(statePath) {
  if (!statePath) return { ok: true, queue: createQueue(), initialized: true };
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== QUEUE_VERSION || !Array.isArray(parsed.events)) {
      const q = quarantineCorrupt(statePath);
      return {
        ok: false, corrupt: true,
        quarantinePath: q.path || null,
        reason: 'VERSION_INVALID',
        queue: createQueue(),
      };
    }
    return { ok: true, queue: parsed };
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true, queue: createQueue(), initialized: true };
    const q = quarantineCorrupt(statePath);
    return {
      ok: false, corrupt: true,
      quarantinePath: q.path || null,
      reason: 'PARSE_ERROR',
      queue: createQueue(),
    };
  }
}

export function drainPending(queue, nowMs = Date.now()) {
  const delivered = [];
  const events = queue.events.map((e) => {
    if (e.status === STATUS.PENDING) {
      delivered.push(e);
      return { ...e, status: STATUS.DELIVERED_MOCK, processedAtMs: nowMs };
    }
    return e;
  });
  return { ok: true, delivered, queue: { ...queue, events } };
}
