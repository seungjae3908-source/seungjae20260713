import { runCanonicalMeaningfulSearchPaperMarket } from "./canonical-meaningful-search-paper-runtime-v1.js";

const PAPER_ADMISSION_BUNDLE_SCHEMA = "scanner-paper-admission-evidence-bundle-v1";

function freeze(value) {
  return Object.freeze(value);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function attachBundle(card, bundle) {
  if (bundle == null) return card;
  if (!isRecord(bundle) || bundle.schemaVersion !== PAPER_ADMISSION_BUNDLE_SCHEMA) {
    throw new Error("PAPER_ADMISSION_BUNDLE_CALLBACK_INVALID");
  }
  return freeze({
    ...card,
    paperAdmissionEvidenceBundle: bundle,
  });
}

function throwCollectedErrors(errors) {
  if (errors.length === 0) return;
  const authoritative = errors.filter((error) => error?.code === "AUTHORITATIVE_ADMISSION_EVIDENCE_BLOCKED");
  if (authoritative.length === errors.length) {
    const combined = new Error("AUTHORITATIVE_ADMISSION_EVIDENCE_BLOCKED");
    combined.code = "AUTHORITATIVE_ADMISSION_EVIDENCE_BLOCKED";
    combined.authoritativeAdmissionBlockers = [...new Set(authoritative.flatMap((error) =>
      Array.isArray(error?.authoritativeAdmissionBlockers) ? error.authoritativeAdmissionBlockers : []))];
    throw combined;
  }
  throw errors[0];
}

export async function runCanonicalMeaningfulSearchPaperMarketWithAdmissionBundles({
  market,
  scanBatch,
  paperAdmissionBundleForCard,
  ...runtimeOptions
} = {}) {
  if (typeof scanBatch !== "function") throw new TypeError("scanBatch must be a function");
  if (typeof paperAdmissionBundleForCard !== "function") {
    throw new TypeError("paperAdmissionBundleForCard must be a function");
  }

  const wrappedScanBatch = async (...args) => {
    const response = await scanBatch(...args);
    if (!isRecord(response) || !Array.isArray(response.cards)) {
      throw new Error("PAPER_ADMISSION_SCAN_RESPONSE_INVALID");
    }
    const cards = [];
    const errors = [];
    for (const card of response.cards) {
      try {
        const bundle = await paperAdmissionBundleForCard(card, market);
        cards.push(attachBundle(card, bundle));
      } catch (error) {
        errors.push(error);
      }
    }
    throwCollectedErrors(errors);
    return freeze({ ...response, cards: freeze(cards) });
  };

  const result = await runCanonicalMeaningfulSearchPaperMarket({
    ...runtimeOptions,
    market,
    scanBatch: wrappedScanBatch,
  });

  return freeze({
    ...result,
    admissionBundleInjection: freeze({
      schemaVersion: "canonical-paper-admission-bundle-injection-runtime-v1",
      sourceSchemaVersion: PAPER_ADMISSION_BUNDLE_SCHEMA,
      callbackRequired: true,
      batchEvidenceEvaluation: "COMPLETE_BEFORE_FAIL_CLOSED",
      executionAuthority: "NONE",
      simulatedOnly: true,
      liveOrderAllowed: false,
      privateTradingApiAllowed: false,
      orderSubmitted: false,
      exchangeRequestSent: false,
      productionMutationAllowed: false,
    }),
  });
}
