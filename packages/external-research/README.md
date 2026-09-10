# External Research Provenance Foundation

This package is an isolated metadata-ingestion foundation. It does not bind to Research Center, Strategy Health, Shadow, Natural Paper, Paper scheduling/runtime, Backtester, strategy generation, execution, trading, or Production.

## Audit and reuse decision

The repository already contains `market-prediction-lab/src/global-alpha-literature-registry-v1.js`. That module owns downstream literature evidence, strategy-family fields, replication trials, and execution-safety flags. Its lowercase DOI normalization and SHA-256 digest principles are compatible with this package, but its contract is coupled to Prediction Lab and active stacked Draft PRs #543/#544. Importing or editing it would create the cross-domain binding this slice forbids.

`@workspace/external-research` therefore owns only provider metadata normalization and `ResearchPaperV2`. It has no import from, export to, or registration in Prediction Lab. A future integration must be a separately approved slice.

## Provider policy snapshot

Verified against official provider documentation on 2026-08-24. Runtime clients are intentionally out of scope; the adapters accept already retrieved public metadata and require an HTTPS public request URL plus an explicit retrieval timestamp.

| Provider | Public API policy applied | Metadata/content license handling | Integrity handling |
| --- | --- | --- | --- |
| Crossref | Public anonymous REST only; obey response rate/concurrency headers, back off on 429; conservative public caps are 5 single-record requests/s and 1 list request/s | Bibliographic facts/Crossref-generated metadata are public-domain/CC0; deposited content licenses are preserved separately and never treated as metadata licenses | Structured `updated-by`/`update-to` correction, retraction, concern, and reinstatement evidence only |
| Semantic Scholar | Public unauthenticated Academic Graph endpoints only; API keys/credentials are forbidden in this package; anonymous capacity is shared and may be throttled | API use is terms-governed and attribution is required; `openAccessPdf.license` is preserved with `verificationRequired=true` because the source license/copyright must be checked | The documented paper response has no canonical correction/retraction status, so both states remain `UNKNOWN` |
| arXiv | Legacy metadata API only; at most one request every three seconds and one connection; callers should cache same-day query results | Descriptive metadata is CC0 1.0; the Atom response does not expose the per-version e-print content license, so content license remains `UNKNOWN` | Withdrawal/replacement creates a version, but the Atom API has no structured withdrawal flag; title/comment guessing is forbidden, so integrity states remain `UNKNOWN` |

Official references:

- Crossref [REST API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/), [access and request limits](https://www.crossref.org/documentation/retrieve-metadata/rest-api/access-and-authentication/), [metadata licensing](https://www.crossref.org/documentation/retrieve-metadata/), and [Retraction Watch fields](https://www.crossref.org/documentation/retrieve-metadata/retraction-watch/)
- Semantic Scholar [Academic Graph API](https://api.semanticscholar.org/api-docs/), [public access/rates](https://www.semanticscholar.org/product/api), and [API License Agreement](https://www.semanticscholar.org/product/api/license)
- arXiv [API manual](https://info.arxiv.org/help/api/user-manual.html), [API Terms of Use](https://info.arxiv.org/help/api/tou.html), [license policy](https://info.arxiv.org/help/license/index.html), [version policy](https://info.arxiv.org/help/versions.html), and [withdrawal policy](https://info.arxiv.org/help/withdraw.html)

## `ResearchPaperV2`

The runtime contract requires every candidate field plus `schemaVersion: 2`. Null is used only for explicit unknown/unsupported optional identifiers or version values; required title, authors, publication time, provider record identity, public request provenance, and hashes may not be missing.

- `paperId`: `doi:<normalized-doi>` first, then `arxiv:<base-id>`, then a provider-scoped stable record ID.
- `publishedAt`: preserves provider precision (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`, or a UTC timestamp). Missing month/day are never invented.
- `version`: separates work version, provider-record version, and provider update time.
- `correctionState` / `retractionState`: explicit state plus structured evidence. Absence of a provider field is `UNKNOWN`, never `NONE`.
- `license`: separates the provider metadata license/terms from the paper-content license.
- `provenance.sourceHash`: SHA-256 over canonical JSON of the exact parsed provider payload supplied to the adapter. For arXiv this is the parsed Atom entry, not XML bytes.
- `metadataHash`: SHA-256 over normalized semantic metadata plus stable provider identity, adapter, field-source, policy, and `sourceHash` provenance. Retrieval time and transport URL are excluded so an unchanged payload is stable across retrievals while provenance tampering is still detected.

## Identity and dedupe

DOIs are lowercased after resolver/prefix removal. arXiv IDs accept modern and legacy forms, store a versionless base ID, and preserve `vN` separately. Dedupe groups retain every provider record and provenance; they do not merge or discard metadata. A shared strong identity accompanied by conflicting DOI or arXiv values fails closed as `PAPER_IDENTITY_CONFLICT`. Titles/authors are never used for fuzzy identity.

## Validation

`assertResearchPaperV2` rejects unknown top-level fields, malformed/uncanonical identifiers, non-public request provenance, invalid partial dates, unsupported states, inconsistent license state, and any metadata-hash mismatch. `verifyResearchPaperV2` is the boolean wrapper for read-only checks.

Run the isolated unit suite with:

```bash
pnpm --dir packages/external-research test
```
