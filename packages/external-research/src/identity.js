import { deepFreeze } from './canonical-json.js';
import { assertResearchPaperV2 } from './contract.js';
import { fail } from './errors.js';

export function researchPaperIdentityKeys(paper) {
  assertResearchPaperV2(paper);
  const keys = [];
  if (paper.DOI) keys.push(`doi:${paper.DOI}`);
  if (paper.arXivId) keys.push(`arxiv:${paper.arXivId}`);
  keys.push(`provider:${paper.source.toLowerCase()}:${paper.provenance.providerRecordId}`);
  return Object.freeze([...new Set(keys)].sort());
}

export function compareResearchPaperIdentity(left, right) {
  assertResearchPaperV2(left);
  assertResearchPaperV2(right);
  const leftKeys = new Set(researchPaperIdentityKeys(left));
  const sharedKeys = researchPaperIdentityKeys(right).filter((key) => leftKeys.has(key));
  if (sharedKeys.length === 0) return deepFreeze({ status: 'DISTINCT', sharedKeys: [] });

  const conflicts = [];
  if (left.DOI && right.DOI && left.DOI !== right.DOI) conflicts.push('DOI');
  if (left.arXivId && right.arXivId && left.arXivId !== right.arXivId) conflicts.push('ARXIV_ID');
  if (conflicts.length > 0) return deepFreeze({ status: 'CONFLICT', sharedKeys, conflicts });
  return deepFreeze({ status: 'SAME', sharedKeys, conflicts: [] });
}

function preferredIdentityKey(records) {
  const keys = new Set(records.flatMap(researchPaperIdentityKeys));
  return [...keys].sort((left, right) => {
    const rank = (value) => value.startsWith('doi:') ? 0 : value.startsWith('arxiv:') ? 1 : 2;
    return rank(left) - rank(right) || left.localeCompare(right);
  })[0];
}

export function groupResearchPaperDuplicates(records) {
  if (!Array.isArray(records)) fail('RESEARCH_PAPER_LIST_INVALID');
  records.forEach(assertResearchPaperV2);
  const parent = records.map((_, index) => index);
  const find = (index) => parent[index] === index ? index : (parent[index] = find(parent[index]));
  const union = (left, right) => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent[b] = a;
  };

  for (let left = 0; left < records.length; left += 1) {
    for (let right = left + 1; right < records.length; right += 1) {
      const comparison = compareResearchPaperIdentity(records[left], records[right]);
      if (comparison.status === 'CONFLICT') {
        fail('PAPER_IDENTITY_CONFLICT', `PAPER_IDENTITY_CONFLICT:${comparison.conflicts.join(',')}`);
      }
      if (comparison.status === 'SAME') union(left, right);
    }
  }

  const grouped = new Map();
  records.forEach((record, index) => {
    const root = find(index);
    if (!grouped.has(root)) grouped.set(root, []);
    grouped.get(root).push(record);
  });
  return deepFreeze([...grouped.values()].map((group) => ({
    canonicalIdentity: preferredIdentityKey(group),
    identityKeys: [...new Set(group.flatMap(researchPaperIdentityKeys))].sort(),
    records: group,
  })));
}
