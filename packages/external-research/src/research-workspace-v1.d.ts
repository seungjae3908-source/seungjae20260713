export type WorkspaceTrustPolicy = {now:string;expectedSourceHeadSha:string;maxAgeMs:number};
export type WorkspaceReadView = {
  schemaVersion:'research-workspace-v1';sourceState:string;sourceReason:string|null;sourceCount:number|null;
  sources:Array<Record<string,unknown>>;strategies:Array<Record<string,unknown>>;
  registryState:string;registryReason:string|null;workerState:'UNVERIFIED';
  authority:Readonly<{executionAuthority:'NONE';actualOrders:0;economicEvidenceCredit:0;profitabilityCredit:0;canonicalSampleDelta:0;paidFallback:false;automaticAdoption:false;providerInvoked:false}>;
};
export function buildResearchWorkspace(input:{videoEvidence?:unknown;registry?:unknown;policy:WorkspaceTrustPolicy}):WorkspaceReadView;
export function evidenceDigest(value:unknown):string;
export function strategyDigest(value:unknown):string;
export function backtestProjectionDigest(value:unknown):string;
export function selectWorkspaceStrategies(view:WorkspaceReadView,group?:string,market?:string):Array<Record<string,unknown>>;
