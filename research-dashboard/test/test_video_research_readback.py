import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from video_research_readback import _parse_systemd_timestamp, read_video_research_readback  # noqa: E402

SHA='a'*40
DIGEST='b'*64

def write_json(path,value):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(value),encoding='utf-8')

def snapshot():
    return {
      'runtimeVersion':'video-research-public-provider-runtime-v3','status':'SUCCESS','provider':'YOUTUBE_DATA_API_V3',
      'providerAccess':'OFFICIAL_PUBLIC_API','requestMode':'READ_ONLY_GET','query':'public strategy research','pagesUsed':1,
      'quotaState':'UNKNOWN','credentialConfigured':True,'credentialValueExposed':False,'sourceCount':1,
      'records':[{'videoId':'abcdefghijk','canonicalUrl':'https://www.youtube.com/watch?v=abcdefghijk','title':'Public video',
        'channelOrPublisher':'Channel','publishedAt':None,'discoveredAt':'2026-10-02T03:00:00.000Z','language':None,'durationSec':None,
        'transcriptStatus':'NOT_PROVIDED','captionsKnownPresent':None,'sourceTrustTier':'UNKNOWN','contentAuthority':'UNTRUSTED_EXTERNAL_DATA',
        'economicEvidenceCredit':0,'profitabilityCredit':0,'executionAuthority':'NONE'}],
      'safety':{'researchOnly':True,'economicEvidenceCredit':0,'profitabilityCredit':0,'executionAuthority':'NONE','paidProviderEnabled':False,
        'scheduleActive':False,'automaticDiscoveryEnabled':False,'liveTrading':False,'privateTradingApi':False,'realOrderEnabled':False,
        'credentialMutation':False,'transcriptDownloadEnabled':False},
      'snapshotProvenance':{'schemaVersion':'video-research-sanitized-snapshot-v1','sourceHeadSha':SHA,'observedAt':'2026-10-02T03:00:00.000Z',
        'publisherMode':'LOCAL_ATOMIC_FILE','providerRuntimeVersion':'video-research-public-provider-runtime-v3','economicEvidenceCredit':0,
        'profitabilityCredit':0,'executionAuthority':'NONE'}
    }

def automation():
    return {'schemaVersion':'research-video-discovery-scan-v1','status':'COMPLETE','observedAt':'2026-10-02T03:00:00.000Z',
      'researchSha':SHA,'provider':'YOUTUBE_DATA_API_V3','query':'public strategy research','sourceCount':1,'snapshotDigest':DIGEST,
      'providerNetworkCalls':1,'invocationMode':'SYSTEMD_TIMER','scheduledInvocationObserved':False,'reason':None,
      'nextRequiredStep':'SOURCE_REVIEW_THEN_EXISTING_GEMINI_GROQ_ORCHESTRATOR',
      'safety':{'researchOnly':True,'metadataDiscoveryOnly':True,'transcriptDownloadEnabled':False,'automaticGeminiExecution':False,
        'automaticGroqExecution':False,'automaticAdoption':False,'paidFallback':False,'economicEvidenceCredit':0,'profitabilityCredit':0,
        'executionAuthority':'NONE','liveTrading':False,'privateTradingApiAllowed':False,'realOrderEnabled':False}}

def ai_review():
    return {'schemaVersion':'research-production-ai-scan-v1','status':'COMPLETE','observedAt':1790910030000,'researchSha':SHA,
      'provider':'groq','model':'openai/gpt-oss-20b','reason':'CONFIGURED_FREE_ONLY_QUOTA_UNKNOWN','providerNetworkCalls':1,'cacheHits':0,
      'reviews':[{'profile':'forward','evidenceDigest':'c'*64,'status':'READY','cacheHit':False,'role':'CRITIC'}],
      'missingProfiles':[],'blockedProfiles':[],'deferredProfiles':[],'invocationMode':'SYSTEMD_TIMER','scheduledInvocationObserved':False,
      'evidenceCredit':0,'profitabilityProven':False,'champion':None,
      'safety':{'researchProposalOnly':True,'paidFallback':False,'executionAuthority':'NONE','numericPerformanceAuthority':False,
        'promotionAuthority':False,'championAuthority':False,'finalHoldoutOpened':False,'orderAllowed':False,'liveTrading':False,
        'privateTradingApiAllowed':False,'evidenceCredit':0}}

class VideoResearchReadbackTest(unittest.TestCase):
    def test_systemd_utc_trigger_timestamp_is_parseable(self):
        self.assertEqual(_parse_systemd_timestamp('Fri 2026-10-02 03:00:00 UTC'), 1790910000000)
        self.assertIsNone(_parse_systemd_timestamp('n/a'))

    def root(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);return Path(temp.name)

    def test_timer_contract_requires_external_timer_proof(self):
        root=self.root()
        write_json(root/'video-research/current/video-research-public-provider-runtime-v3.json',snapshot())
        write_json(root/'video-research/latest.json',automation())
        write_json(root/'ai-review/latest.json',ai_review())
        result=read_video_research_readback(root,timer_probe=lambda _: {'enabled':False,'active':False,'lastTriggerMs':None})
        self.assertTrue(result['available'])
        self.assertFalse(result['automation']['scheduledInvocationObserved'])
        self.assertFalse(result['aiReview']['scheduledInvocationObserved'])
        self.assertEqual(result['executionAuthority'],'NONE')

    def test_correlated_timer_proof_enables_only_observation_flag(self):
        root=self.root()
        write_json(root/'video-research/current/video-research-public-provider-runtime-v3.json',snapshot())
        write_json(root/'video-research/latest.json',automation())
        write_json(root/'ai-review/latest.json',ai_review())
        def probe(unit):
            return {'enabled':True,'active':True,'lastTriggerMs':1790910000000 if 'ai-review' in unit else 1790910000000}
        result=read_video_research_readback(root,timer_probe=probe)
        self.assertTrue(result['automation']['scheduledInvocationObserved'])
        self.assertTrue(result['aiReview']['scheduledInvocationObserved'])
        self.assertEqual(result['aiReview']['reviewCount'],1)
        self.assertEqual(result['economicEvidenceCredit'],0)
        self.assertEqual(result['profitabilityCredit'],0)

    def test_missing_snapshot_preserves_safe_ai_status_without_fake_zero(self):
        root=self.root()
        write_json(root/'ai-review/latest.json',ai_review())
        result=read_video_research_readback(root,timer_probe=lambda _: {'enabled':False,'active':False,'lastTriggerMs':None})
        self.assertFalse(result['available'])
        self.assertEqual(result['dataState'],'UNKNOWN')
        self.assertEqual(result['reason'],'VIDEO_RESEARCH_SNAPSHOT_MISSING')
        self.assertEqual(result['aiReview']['reviewCount'],1)

    def test_unsafe_authority_fails_closed(self):
        root=self.root()
        bad=ai_review();bad['safety']['orderAllowed']=True
        write_json(root/'video-research/current/video-research-public-provider-runtime-v3.json',snapshot())
        write_json(root/'ai-review/latest.json',bad)
        result=read_video_research_readback(root,timer_probe=lambda _: {'enabled':False,'active':False,'lastTriggerMs':None})
        self.assertTrue(result['available'])
        self.assertIsNone(result['aiReview'])
        self.assertEqual(result['executionAuthority'],'NONE')

if __name__=='__main__':
    unittest.main()
