export type ProviderStatus={checkedAt:string;unmappedGenericCredential:boolean;providers:Array<{
  provider:'youtube'|'gemini'|'groq';credentialState:'PRESENT'|'MISSING_IN_SELECTED_RUNTIME'|'INVALID'|'CONFLICT';
  modelState:'NOT_APPLICABLE'|'DEFAULT_NOT_RESOLVED'|'EXPLICIT'|'INVALID'|'CONFLICT';
}>};
export function parseResearchProviderStatus(raw:unknown):ProviderStatus;
