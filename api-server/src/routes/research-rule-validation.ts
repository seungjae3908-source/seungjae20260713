import type { RequestHandler } from 'express';
import { sanitizeRuleValidationReport, type RuleValidationReport } from '../services/rule-validation-report.service';
import { RULE_VALIDATION_SNAPSHOT } from '../services/rule-validation-report.snapshot';

// Shared research evidence only (same audience as /research/overview).
// Serves a validated, hand-recorded snapshot. It reads no account, member,
// order, file or network data, so there is nothing private to leak.
export const createRuleValidationHandler = (
  load: () => unknown = () => RULE_VALIDATION_SNAPSHOT,
): RequestHandler => (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Vary', 'Authorization, Cookie');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  let report: RuleValidationReport | null = null;
  try {
    report = sanitizeRuleValidationReport(load());
  } catch {
    report = null;
  }
  if (!report) {
    return void res.status(503).json({
      error: 'RULE_VALIDATION_UNAVAILABLE',
      message: '규칙 검증 결과를 불러오지 못했습니다.',
      executionAuthority: 'NONE',
    });
  }
  res.json(report);
};
