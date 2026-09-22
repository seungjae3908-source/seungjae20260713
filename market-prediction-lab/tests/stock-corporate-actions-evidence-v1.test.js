import test from "node:test";
import assert from "node:assert/strict";

import {
  createStockCorporateActionsEvidenceV1,
} from "../src/stock-corporate-actions-evidence-v1.js";

const H=(x)=>x.repeat(64);
const START=Date.UTC(2025,0,1);
const END=Date.UTC(2025,11,31);

function evidence(overrides={}){
  return {
    market:"US_STOCK",
    sourceKind:"OFFICIAL_CORPORATE_ACTION_HISTORY",
    sourceId:"official:exchange-actions",
    sourceDigest:H("a"),
    observedAt:"2026-09-20T00:00:00.000Z",
    coverageStartTime:START,
    coverageEndTime:END,
    complete:true,
    pointInTimeMode:"EVENT_TIME_ONLY",
    symbols:[
      {
        symbol:"AAPL",
        sourceId:"official:exchange-actions",
        complete:true,
        coverageStartTime:START,
        coverageEndTime:END,
        events:[
          {
            actionId:"AAPL:split:2025-06-01",
            symbol:"AAPL",
            actionType:"STOCK_SPLIT",
            knownAt:Date.UTC(2025,4,1),
            effectiveTime:Date.UTC(2025,5,1),
            eventDigest:H("b"),
            sourceId:"official:exchange-actions",
          },
        ],
      },
      {
        symbol:"MSFT",
        sourceId:"official:exchange-actions",
        complete:true,
        coverageStartTime:START,
        coverageEndTime:END,
        events:[],
      },
    ],
    ...overrides,
  };
}

test("official complete sparse ledger produces immutable corporate-action evidence",()=>{
  const result=createStockCorporateActionsEvidenceV1(evidence());
  assert.equal(result.contract,"stock-corporate-actions-evidence/v1");
  assert.equal(result.market,"US_STOCK");
  assert.equal(result.complete,true);
  assert.equal(result.symbols.length,2);
  assert.equal(result.symbols[0].events.length,1);
  assert.equal(result.symbols[1].events.length,0);
  assert.equal(result.safeguards.futureActionBackAdjustmentAllowed,false);
  assert.equal(result.safeguards.syntheticCorporateActionsAllowed,false);
  assert.equal(result.safeguards.executionAuthority,"NONE");
  assert.match(result.evidenceDigest,/^[0-9a-f]{64}$/);
});

test("non-official or incomplete corporate-action source is rejected",()=>{
  assert.throws(()=>createStockCorporateActionsEvidenceV1(evidence({
    sourceKind:"GENERATED_HISTORY",
  })),/OFFICIAL_CORPORATE_ACTION_HISTORY_SOURCE_REQUIRED/);
  assert.throws(()=>createStockCorporateActionsEvidenceV1(evidence({
    complete:false,
  })),/COMPLETENESS_REQUIRED/);
  const bad=evidence();
  bad.symbols[1].complete=false;
  assert.throws(()=>createStockCorporateActionsEvidenceV1(bad),/SYMBOL_COMPLETENESS_REQUIRED/);
});

test("future-known action cannot be applied at an earlier historical effective time",()=>{
  const bad=evidence();
  bad.symbols[0].events[0].knownAt=Date.UTC(2025,6,1);
  bad.symbols[0].events[0].effectiveTime=Date.UTC(2025,5,1);
  assert.throws(()=>createStockCorporateActionsEvidenceV1(bad),/FUTURE_KNOWLEDGE_FORBIDDEN/);
});

test("event outside coverage, duplicate id, and unsorted events fail closed",()=>{
  const outside=evidence();
  outside.symbols[0].events[0].effectiveTime=END+86400000;
  assert.throws(()=>createStockCorporateActionsEvidenceV1(outside),/OUTSIDE_COVERAGE/);

  const duplicate=evidence();
  duplicate.symbols[0].events.push({...duplicate.symbols[0].events[0]});
  assert.throws(()=>createStockCorporateActionsEvidenceV1(duplicate),/DUPLICATE_ID/);

  const unordered=evidence();
  unordered.symbols[0].events=[
    {
      actionId:"AAPL:z",
      symbol:"AAPL",
      actionType:"CASH_DIVIDEND",
      knownAt:Date.UTC(2025,7,1),
      effectiveTime:Date.UTC(2025,8,1),
      eventDigest:H("c"),
      sourceId:"official:exchange-actions",
    },
    {
      actionId:"AAPL:a",
      symbol:"AAPL",
      actionType:"STOCK_DIVIDEND",
      knownAt:Date.UTC(2025,3,1),
      effectiveTime:Date.UTC(2025,4,1),
      eventDigest:H("d"),
      sourceId:"official:exchange-actions",
    },
  ];
  assert.throws(()=>createStockCorporateActionsEvidenceV1(unordered),/EVENT_ORDER_INVALID/);
});

test("symbol rows must be sorted, exact-shape, and source-bound",()=>{
  const unsorted=evidence();
  unsorted.symbols=[unsorted.symbols[1],unsorted.symbols[0]];
  assert.throws(()=>createStockCorporateActionsEvidenceV1(unsorted),/SYMBOL_ORDER_INVALID/);

  const extra=evidence();
  extra.symbols[0].unexpected=true;
  assert.throws(()=>createStockCorporateActionsEvidenceV1(extra),/SYMBOL_ROW_SHAPE_INVALID/);

  const sourceMismatch=evidence();
  sourceMismatch.symbols[0].sourceId="other";
  assert.throws(()=>createStockCorporateActionsEvidenceV1(sourceMismatch),/SYMBOL_SOURCE_MISMATCH/);
});


test("complete corporate-action coverage cannot extend beyond observedAt",()=>{
  const future=evidence({
    observedAt:"2025-06-01T00:00:00.000Z",
  });
  assert.throws(
    ()=>createStockCorporateActionsEvidenceV1(future),
    /CORPORATE_ACTION_FUTURE_COVERAGE_FORBIDDEN/,
  );
});


test("canonical observedAt accepts whole-second UTC and rejects impossible dates",()=>{
  const accepted=createStockCorporateActionsEvidenceV1(evidence({
    observedAt:"2026-09-20T00:00:00Z",
  }));
  assert.equal(accepted.observedAt,"2026-09-20T00:00:00.000Z");

  assert.throws(()=>createStockCorporateActionsEvidenceV1(evidence({
    observedAt:"2026-02-30T00:00:00Z",
  })),/OBSERVED_AT_INVALID/);
});
