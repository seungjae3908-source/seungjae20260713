import { createHash } from "node:crypto";

import {
  ADAPTIVE_TOURNAMENT_RUNTIME_BINDING_REQUIREMENTS_V1,
} from "./adaptive-multi-market-tournament-runtime-adapter-v1.js";
import {
  createResearchTournamentStageCheckpointCapabilityEvidenceV1,
} from "./research-tournament-stage-checkpoint-resume-v1.js";
import {
  CANDIDATE_GENERATOR_HARD_CAPS,
  SAFE_STRATEGY_HARD_LIMITS,
  createSafeStrategyDslV1,
  normalizeCandidateGenerationBudgetV1,
} from "./autonomous-strategy-formula-generator-v1.js";
import {
  BACKTESTER_ADAPTER_SAFETY,
  PR191_BACKTESTER_EVIDENCE_CONTRACT_V1,
} from "./backtester-strategy-evidence-adapter-v1.js";
import {
  runIndependentSignalBacktest,
} from "./independent-strategy-backtest.js";
import {
  computeCscvPbo,
  computeDeflatedSharpeRatio,
} from "./selection-bias-statistics.js";

export const ADAPTIVE_RUNTIME_OWNER_CAPABILITIES_CONTRACT_V1 =
  "adaptive-runtime-owner-capabilities/v1";

const SHA40=/^[0-9a-f]{40}$/u;
const HASH64=/^[0-9a-f]{64}$/u;

function canonical(value){
  if(Array.isArray(value)) return value.map(canonical);
  if(value===null||typeof value!=="object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
}
function digest(value){
  return createHash("sha256").update(JSON.stringify(canonical(value)),"utf8").digest("hex");
}
function freeze(value){
  if(value&&typeof value==="object"&&!Object.isFrozen(value)){
    Object.freeze(value);
    for(const child of Object.values(value)) freeze(child);
  }
  return value;
}
function exactSha(value){
  const normalized=String(value??"").trim().toLowerCase();
  if(!SHA40.test(normalized)) throw new TypeError("sourceSha must be exact 40-character SHA");
  return normalized;
}
function requirement(key){
  const row=ADAPTIVE_TOURNAMENT_RUNTIME_BINDING_REQUIREMENTS_V1[key];
  if(!row) throw new Error(`RUNTIME_BINDING_REQUIREMENT_UNKNOWN:${key}`);
  return row;
}
function available(key,sourceSha,proof){
  const wanted=requirement(key);
  const proofDigest=digest(proof);
  return freeze({
    status:"AVAILABLE",
    ownerRefs:[...wanted.ownerRefs],
    capability:wanted.capability,
    sourceSha,
    evidenceId:`runtime-owner-capability:${key}:sha256:${proofDigest}`,
    properties:wanted.properties,
    reason:null,
  });
}
function missing(reason){
  return freeze({
    status:"MISSING",
    ownerRefs:null,
    capability:null,
    sourceSha:null,
    evidenceId:null,
    properties:null,
    reason,
  });
}

function formulaProof(){
  const dsl=createSafeStrategyDslV1({
    market:"US_STOCK",
    timeframe:"1d",
    direction:"LONG",
    availableDataFields:["close"],
    entryDsl:{
      action:"LONG",
      rules:[{
        kind:"OPERATOR",
        operator:"GT",
        operands:[
          {kind:"INDICATOR",name:"SMA",input:"close",parameters:{period:"lookback"}},
          {kind:"INDICATOR",name:"EMA",input:"close",parameters:{period:"lookback"}},
        ],
      }],
    },
    exitDsl:{rules:[{type:"TIME_EXIT",barsParameter:"bars"}]},
    parameterSpace:[
      {name:"bars",domain:"BAR_COUNT",valueType:"INTEGER",min:2,max:2,step:1},
      {name:"lookback",domain:"PERIOD",valueType:"INTEGER",min:5,max:5,step:1},
    ],
    limits:SAFE_STRATEGY_HARD_LIMITS,
  });
  const budget=normalizeCandidateGenerationBudgetV1(CANDIDATE_GENERATOR_HARD_CAPS);
  if(dsl.safety?.boundedDslOnly!==true
    ||dsl.safety?.arbitraryExecutableCodeAllowed!==false
    ||dsl.safety?.networkAccessAllowed!==false
    ||dsl.safety?.fileAccessAllowed!==false
    ||dsl.safety?.processAccessAllowed!==false
    ||dsl.safety?.systemCommandAllowed!==false
    ||dsl.safety?.finalHoldoutParameterAccessAllowed!==false
    ||dsl.safety?.profitabilityClaimAllowed!==false
    ||dsl.safety?.championPromotionAllowed!==false
    ||dsl.safety?.executionAuthority!=="NONE"){
    throw new Error("FORMULA_COMPILER_CAPABILITY_SELFTEST_FAILED");
  }
  if(budget.maxCandidatesPerRun!==CANDIDATE_GENERATOR_HARD_CAPS.maxCandidatesPerRun
    ||budget.maxAstNodes!==SAFE_STRATEGY_HARD_LIMITS.maxAstNodes
    ||budget.maxCpuMs>budget.maxRuntimeMs){
    throw new Error("FORMULA_COMPILER_BUDGET_SELFTEST_FAILED");
  }
  return freeze({
    owner:"#550",
    dslHash:dsl.dslHash,
    safetyDigest:digest(dsl.safety),
    hardLimitsDigest:digest(SAFE_STRATEGY_HARD_LIMITS),
    candidateBudgetDigest:digest(budget),
    boundedDslOnly:true,
    arbitraryExecutableCodeAllowed:false,
    finalHoldoutFeedbackAllowed:false,
    executionAuthority:"NONE",
  });
}

function capabilityCandles(){
  const start=Date.UTC(2025,0,1);
  const day=24*60*60*1000;
  return Array.from({length:24},(_,index)=>{
    const open=100+index*0.25;
    return Object.freeze({
      timestamp:start+index*day,
      open,
      high:open+1,
      low:open-1,
      close:open+0.2,
      volume:1000+index,
    });
  });
}

function backtesterProof(){
  const candles=capabilityCandles();
  const result=runIndependentSignalBacktest({
    backtestInput:{
      market:"US_STOCK",
      symbol:"AAPL",
      side:"long",
      timeframe:"1d",
      initialCapital:100000,
      candles,
      fundingRates:[],
      riskModel:{riskPerTrade:0.01,maximumCapitalFraction:0.25,leverage:1},
      costModel:{
        entryFeeRate:0,
        exitFeeRate:0,
        taxRate:0,
        slippageRate:0,
        spreadRate:0,
        latencyBars:0,
        latencyDriftRate:0,
      },
    },
    strategy:"CAPABILITY_SELFTEST",
    strategyVersion:"V1",
    parameters:{atrPeriod:2,stopAtrMultiple:1,targetRiskMultiple:1.5},
    signalEvaluator:()=>null,
    period:{
      startTime:candles[2].timestamp,
      endTime:candles.at(-1).timestamp,
      includeFinalHoldout:false,
    },
  });
  if(result.ok!==true
    ||result.mode!=="backtest-only"
    ||result.safeguards?.signalUsesClosedCandle!==true
    ||result.safeguards?.entryUsesNextCandleOpen!==true
    ||result.safeguards?.stopFirstOnAmbiguousBar!==true
    ||result.safeguards?.executionUsesSharedCalculateExecutionAwareTrade!==true
    ||result.safeguards?.finalHoldoutUsedForSelection!==false
    ||result.safeguards?.finalHoldoutEvaluation!==false
    ||result.safeguards?.selectionAllowed!==true
    ||result.safeguards?.orderSubmitted!==false
    ||result.safeguards?.privateAccountRequestAllowed!==false){
    throw new Error("CANONICAL_BACKTESTER_CAPABILITY_SELFTEST_FAILED");
  }
  if(BACKTESTER_ADAPTER_SAFETY.LIVE_TRADING!==false
    ||BACKTESTER_ADAPTER_SAFETY.AUTO_TRADING!==false
    ||BACKTESTER_ADAPTER_SAFETY.REAL_ORDER_ENABLED!==false
    ||BACKTESTER_ADAPTER_SAFETY.PRIVATE_TRADING_API_ALLOWED!==false
    ||BACKTESTER_ADAPTER_SAFETY.executionAuthority!=="NONE"
    ||BACKTESTER_ADAPTER_SAFETY.orderSubmitted!==false){
    throw new Error("CANONICAL_BACKTESTER_ADAPTER_SAFETY_INVALID");
  }
  const canonicalContracts=PR191_BACKTESTER_EVIDENCE_CONTRACT_V1.resultContracts;
  if(!canonicalContracts?.V3||!canonicalContracts?.V4
    ||!HASH64.test(canonicalContracts.V3.artifactDigest)
    ||!HASH64.test(canonicalContracts.V4.artifactDigest)
    ||!HASH64.test(canonicalContracts.V3.legacyResultDigest)
    ||!HASH64.test(canonicalContracts.V4.legacyResultDigest)){
    throw new Error("CANONICAL_BACKTESTER_EQUIVALENCE_EVIDENCE_INVALID");
  }
  return freeze({
    owner:"#690",
    engine:"runIndependentSignalBacktest",
    selfTestDigest:digest({
      mode:result.mode,
      safeguards:result.safeguards,
      riskModel:result.riskModel,
      costModel:result.costModel,
      period:result.period,
    }),
    immutableEquivalenceEvidenceDigest:digest(PR191_BACKTESTER_EVIDENCE_CONTRACT_V1),
    onePassExecutionEquivalent:true,
    duplicateBacktesterAllowed:false,
    resultIdentityRequired:true,
    finalHoldoutAccessAllowed:false,
    executionAuthority:"NONE",
  });
}

function statisticalProof(){
  const trials=[
    {returnSeries:[0.01,0.02,-0.01,0.03,0.01,0.02,-0.005,0.015]},
    {returnSeries:[0.005,0.01,0.0,0.012,0.004,0.009,-0.002,0.006]},
    {returnSeries:[-0.004,0.006,-0.003,0.005,0.002,-0.001,0.004,0.003]},
  ];
  const pbo=computeCscvPbo(trials,{blockCount:4,maxCombinations:100});
  const dsr=computeDeflatedSharpeRatio(
    trials[0].returnSeries,
    trials.map(row=>row.returnSeries),
  );
  if(pbo.method!=="CSCV_PBO"
    ||pbo.trialCount!==trials.length
    ||!Number.isFinite(pbo.pbo)
    ||dsr.method!=="DEFLATED_SHARPE_RATIO"
    ||dsr.trialCount!==trials.length
    ||!Number.isFinite(dsr.probability)){
    throw new Error("STATISTICAL_FIREWALL_CAPABILITY_SELFTEST_FAILED");
  }
  return freeze({
    owner:"#547",
    trialFamilySize:trials.length,
    pboMethod:pbo.method,
    dsrMethod:dsr.method,
    pboDigest:digest(pbo),
    dsrDigest:digest(dsr),
    originalCandidateFamilySizeRequired:true,
    dsrAndPboRequired:true,
    aiNumericAuthorityAllowed:false,
    executionAuthority:"NONE",
  });
}

export function validateCanonicalBundlePublicationV1(value){
  if(!value||typeof value!=="object"||Array.isArray(value)) return false;
  return value.schemaVersion==="research-canonical-bundle-publication-v1"
    &&HASH64.test(value.dslDigest??"")
    &&HASH64.test(value.bundleDigest??"")
    &&value.publicationStatus==="READBACK_VERIFIED"
    &&value.evidenceCredit===0
    &&value.profitabilityProven===false
    &&value.executionAuthority==="NONE";
}

function bundleBinding(sourceSha,bundlePublication){
  if(!validateCanonicalBundlePublicationV1(bundlePublication)){
    return missing("CANONICAL_BUNDLE_READBACK_VERIFIED_PUBLICATION_REQUIRED");
  }
  return available("canonicalBundleSource",sourceSha,freeze({
    ownerRefs:["#821","#833"],
    publication:{
      schemaVersion:bundlePublication.schemaVersion,
      dslDigest:bundlePublication.dslDigest,
      bundleDigest:bundlePublication.bundleDigest,
      publicationStatus:bundlePublication.publicationStatus,
      evidenceCredit:bundlePublication.evidenceCredit,
      profitabilityProven:bundlePublication.profitabilityProven,
      executionAuthority:bundlePublication.executionAuthority,
    },
    authenticOwnerPublishedCatalogRequired:true,
    testFixtureCreditAllowed:false,
    syntheticBundleAllowed:false,
  }));
}

export function buildAdaptiveRuntimeOwnerBindingsV1({
  sourceSha,
  bundlePublication=null,
}={}){
  const sha=exactSha(sourceSha);
  const checkpoint=createResearchTournamentStageCheckpointCapabilityEvidenceV1({sourceSha:sha});
  const checkpointRequirement=requirement("stageCheckpointExecutor");
  if(digest(checkpoint.ownerRefs)!==digest(checkpointRequirement.ownerRefs)
    ||checkpoint.capability!==checkpointRequirement.capability
    ||checkpoint.sourceSha!==sha
    ||digest(checkpoint.properties)!==digest(checkpointRequirement.properties)
    ||checkpoint.status!=="AVAILABLE"){
    throw new Error("CHECKPOINT_CAPABILITY_REQUIREMENT_MISMATCH");
  }

  const bindings=freeze({
    stageCheckpointExecutor:checkpoint,
    canonicalBundleSource:bundleBinding(sha,bundlePublication),
    formulaCompiler:available("formulaCompiler",sha,formulaProof()),
    canonicalBacktester:available("canonicalBacktester",sha,backtesterProof()),
    statisticalFirewall:available("statisticalFirewall",sha,statisticalProof()),
  });
  const availableKeys=Object.entries(bindings)
    .filter(([,binding])=>binding.status==="AVAILABLE")
    .map(([key])=>key);
  const missingKeys=Object.entries(bindings)
    .filter(([,binding])=>binding.status!=="AVAILABLE")
    .map(([key])=>key);
  return freeze({
    schemaVersion:1,
    contract:ADAPTIVE_RUNTIME_OWNER_CAPABILITIES_CONTRACT_V1,
    sourceSha:sha,
    bindings,
    availableKeys:freeze(availableKeys),
    missingKeys:freeze(missingKeys),
    allBindingsAvailable:missingKeys.length===0,
    safety:freeze({
      capabilityEvidenceOnly:true,
      runtimeExecutionAttempted:false,
      runtimeActivationAllowed:false,
      scheduleMutationAllowed:false,
      deploymentAllowed:false,
      finalHoldoutAccessAllowed:false,
      liveTradingAllowed:false,
      executionAuthority:"NONE",
    }),
  });
}
