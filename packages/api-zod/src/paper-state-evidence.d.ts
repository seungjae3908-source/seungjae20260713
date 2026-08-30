export function validPaperState(value: unknown, latest?: number): boolean;
export function validPaperTimestamp(value: unknown, latest?: number): boolean;
export function validPaperRecord(kind: unknown, value: unknown, latest?: number): boolean;
export function validPaperJournal(value: unknown, latest?: number): boolean;
export function validPaperActionResult(value: unknown, previous: unknown, eventId: string, latest?: number): boolean;
