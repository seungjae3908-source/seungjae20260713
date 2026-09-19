import {
  buildCanonicalBundleComponentReadinessV1,
  type CanonicalBundleComponentBindingV1,
} from './research-canonical-component-registry.service.ts';
import {
  assembleResearchCanonicalBundleV1,
} from './research-canonical-bundle-assembler.service.ts';
import {
  publishResearchCanonicalBundleOfflineV1,
} from './research-canonical-bundle-offline-publisher.service.ts';

export const RESEARCH_CANONICAL_BUNDLE_FINALIZER_CONTRACT_V1 =
  'research-canonical-bundle-finalizer/v1';

function exactObjectKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual=Object.keys(value).sort();
  const wanted=[...expected].sort();
  return actual.length===wanted.length && actual.every((key,index)=>key===wanted[index]);
}

export async function finalizeResearchCanonicalBundleFromRegistryV1(input: {
  inputRoot: string;
  stateRoot: string;
  binding: CanonicalBundleComponentBindingV1;
  /** Focused test harness only. Production CLI never passes this. */
  validationNow?: () => number;
}) {
  const readiness=await buildCanonicalBundleComponentReadinessV1({
    inputRoot:input.inputRoot,
    binding:input.binding,
  });
  if(readiness.status!=='COMPLETE') {
    return Object.freeze({
      schemaVersion:1,
      contract:RESEARCH_CANONICAL_BUNDLE_FINALIZER_CONTRACT_V1,
      status:'BLOCKED_MISSING_COMPONENTS' as const,
      bindingDigest:readiness.bindingDigest,
      presentKeys:readiness.presentKeys,
      missingKeys:readiness.missingKeys,
      readinessDigest:readiness.readinessDigest,
      assembled:false as const,
      published:false as const,
      evidenceCredit:0 as const,
      profitabilityProven:false as const,
      executionAuthority:'NONE' as const,
    });
  }

  const assembly=await assembleResearchCanonicalBundleV1({
    inputRoot:input.inputRoot,
    researchCodeSha:input.binding.researchCodeSha,
    componentPaths:readiness.componentPaths as Parameters<typeof assembleResearchCanonicalBundleV1>[0]['componentPaths'],
    validationNow:input.validationNow,
  });
  if(!exactObjectKeys(assembly.componentDigests,readiness.presentKeys)
    ||readiness.presentKeys.some((key)=>assembly.componentDigests[key]!==readiness.payloadDigests[key])) {
    throw new Error('FINALIZER_COMPONENT_DIGEST_MISMATCH');
  }

  const publication=await publishResearchCanonicalBundleOfflineV1({
    stateRoot:input.stateRoot,
    inputRoot:input.inputRoot,
    dslPath:readiness.componentPaths.dsl,
    bundlePath:assembly.bundlePath,
    researchCodeSha:input.binding.researchCodeSha,
    validationNow:input.validationNow,
  });

  if(publication.publication.bundleDigest!==assembly.bundleDigest
    ||publication.publication.researchCodeSha!==input.binding.researchCodeSha
    ||publication.publication.publicationStatus!=='READBACK_VERIFIED'
    ||publication.publication.evidenceCredit!==0
    ||publication.publication.profitabilityProven!==false
    ||publication.publication.executionAuthority!=='NONE') {
    throw new Error('FINALIZER_PUBLICATION_BINDING_MISMATCH');
  }

  return Object.freeze({
    schemaVersion:1,
    contract:RESEARCH_CANONICAL_BUNDLE_FINALIZER_CONTRACT_V1,
    status:'READBACK_VERIFIED' as const,
    bindingDigest:readiness.bindingDigest,
    readinessDigest:readiness.readinessDigest,
    assemblyRecordDigest:assembly.recordDigest,
    componentDigests:assembly.componentDigests,
    dslDigest:publication.publication.dslDigest,
    bundleDigest:publication.publication.bundleDigest,
    publicationReceiptDigest:publication.publication.receiptDigest,
    publicationReceiptPath:publication.receiptPath,
    publicationRecordPath:publication.recordPath,
    assembled:true as const,
    published:true as const,
    evidenceCredit:0 as const,
    profitabilityProven:false as const,
    runtimeActivationAllowed:false as const,
    executionAuthority:'NONE' as const,
  });
}
