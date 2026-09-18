import { PaperTradingError } from './paper-trading-core.service';
import type { PaperTradingAction, PaperTradingState } from './paper-trading.types';
import {
  manualPaperEvidenceSha256,
  type ManualPaperCanonicalEvidence,
} from './manual-paper-canonical-contract.service';

export type ManualPaperCanonicalEvidenceSourceInput = Readonly<{
  authenticatedAccountId: string;
  candidateId: string | null;
  action: PaperTradingAction;
  state: PaperTradingState;
  nowMs: number;
}>;

export type ManualPaperCanonicalOwnerEvidencePacket = Omit<
  ManualPaperCanonicalEvidence,
  'authenticatedAccountId' | 'paperAccountId' | 'paperStateSha256'
>;

export type ManualPaperCanonicalOwnerStateReader = (
  input: Readonly<{
    authenticatedAccountId: string;
    candidateId: string;
    nowMs: number;
  }>,
) => Promise<PaperTradingState>;

export type ManualPaperCanonicalOwnerEvidenceReader = (
  input: Readonly<{
    authenticatedAccountId: string;
    candidateId: string;
    action: PaperTradingAction;
    ownerState: PaperTradingState;
    nowMs: number;
  }>,
) => Promise<ManualPaperCanonicalOwnerEvidencePacket | undefined>;

export type ManualPaperCanonicalEvidenceSource = (
  input: ManualPaperCanonicalEvidenceSourceInput,
) => Promise<ManualPaperCanonicalEvidence | undefined>;

function ownerUnavailable(code: string, message: string): never {
  throw new PaperTradingError(code, message, 503);
}

function assertServerOwnedPacket(packet: ManualPaperCanonicalOwnerEvidencePacket): void {
  const value = packet as ManualPaperCanonicalOwnerEvidencePacket & Record<string, unknown>;
  for (const key of ['authenticatedAccountId', 'paperAccountId', 'paperStateSha256']) {
    if (key in value) {
      throw new PaperTradingError(
        'CANONICAL_PAPER_OWNER_PACKET_SERVER_FIELD_FORBIDDEN',
        'Canonical Paper owner packet은 서버 readback binding 필드를 직접 지정할 수 없습니다.',
        409,
      );
    }
  }
}

/**
 * Compose the manual Paper consumer from two already-owned read-only sources:
 * the immutable authenticated Paper-state readback and a genuine owner evidence
 * packet. This service never issues validation/OOS receipts, cost evidence or
 * candidate authority. Missing owner data remains missing and fails closed.
 */
export function createManualPaperCanonicalEvidenceSource(
  dependencies: Readonly<{
    readPaperState: ManualPaperCanonicalOwnerStateReader;
    readOwnerEvidence: ManualPaperCanonicalOwnerEvidenceReader;
  }>,
): ManualPaperCanonicalEvidenceSource {
  if (typeof dependencies?.readPaperState !== 'function') {
    throw new TypeError('manual Paper canonical owner state reader is required');
  }
  if (typeof dependencies?.readOwnerEvidence !== 'function') {
    throw new TypeError('manual Paper canonical genuine owner evidence reader is required');
  }

  return async (input) => {
    if (input.candidateId === null) return undefined;
    if (!input.authenticatedAccountId) {
      throw new PaperTradingError(
        'CANONICAL_PAPER_AUTHENTICATED_ACCOUNT_REQUIRED',
        'Canonical Paper owner evidence에는 인증 계정 binding이 필요합니다.',
        401,
      );
    }
    if (!Number.isSafeInteger(input.nowMs) || input.nowMs <= 0) {
      throw new PaperTradingError(
        'CANONICAL_PAPER_OWNER_CLOCK_INVALID',
        'Canonical Paper owner readback 시각이 올바르지 않습니다.',
        409,
      );
    }

    let ownerState: PaperTradingState;
    try {
      ownerState = await dependencies.readPaperState({
        authenticatedAccountId: input.authenticatedAccountId,
        candidateId: input.candidateId,
        nowMs: input.nowMs,
      });
    } catch {
      ownerUnavailable(
        'CANONICAL_PAPER_OWNER_STATE_READBACK_UNAVAILABLE',
        '검증된 Canonical Paper state readback을 확인할 수 없습니다.',
      );
    }

    const requestStateDigest = manualPaperEvidenceSha256(input.state);
    const ownerStateDigest = manualPaperEvidenceSha256(ownerState);
    if (!ownerState?.account?.id
      || ownerState.account.id !== input.state.account?.id
      || ownerStateDigest !== requestStateDigest) {
      throw new PaperTradingError(
        'CANONICAL_PAPER_OWNER_STATE_READBACK_REQUIRED',
        '요청 Paper state가 인증 owner readback과 정확히 일치하지 않습니다.',
        409,
      );
    }

    let packet: ManualPaperCanonicalOwnerEvidencePacket | undefined;
    try {
      packet = await dependencies.readOwnerEvidence({
        authenticatedAccountId: input.authenticatedAccountId,
        candidateId: input.candidateId,
        action: input.action,
        ownerState: structuredClone(ownerState),
        nowMs: input.nowMs,
      });
    } catch (error) {
      if (error instanceof PaperTradingError) throw error;
      ownerUnavailable(
        'CANONICAL_PAPER_OWNER_EVIDENCE_SOURCE_UNAVAILABLE',
        'Canonical Paper genuine owner evidence를 확인할 수 없습니다.',
      );
    }
    if (!packet) {
      ownerUnavailable(
        'CANONICAL_PAPER_OWNER_EVIDENCE_SOURCE_UNAVAILABLE',
        'Canonical Paper genuine owner evidence가 아직 발행되지 않았습니다.',
      );
    }
    assertServerOwnedPacket(packet);

    return Object.freeze({
      authenticatedAccountId: input.authenticatedAccountId,
      paperAccountId: ownerState.account.id,
      paperStateSha256: ownerStateDigest,
      candidate: structuredClone(packet.candidate),
      position: structuredClone(packet.position),
      entryCostEvidence: structuredClone(packet.entryCostEvidence),
      validationReceipt: structuredClone(packet.validationReceipt),
      receiptVerification: structuredClone(packet.receiptVerification),
      ...(packet.settlement ? { settlement: structuredClone(packet.settlement) } : {}),
    });
  };
}

/**
 * Default product wiring while the genuine validation/OOS issuer/readback owner
 * is absent. Preserve the existing public API error while making the missing
 * server owner source an explicit route dependency. Non-canonical Paper is
 * unaffected and no client-supplied authority is accepted.
 */
export const unavailableManualPaperCanonicalEvidenceSource: ManualPaperCanonicalEvidenceSource = async (input) => {
  if (input.candidateId === null) return undefined;
  throw new PaperTradingError(
    'SERVER_OWNED_CANONICAL_PAPER_EVIDENCE_REQUIRED',
    'Canonical Paper evidence가 누락되거나 동일 candidate와 일치하지 않습니다.',
    400,
  );
};
