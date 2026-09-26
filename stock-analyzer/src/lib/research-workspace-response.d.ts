export type WorkspaceMarket = 'KR_STOCK' | 'US_STOCK' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES';
export type WorkspaceGroup = 'ALL' | 'STOCK' | 'CRYPTO';
export type WorkspaceRule = { id: string; kind: string; text: string; origin: 'SOURCE_RULE' | 'AI_ASSUMPTION'; rationale: string | null; evidence: Array<{startSec:number;endSec:number;excerpt:string}> };
export type WorkspaceStrategy = { id:string;strategyId:string;version:string;market:WorkspaceMarket;timeframe:string;sourceId:string;strategyDigest:string;state:string;rules:WorkspaceRule[];missingRules:string[];run:null|{runId:string;netReturn:number;maxDrawdown:number;tradeCount:number;startAt:string;endAt:string} };
export type WorkspaceResponse = {available:false;reason:string}|{available:true;sourceState:string;registryState:string;sourceCount:number|null;sources:Array<{sourceId:string;title:string;url:string}>;strategies:WorkspaceStrategy[]};
export const WORKSPACE_MARKETS: readonly WorkspaceMarket[];
export function parseResearchWorkspaceResponse(raw:unknown): WorkspaceResponse;
export function filterResearchStrategies(rows:WorkspaceStrategy[],group:WorkspaceGroup,market:'ALL'|WorkspaceMarket): WorkspaceStrategy[];
