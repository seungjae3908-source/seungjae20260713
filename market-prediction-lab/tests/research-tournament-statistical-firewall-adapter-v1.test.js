import test from "node:test";
import assert from "node:assert/strict";
import { adaptGlobalStatisticalFirewallToTournamentV1 } from "../src/research-tournament-statistical-firewall-adapter-v1.js";

const request = {
  canonicalOwner: "#547",
  candidateFamilySize: 3,
  requiredAdjustedAlpha: 0.05 / 3,
  finalHoldoutAccess: false,
};

const trials = [
  { trialId: "A", returnSeries: [0.01,0.02,0.015,0.018,0.011,0.019,0.014,0.017,0.013,0.016,0.012,0.02] },
  { trialId: "B", returnSeries: [0.005,0.012,0.009,0.011,0.004,0.01,0.008,0.013,0.006,0.012,0.007,0.011] },
  { trialId: "C", returnSeries: [-0.002,0.004,0.001,0.003,-0.001,0.002,0.001,0.005,0.0,0.003,0.001,0.004] },
];
const benchmark = Array(12).fill(0);
const realityCheckPolicy = { status:"empirically_calibrated", alpha:0.49, bootstrapIterations:200, blockLength:2, seed:17 };
const decisionPolicy = { status:"empirically_calibrated", maxPbo:1, minDsrProbability:0, alpha:1 };
const stability = {
  minimumN:{passed:true,evidenceId:"n:1"},
  parameterStability:{passed:true,evidenceId:"param:1"},
  walkForwardStability:{passed:true,evidenceId:"wf:1"},
  regimeStability:{passed:true,evidenceId:"regime:1"},
};

test("adapter preserves #547 DSR/PBO/RealityCheck/SPA and emits #551 tournament contract",()=>{
  const out=adaptGlobalStatisticalFirewallToTournamentV1({
    tournamentRequest:request,trials,selectedTrialId:"A",benchmarkReturns:benchmark,
    blockCount:4,maxCombinations:100,realityCheckPolicy,decisionPolicy,stabilityEvidence:stability,
  });
  assert.equal(out.status,"PASS");
  assert.equal(out.canonicalOwner,"#547");
  assert.equal(out.candidateFamilySize,3);
  assert.equal(out.multipleTesting.passed,true);
  assert.equal(out.multipleTesting.method,"FAMILY_ALPHA_BOUND_PLUS_REALITY_CHECK_SPA");
  assert.equal(out.dsr.passed,true);
  assert.equal(out.pbo.passed,true);
  assert.equal(out.minimumN.passed,true);
  assert.equal(out.finalHoldoutAccess,false);
  assert.equal(out.executionAuthority,"NONE");
  assert.equal(out.sourceFirewallDecision.status,"STATISTICAL_REVIEW_READY");
});

test("adapter refuses an understated or incomplete selection family",()=>{
  const out=adaptGlobalStatisticalFirewallToTournamentV1({
    tournamentRequest:{...request,candidateFamilySize:4},trials,selectedTrialId:"A",benchmarkReturns:benchmark,
    blockCount:4,maxCombinations:100,realityCheckPolicy,decisionPolicy,stabilityEvidence:stability,
  });
  assert.equal(out.status,"MISSING_EVIDENCE");
  assert.equal(out.code,"STATISTICAL_EVIDENCE_MISSING");
});

test("adapter never accepts Final Holdout access",()=>{
  assert.throws(()=>adaptGlobalStatisticalFirewallToTournamentV1({
    tournamentRequest:{...request,finalHoldoutAccess:true},trials,selectedTrialId:"A",benchmarkReturns:benchmark,
    blockCount:4,maxCombinations:100,realityCheckPolicy,decisionPolicy,stabilityEvidence:stability,
  }),/REQUEST_INVALID/);
  assert.throws(()=>adaptGlobalStatisticalFirewallToTournamentV1({
    tournamentRequest:{...request,finalHoldoutResult:{}},trials,selectedTrialId:"A",benchmarkReturns:benchmark,
    blockCount:4,maxCombinations:100,realityCheckPolicy,decisionPolicy,stabilityEvidence:stability,
  }),/HOLDOUT_INPUT_FORBIDDEN/);
});

test("adapter fails closed when upstream stability evidence is incomplete",()=>{
  const out=adaptGlobalStatisticalFirewallToTournamentV1({
    tournamentRequest:request,trials,selectedTrialId:"A",benchmarkReturns:benchmark,
    blockCount:4,maxCombinations:100,realityCheckPolicy,decisionPolicy,
    stabilityEvidence:{...stability,regimeStability:{passed:false,evidenceId:"regime:bad"}},
  });
  assert.equal(out.status,"FAIL");
  assert.equal(out.code,"PARAMETER_INSTABILITY");
});

test("adapter refuses uncalibrated decision policy rather than inventing thresholds",()=>{
  const out=adaptGlobalStatisticalFirewallToTournamentV1({
    tournamentRequest:request,trials,selectedTrialId:"A",benchmarkReturns:benchmark,
    blockCount:4,maxCombinations:100,realityCheckPolicy,decisionPolicy:{status:"review_required"},stabilityEvidence:stability,
  });
  assert.equal(out.status,"MISSING_EVIDENCE");
  assert.equal(out.code,"STATISTICAL_EVIDENCE_MISSING");
});
