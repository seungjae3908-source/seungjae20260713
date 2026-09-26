export type ResearchOrchestratorUiStatus={available:false;reason:string}|{available:true;checkedAt:string;totals:{pending:number;processing:number;reviewRequired:number;completed:number};stageCounts:Record<string,number>;markets:{stockCompleted:number;cryptoCompleted:number}};
export const RESEARCH_ORCHESTRATOR_STAGE_LABELS:Readonly<Record<string,string>>;
export function parseResearchOrchestratorStatus(raw:unknown):ResearchOrchestratorUiStatus;
