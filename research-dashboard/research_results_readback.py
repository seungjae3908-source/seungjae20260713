"""Read-only summary of the research server's exploratory results.

The combination search, the exit-strategy comparison and the exploratory
forward paper ledger each write one ``latest/*.json`` file. Until now only the
Telegram digest read them. This module whitelists a bounded subset for the
app's Research Center. Nothing here grants promotion, Paper or order authority.
"""

import math
import re

COMBINATION_CONTRACT = 'combination-search-lane/v1'
EXIT_COMPARISON_CONTRACT = 'exit-strategy-comparison/v1'
EXPLORATORY_CONTRACT = 'exploratory-paper-ledger/v1'

LANE_ID_PATTERN = re.compile(r'^[A-Z][A-Z0-9_]{2,40}$')
TRIAL_ID_PATTERN = re.compile(r'^[A-Za-z0-9:_.-]{1,120}$')
SHORT_ID_PATTERN = re.compile(r'^[A-Za-z0-9_.-]{1,60}$')
SHA40_PATTERN = re.compile(r'^[0-9a-fA-F]{40}$')
LANE_STATUSES = frozenset({'SEARCHING', 'WAITING_FOR_DATA', 'COMPLETE', 'PENDING_NEXT_TICK'})
TRIAL_STATUSES = frozenset({'SURVIVOR', 'WATCH', 'REJECT'})
RULE_LIFECYCLES = frozenset({'ACTIVE', 'DEMOTED', 'RETIRED'})

MAX_LANES = 20
MAX_TOP_ROWS = 5
MAX_PAPER_CANDIDATES = 10
MAX_RULES = 20
MAX_LABELS = 6
MAX_LABEL_LENGTH = 80


def _count(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def _number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if math.isfinite(value) else None


def _text(value, pattern):
    return value if isinstance(value, str) and pattern.fullmatch(value) else None


def _labels(value):
    if not isinstance(value, list):
        return []
    labels = []
    for raw in value[:MAX_LABELS]:
        if isinstance(raw, str) and raw.strip():
            labels.append(raw.strip()[:MAX_LABEL_LENGTH])
    return labels


def _iso(value):
    return value if isinstance(value, str) and 10 <= len(value) <= 40 and value[:4].isdigit() else None


def _sha(value):
    return value.lower() if isinstance(value, str) and SHA40_PATTERN.fullmatch(value) else None


def _safety_ok(value, keys_false):
    if not isinstance(value, dict) or value.get('executionAuthority') != 'NONE':
        return False
    return all(value.get(key) is False for key in keys_false)


def _empty(status='MISSING'):
    return {'present': False, 'status': status, 'observedAt': None, 'researchSha': None}


def summarize_combination(value):
    if value is None:
        return {**_empty(), 'lanes': []}
    if not isinstance(value, dict) or value.get('contract') != COMBINATION_CONTRACT \
            or not _safety_ok(value.get('safety'), ('liveTrading', 'realOrder', 'paperActivationAllowed')) \
            or not isinstance(value.get('lanes'), list):
        return {**_empty('INVALID'), 'lanes': []}
    lanes = []
    for raw in value.get('lanes')[:MAX_LANES]:
        if not isinstance(raw, dict):
            continue
        lane_id = _text(raw.get('laneId'), LANE_ID_PATTERN)
        status = raw.get('status') if raw.get('status') in LANE_STATUSES else None
        if lane_id is None or status is None:
            continue
        top = []
        for row in (raw.get('top') if isinstance(raw.get('top'), list) else [])[:MAX_TOP_ROWS]:
            if not isinstance(row, dict) or row.get('finalStatus') not in TRIAL_STATUSES:
                continue
            validation = row.get('validation') if isinstance(row.get('validation'), dict) else {}
            holdout = row.get('holdout') if isinstance(row.get('holdout'), dict) else None
            top.append({
                'trialId': _text(row.get('trialId'), TRIAL_ID_PATTERN),
                'finalStatus': row.get('finalStatus'),
                'labels': _labels(row.get('labels')),
                'exitId': _text(row.get('exitId'), SHORT_ID_PATTERN),
                'qValue': _number(row.get('qValue')),
                'validationTrades': _count(validation.get('trades')),
                'validationMeanReturn': _number(validation.get('meanReturn')),
                'validationWinRate': _number(validation.get('winRate')),
                'beatsBaseline': row.get('beatsBaseline') is True,
                'holdoutChecked': holdout is not None,
                'holdoutPass': holdout.get('pass') is True if holdout else None,
            })
        candidates = []
        for row in (raw.get('paperCandidates') if isinstance(raw.get('paperCandidates'), list) else [])[:MAX_PAPER_CANDIDATES]:
            if not isinstance(row, dict):
                continue
            holdout = row.get('holdout') if isinstance(row.get('holdout'), dict) else {}
            result = holdout.get('result') if isinstance(holdout.get('result'), dict) else {}
            candidates.append({
                'trialId': _text(row.get('trialId'), TRIAL_ID_PATTERN),
                'labels': _labels(row.get('labels')),
                'exitId': _text(row.get('exitId'), SHORT_ID_PATTERN),
                'holdoutTrades': _count(result.get('trades')),
                'holdoutMeanReturn': _number(result.get('meanReturn')),
            })
        lanes.append({
            'laneId': lane_id,
            'status': status,
            'cumulativeTrials': _count(raw.get('cumulativeTrials', raw.get('trialsEvaluated'))),
            'survivors': _count(raw.get('survivors')),
            'watch': _count(raw.get('watch')),
            'rejected': _count(raw.get('rejected')),
            'holdoutUsed': _count(raw.get('holdoutUsed')),
            'holdoutBudget': _count(raw.get('holdoutBudget')),
            'paperCandidates': candidates,
            'top': top,
        })
    return {
        'present': True,
        'status': 'PRESENT',
        'observedAt': _iso(value.get('observedAt')),
        'researchSha': _sha(value.get('researchCodeSha')),
        'lanes': lanes,
    }


def summarize_exit_comparison(value):
    if value is None:
        return {**_empty(), 'lanes': []}
    if not isinstance(value, dict) or value.get('contract') != EXIT_COMPARISON_CONTRACT \
            or not isinstance(value.get('lanes'), list):
        return {**_empty('INVALID'), 'lanes': []}
    lanes = []
    for raw in value.get('lanes')[:MAX_LANES]:
        if not isinstance(raw, dict):
            continue
        lane_id = _text(raw.get('laneId'), LANE_ID_PATTERN)
        if lane_id is None:
            continue
        winners = []
        signal_sets = raw.get('signalSets') if isinstance(raw.get('signalSets'), list) else []
        for signal_set in signal_sets[:MAX_RULES]:
            if not isinstance(signal_set, dict):
                continue
            winner = signal_set.get('winner') if isinstance(signal_set.get('winner'), dict) else {}
            if winner.get('status') != 'WINNER':
                continue
            winners.append({
                'signalSetId': _text(signal_set.get('signalSetId'), SHORT_ID_PATTERN),
                'label': signal_set.get('label')[:MAX_LABEL_LENGTH] if isinstance(signal_set.get('label'), str) else None,
                'variantId': _text(winner.get('variantId'), SHORT_ID_PATTERN),
                'validationMeanR': _number(winner.get('validationMeanR')),
            })
        lanes.append({
            'laneId': lane_id,
            'status': raw.get('status') if raw.get('status') in LANE_STATUSES else 'UNKNOWN',
            'signalSetCount': len(signal_sets),
            'winners': winners,
        })
    return {
        'present': True,
        'status': 'PRESENT',
        'observedAt': _iso(value.get('observedAt')),
        'researchSha': _sha(value.get('researchCodeSha')),
        'lanes': lanes,
    }


def summarize_exploratory(value):
    empty_totals = {'trades': None, 'closed': None, 'open': None, 'promotionEligibleRules': None, 'demotedRules': None}
    if value is None:
        return {**_empty(), 'totals': empty_totals, 'rules': []}
    if not isinstance(value, dict) or value.get('contract') != EXPLORATORY_CONTRACT \
            or not _safety_ok(value.get('safety'), ('realOrder', 'automaticLiveFeed', 'formalCandidate')) \
            or not isinstance(value.get('rules'), list) or not isinstance(value.get('totals'), dict):
        return {**_empty('INVALID'), 'totals': empty_totals, 'rules': []}
    totals = value.get('totals')
    rules = []
    for raw in value.get('rules'):
        if not isinstance(raw, dict) or raw.get('lifecycle') not in RULE_LIFECYCLES:
            continue
        strict = raw.get('forwardStrict') if isinstance(raw.get('forwardStrict'), dict) else {}
        gap = raw.get('promotionGap') if isinstance(raw.get('promotionGap'), dict) else {}
        rules.append({
            'ruleId': _text(raw.get('ruleId'), TRIAL_ID_PATTERN),
            'laneId': _text(raw.get('laneId'), LANE_ID_PATTERN),
            'labels': _labels(raw.get('labels')),
            'lifecycle': raw.get('lifecycle'),
            'open': _count(raw.get('open')),
            'strictTrades': _count(strict.get('n')),
            'strictMeanR': _number(strict.get('mean')),
            'strictLower95': _number(strict.get('lower95')),
            'strictWinRate': _number(strict.get('winRate')),
            'promotionEligible': raw.get('promotionEligible') is True,
            'tradesNeeded': _count(gap.get('tradesNeeded')),
            'symbolsNeeded': _count(gap.get('symbolsNeeded')),
        })
    # Promotion-eligible rules first, then the most forward evidence.
    rules.sort(key=lambda row: (not row['promotionEligible'], -(row['strictTrades'] or 0)))
    return {
        'present': True,
        'status': 'PRESENT',
        'observedAt': _iso(value.get('observedAt')),
        'researchSha': None,
        'totals': {
            'trades': _count(totals.get('trades')),
            'closed': _count(totals.get('closed')),
            'open': _count(totals.get('open')),
            'promotionEligibleRules': _count(totals.get('promotionEligibleRules')),
            'demotedRules': _count(totals.get('demotedRules')),
        },
        'rules': rules[:MAX_RULES],
    }


def _read(root, name, summarize, read_json_optional):
    try:
        return summarize(read_json_optional(root / 'latest' / name))
    except (OSError, ValueError, RuntimeError):
        return summarize({'contract': None})


def read_research_results(root, read_json_optional):
    return {
        'combination': _read(root, 'combination-research-v1.json', summarize_combination, read_json_optional),
        'exitComparison': _read(root, 'exit-strategy-comparison-v1.json', summarize_exit_comparison, read_json_optional),
        'exploratory': _read(root, 'exploratory-paper-ledger-v1.json', summarize_exploratory, read_json_optional),
        'executionAuthority': 'NONE',
    }
