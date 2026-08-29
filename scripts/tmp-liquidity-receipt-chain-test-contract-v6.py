from pathlib import Path

p = Path('market-intelligence-sidecar/tests/public-forward-liquidity-independence-audit.test.mjs')
s = p.read_text()
s = s.replace(
    "assert.ok(mismatchResult.blockers.includes('UPSTREAM_RECEIPT_DATASET_DIGEST_MISMATCH'));",
    "assert.ok(mismatchResult.blockers.includes('UPSTREAM_RECEIPT_CHAIN_FINAL_DATASET_DIGEST_MISMATCH'));",
    1,
)
s = s.replace(
    "    upstreamIngestReceiptRequired: true,\n    collectorImplementationBlobRequired: true,",
    "    upstreamIngestReceiptRequired: true,\n    completeIngestReceiptChainRequired: true,\n    collectorImplementationBlobRequired: true,",
    1,
)
p.write_text(s)
