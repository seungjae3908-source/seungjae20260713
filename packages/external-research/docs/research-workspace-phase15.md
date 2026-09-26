# Phase15 one-shot human review readback

Phase15 adds a read-only human review surface for the server-private Phase12/14 one-shot result.

The API accepts no root/path from HTTP. It reads only RESEARCH_WORKSPACE_ONE_SHOT_ROOT from the effective API process, then validates the fixed manifest and current one-shot run directory with no-follow, same-UID, private-file and stable-stat checks.

Only sanitized reviewed material is exposed:
- Gemini model observations (kind, timestamp, short description),
- Groq adversarial verdict and reason for each observation,
- Groq summary/disposition and missing rule kinds,
- limitations,
- manifest/package/reviewed-rule-digest identities,
- provider call counts.

Raw Gemini/Groq provider responses, credentials, private filesystem paths, trading/account data and performance claims are never returned.

HUMAN_RULE_DIGEST_REVIEW is accepted only when the Phase12 package digest, Gemini receipt digest, Groq review digest and reviewedRuleDigestCandidate all recompute exactly and automatic adoption/profitability/trading authority remain false.

GEMINI_INSUFFICIENT_EVIDENCE is displayed separately as SOURCE_EVIDENCE_REVIEW_NO_RETRY with Gemini=1, Groq=0, no package digest and no rule-digest approval path.

The Research Center UI is read-only. It deliberately has no approve/compile/backtest button. ACCEPT_AS_CLAIM is rendered as structurally reviewable, not source truth. AI agreement is explicitly not profitability evidence.
