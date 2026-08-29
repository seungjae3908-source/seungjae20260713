from pathlib import Path
import re


def once(text, old, new, label):
    if new in text:
        return text
    if old not in text:
        raise SystemExit(f"{label}: anchor missing")
    return text.replace(old, new, 1)


p = Path("market-intelligence-sidecar/src/public-forward-liquidity-independence-audit.mjs")
s = p.read_text()
s = once(
    s,
    "} from './public-forward-liquidity-capture-ingest.mjs';\n",
    "} from './public-forward-liquidity-capture-ingest.mjs';\nimport {\n  verifyPublicForwardLiquidityIngestReceiptChain,\n} from './public-forward-liquidity-ingest-receipt-chain.mjs';\n",
    "source import",
)
s = once(
    s,
    "  upstreamIngestReceiptRequired: true,\n",
    "  upstreamIngestReceiptRequired: true,\n  completeIngestReceiptChainRequired: true,\n",
    "source safety",
)
s = once(
    s,
    "  const receipt = object(source.ingestReceipt, 'UPSTREAM_INGEST_RECEIPT_INVALID');\n",
    "  const ingestReceipts = Array.isArray(source.ingestReceipts)\n    ? source.ingestReceipts\n    : [object(source.ingestReceipt, 'UPSTREAM_INGEST_RECEIPT_INVALID')];\n  const datasetRelativePath = safeRelativePath(source.datasetRelativePath);\n  const receiptChain = verifyPublicForwardLiquidityIngestReceiptChain({\n    dataset,\n    ingestReceipts,\n    datasetRelativePath,\n    collectorImplementationPath: COLLECTOR_IMPLEMENTATION_PATH,\n  });\n  const receipt = object(ingestReceipts.at(-1), 'UPSTREAM_INGEST_RECEIPT_INVALID');\n",
    "source chain bootstrap",
)
legacy = "  const datasetRelativePath = safeRelativePath(source.datasetRelativePath);\n  if (safeRelativePath(receipt.datasetRelativePath) !== datasetRelativePath) {\n"
if s.count(legacy) > 1:
    idx = s.rfind(legacy)
    s = s[:idx] + "  if (safeRelativePath(receipt.datasetRelativePath) !== datasetRelativePath) {\n" + s[idx + len(legacy):]
elif s.count(legacy) == 1:
    idx = s.find(legacy)
    if idx > s.find("if (receipt.schemaVersion"):
        s = s[:idx] + "  if (safeRelativePath(receipt.datasetRelativePath) !== datasetRelativePath) {\n" + s[idx + len(legacy):]
if "UPSTREAM_COLLECTOR_IMPLEMENTATION_CHAIN_MISMATCH" not in s:
    pat = re.compile(
        r"(  const collectorImplementationBlobSha = exactSha\(\n"
        r"    receipt\.collectorImplementationBlobSha,\n"
        r"    'UPSTREAM_COLLECTOR_IMPLEMENTATION_BLOB_INVALID',\n"
        r"  \);\n)"
    )
    repl = (
        r"\1"
        "  if (collectorImplementationBlobSha !== receiptChain.collectorImplementationBlobSha) {\n"
        "    throw new Error('UPSTREAM_COLLECTOR_IMPLEMENTATION_CHAIN_MISMATCH');\n"
        "  }\n"
    )
    s, n = pat.subn(repl, s, count=1)
    if n != 1:
        raise SystemExit("source blob regex missing")
s = once(
    s,
    "    collectorImplementationBlobSha,\n    datasetDigest,\n",
    "    collectorImplementationBlobSha,\n    ingestReceiptChainVersion: receiptChain.schemaVersion,\n    ingestReceiptChainDigest: receiptChain.receiptChainDigest,\n    ingestReceiptCount: receiptChain.receiptCount,\n    ingestReceiptDigests: receiptChain.receiptDigests,\n    artifactIds: receiptChain.artifactIds,\n    artifactDigests: receiptChain.artifactDigests,\n    rawBatchDigests: receiptChain.rawBatchDigests,\n    datasetDigest,\n",
    "source identity chain",
)
s = once(
    s,
    "  for (const key of ['sourceIdentity', 'receiptDigest', 'datasetDigest', 'artifactId']) {\n",
    "  for (const key of ['sourceIdentity', 'ingestReceiptChainDigest', 'receiptDigest', 'datasetDigest', 'artifactId']) {\n",
    "source duplicate key",
)
s = once(
    s,
    "    collectorImplementationBlobSha: source.collectorImplementationBlobSha,\n    datasetDigest: source.datasetDigest,\n",
    "    collectorImplementationBlobSha: source.collectorImplementationBlobSha,\n    ingestReceiptChainVersion: source.ingestReceiptChainVersion,\n    ingestReceiptChainDigest: source.ingestReceiptChainDigest,\n    ingestReceiptCount: source.ingestReceiptCount,\n    ingestReceiptDigests: source.ingestReceiptDigests,\n    artifactIds: source.artifactIds,\n    artifactDigests: source.artifactDigests,\n    rawBatchDigests: source.rawBatchDigests,\n    datasetDigest: source.datasetDigest,\n",
    "source summary chain",
)
p.write_text(s)

p = Path("market-intelligence-sidecar/scripts/run-public-forward-liquidity-independence-audit.mjs")
s = p.read_text()
s = s.replace(
    "It verifies #811 ingest-receipt bindings for one or more existing #776 canonical\n",
    "It verifies the complete ordered #811 ingest-receipt chain for one or more existing #776 canonical\n",
    1,
)
if "const receiptPaths = Array.isArray(source?.ingestReceiptPaths)" not in s:
    pat = re.compile(
        r"  for \(const source of manifest\.sources\) \{\n.*?\n  \}\n  return Object\.freeze\(\{ stateRoot, researchRepoRoot \}\);",
        re.S,
    )
    repl = """  for (const source of manifest.sources) {
    const receiptPaths = Array.isArray(source?.ingestReceiptPaths)
      ? source.ingestReceiptPaths
      : (typeof source?.ingestReceiptPath === 'string' ? [source.ingestReceiptPath] : []);
    if (!source || typeof source !== 'object' || Array.isArray(source)
      || typeof source.datasetPath !== 'string'
      || !isAbsolute(source.datasetPath)
      || receiptPaths.length === 0
      || receiptPaths.some((receiptPath) => typeof receiptPath !== 'string' || !isAbsolute(receiptPath))) {
      throw new Error('SOURCE_MANIFEST_ENTRY_INVALID');
    }
  }
  return Object.freeze({ stateRoot, researchRepoRoot });"""
    s, n = pat.subn(lambda _: repl, s, count=1)
    if n != 1:
        raise SystemExit("runner manifest regex missing")
if "ingestReceipt: ingestReceipts.at(-1)" not in s:
    pat = re.compile(
        r"  const sources = await Promise\.all\(manifest\.sources\.map\(async \(source\) => \{\n.*?\n  \}\)\);\n  return \{ manifest, sources \};",
        re.S,
    )
    repl = """  const sources = await Promise.all(manifest.sources.map(async (source) => {
    const receiptPaths = Array.isArray(source.ingestReceiptPaths)
      ? source.ingestReceiptPaths
      : [source.ingestReceiptPath];
    const [dataset, ingestReceipts] = await Promise.all([
      json(source.datasetPath),
      Promise.all(receiptPaths.map((receiptPath) => json(receiptPath))),
    ]);
    const datasetRelativePath = relative(stateRoot, resolve(source.datasetPath));
    if (!datasetRelativePath
      || isAbsolute(datasetRelativePath)
      || datasetRelativePath.split(/[\\/]+/u).some((segment) => segment === '..')) {
      throw new Error('SOURCE_DATASET_OUTSIDE_STATE_ROOT');
    }
    return {
      dataset,
      ingestReceipt: ingestReceipts.at(-1),
      ingestReceipts,
      datasetRelativePath: datasetRelativePath.replaceAll(String.fromCharCode(92), '/'),
    };
  }));
  return { manifest, sources };"""
    s, n = pat.subn(lambda _: repl, s, count=1)
    if n != 1:
        raise SystemExit("runner load regex missing")
p.write_text(s)

p = Path("market-intelligence-sidecar/tests/public-forward-liquidity-independence-audit.test.mjs")
s = p.read_text()
s = s.replace(
    "  return { dataset, ingestReceipt, datasetRelativePath };\n",
    "  return { dataset, ingestReceipt, ingestReceipts: [ingestReceipt], datasetRelativePath };\n",
    1,
)
if "function mergeBatchHistory(" not in s:
    marker = "function genuineDataset() {"
    helper = """function mergeBatchHistory(batches) {
  let dataset = null;
  const history = [];
  for (const current of batches) {
    dataset = mergeLiquidityCalibrationBatch(dataset, current).dataset;
    history.push(dataset);
  }
  return history;
}

function boundSourceChain(history, { artifactIdStart = 6000, collectorImplementationBlobSha = 'f'.repeat(40) } = {}) {
  const receipts = [];
  let previousIds = new Set();
  for (let index = 0; index < history.length; index += 1) {
    const dataset = history[index];
    const currentIds = dataset.observations.map((observation) => observation.observationId);
    const batchObservationIds = currentIds.filter((observationId) => !previousIds.has(observationId));
    const source = boundSource(dataset, {
      artifactId: String(artifactIdStart + index),
      batchObservationIds,
      collectorImplementationBlobSha,
    });
    receipts.push(source.ingestReceipt);
    previousIds = new Set(currentIds);
  }
  const finalDataset = history.at(-1);
  return {
    dataset: finalDataset,
    ingestReceipt: receipts.at(-1),
    ingestReceipts: receipts,
    datasetRelativePath: `forward/liquidity-calibration-v1/forward_natural_sample/${finalDataset.collectorCodeSha}/dataset.json`,
  };
}

"""
    if marker not in s:
        raise SystemExit("unit helper marker missing")
    s = s.replace(marker, helper + marker, 1)
if "function genuineDatasetHistory()" not in s:
    marker = "function policy() {"
    helper = """function genuineDatasetHistory() {
  return mergeBatchHistory([
    batch({
      base: 10_000,
      seed: 1,
      events: [
        { execId: 'exec-train-1', eventTimestampMs: 10_000, quantity: 1 },
        { execId: 'exec-train-2', eventTimestampMs: 10_050, quantity: 2 },
      ],
    }),
    batch({ base: 20_000, seed: 2, events: [{ execId: 'exec-validation', eventTimestampMs: 20_000, quantity: 1 }] }),
    batch({ base: 30_000, seed: 3, events: [{ execId: 'exec-oos', eventTimestampMs: 30_000, quantity: 1 }] }),
  ]);
}

"""
    if marker not in s:
        raise SystemExit("unit history marker missing")
    s = s.replace(marker, helper + marker, 1)
start = s.find("  const cumulativeDataset = genuineDataset();")
if start != -1:
    end_marker = "  assert.ok(brokenIndexResult.blockers.includes('UPSTREAM_BATCH_PROVENANCE_INDEX_MISMATCH'));\n"
    end = s.find(end_marker, start)
    if end == -1:
        raise SystemExit("unit cumulative end missing")
    end += len(end_marker)
    repl = """  const cumulative = boundSourceChain(genuineDatasetHistory(), { artifactIdStart: 4002 });
  const cumulativeResult = classifyPublicForwardLiquidityBoundSources({
    sources: [cumulative],
    producerCodeSha: 'd'.repeat(40),
  });
  assert.equal(cumulativeResult.status, 'PRESENT');
  assert.equal(cumulativeResult.audit.upstreamSources[0].ingestReceiptCount, 3);

  const missing = { ...cumulative, ingestReceipts: cumulative.ingestReceipts.slice(1) };
  const missingResult = classifyPublicForwardLiquidityBoundSources({ sources: [missing], producerCodeSha: 'd'.repeat(40) });
  assert.equal(missingResult.status, 'BLOCKED_DATA');
  assert.ok(missingResult.blockers.includes('UPSTREAM_INGEST_RECEIPT_CHAIN_LENGTH_MISMATCH'));

  const swapped = {
    ...cumulative,
    ingestReceipts: [cumulative.ingestReceipts[1], cumulative.ingestReceipts[0], cumulative.ingestReceipts[2]],
  };
  const swappedResult = classifyPublicForwardLiquidityBoundSources({ sources: [swapped], producerCodeSha: 'd'.repeat(40) });
  assert.equal(swappedResult.status, 'BLOCKED_DATA');
  assert.ok(swappedResult.blockers.includes('UPSTREAM_RECEIPT_BATCH_INDEX_MISMATCH'));
"""
    s = s[:start] + repl + s[end:]
p.write_text(s)

p = Path("market-intelligence-sidecar/tests/public-forward-liquidity-independence-runner-v2.test.mjs")
s = p.read_text()
if "function cumulativeHistory()" not in s:
    s = s.replace("function cumulativeDataset() {", "function cumulativeHistory() {", 1)
    s = s.replace(
        "  let dataset = null;\n  for (const [base, seed]",
        "  let dataset = null;\n  const history = [];\n  for (const [base, seed]",
        1,
    )
    s = s.replace(
        "    dataset = mergeLiquidityCalibrationBatch(dataset, batch(base, seed)).dataset;\n  }\n  return dataset;",
        "    dataset = mergeLiquidityCalibrationBatch(dataset, batch(base, seed)).dataset;\n    history.push(dataset);\n  }\n  return history;",
        1,
    )
    s = s.replace(
        "function ingestReceipt(dataset, datasetRelativePath) {",
        "function ingestReceipt(dataset, datasetRelativePath, batchObservationIds, artifactOffset) {",
        1,
    )
    s = re.sub(
        r"  const latestObservation = dataset\.observations\.find\(\(observation\) => observation\.eventTimestampMs === 30_000\);\n  const batchObservationIds = \[latestObservation\.observationId\];\n",
        "  const batchObservations = dataset.observations\n    .filter((observation) => batchObservationIds.includes(observation.observationId))\n    .sort((left, right) => left.observationId.localeCompare(right.observationId));\n",
        s,
        count=1,
    )
    s = s.replace("    captureRunId: '7001',", "    captureRunId: String(7001 + artifactOffset),", 1)
    s = s.replace(
        "    batchObservationIds,\n    batchObservationCount: 1,\n    batchObservationDigest: sha256(canonicalJson([latestObservation])),",
        "    batchObservationIds: [...batchObservationIds].sort(),\n    batchObservationCount: batchObservationIds.length,\n    batchObservationDigest: sha256(canonicalJson(batchObservations)),",
        1,
    )
    s = s.replace(
        "    artifactId: '8001',\n    artifactDigest: sha256('capture-artifact'),",
        "    artifactId: String(8001 + artifactOffset),\n    artifactDigest: sha256(`capture-artifact-${artifactOffset}`),",
        1,
    )
    s = s.replace(
        "    insertedObservationCount: 1,\n    duplicateObservationCount: 0,\n    rawIngestObservationDelta: 1,",
        "    insertedObservationCount: batchObservationIds.length,\n    duplicateObservationCount: 0,\n    rawIngestObservationDelta: batchObservationIds.length,",
        1,
    )
start = s.find("    const dataset = cumulativeDataset();")
if start != -1:
    end_marker = "    const source = { dataset, ingestReceipt: receipt, datasetRelativePath };\n"
    end = s.find(end_marker, start)
    if end == -1:
        raise SystemExit("runner happy end missing")
    end += len(end_marker)
    repl = """    const history = cumulativeHistory();
    const dataset = history.at(-1);
    const datasetPath = join(dataDir, 'dataset.json');
    const datasetRelativePath = 'forward/liquidity/dataset.json';
    const receiptPaths = [];
    const receipts = [];
    let previousIds = new Set();
    for (let index = 0; index < history.length; index += 1) {
      const current = history[index];
      const currentIds = current.observations.map((observation) => observation.observationId);
      const batchObservationIds = currentIds.filter((observationId) => !previousIds.has(observationId));
      const receipt = ingestReceipt(current, datasetRelativePath, batchObservationIds, index);
      const receiptPath = join(dataDir, `ingest-receipt-${index}.json`);
      await writeFile(receiptPath, `${canonicalJson(receipt)}\n`);
      receiptPaths.push(receiptPath);
      receipts.push(receipt);
      previousIds = new Set(currentIds);
    }
    await writeFile(datasetPath, `${canonicalJson(dataset)}\n`);

    const source = { dataset, ingestReceipt: receipts.at(-1), ingestReceipts: receipts, datasetRelativePath };
"""
    s = s[:start] + repl + s[end:]
s = s.replace(
    "      sources: [{ datasetPath, ingestReceiptPath: receiptPath }],",
    "      sources: [{ datasetPath, ingestReceiptPaths: receiptPaths }],",
    1,
)
p.write_text(s)
