# --- 429/503 QUOTA COOLDOWN GUARD ---
import os as _os
import signal as _signal
import time as _time

_STOP_PIPELINE = False
_QUOTA_COOLDOWN_UNTIL = 0.0
_QUOTA_COOLDOWN_SEC = float(_os.getenv("AI_THEME_429_COOLDOWN_SEC", "180"))

def _on_stop(signum, frame):
    global _STOP_PIPELINE
    _STOP_PIPELINE = True

_signal.signal(_signal.SIGTERM, _on_stop)
_signal.signal(_signal.SIGINT, _on_stop)

def _should_cooldown(err_text: str) -> bool:
    t = (err_text or "").lower()
    return any(k in t for k in (
        "429",
        "exceeded your current quota",
        "resource_exhausted",
        "too many requests",
        "503",
        "high demand",
    ))

def _trip_cooldown(reason: str):
    global _QUOTA_COOLDOWN_UNTIL
    now = _time.monotonic()
    if now >= _QUOTA_COOLDOWN_UNTIL:
        print(f"  [COOLDOWN] {reason} -> {int(_QUOTA_COOLDOWN_SEC)}s backoff")
    _QUOTA_COOLDOWN_UNTIL = max(_QUOTA_COOLDOWN_UNTIL, now + _QUOTA_COOLDOWN_SEC)

def _wait_cooldown() -> bool:
    while not _STOP_PIPELINE:
        rem = _QUOTA_COOLDOWN_UNTIL - _time.monotonic()
        if rem <= 0:
            return True
        _time.sleep(min(0.5, rem))
    return False

import os, json, time, feedparser, requests
from datetime import datetime
from urllib.parse import quote
import dotenv
dotenv.load_dotenv('/root/seungjae20260713/api-server/.env')
dotenv.load_dotenv('/opt/stock-app/api-server/.env', override=False)

API_KEY = os.getenv("GROQ_API_KEY")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
MODEL = "openai/gpt-oss-120b"
GEMINI_MODEL = "gemini-3.5-flash-lite"
API_URL = "https://api.groq.com/openai/v1/chat/completions"

def gemini_json(prompt):
    if not GEMINI_API_KEY:
        return None
    for m in [GEMINI_MODEL, "gemini-3.8-flash"]:
        try:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{m}:generateContent?key={GEMINI_API_KEY}"
            r = requests.post(
                url,
                headers={"Content-Type": "application/json"},
                json={
                    "contents": [{"parts": [{"text": prompt}]}],
                    "generationConfig": {"temperature": 0.2, "responseMimeType": "application/json"},
                },
                timeout=30,
            )
            if r.status_code != 200:
                print(f"  [Gemini {m} HTTP {r.status_code}] {r.text[:150]}")
                continue
            text = r.json()["candidates"][0]["content"]["parts"][0]["text"]
            return json.loads(text)
        except Exception as e:
            print(f"  [Gemini {m} err] {str(e)[:120]}")
    return None

def groq_json(prompt, retries=3):
    if API_KEY:
        for i in range(retries):
            try:
                r = requests.post(
                    API_URL,
                    headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
                    json={"model": MODEL, "messages": [{"role":"user","content":prompt}], "response_format": {"type":"json_object"}, "temperature": 0.2},
                    timeout=30,
                )
                if r.status_code == 429:
                    print("  [429] Groq 속도 제한 -> 즉시 Gemini 폴백")
                    break
                if r.status_code != 200:
                    print(f"  [HTTP {r.status_code}] {r.text[:150]}")
                    break
                return json.loads(r.json()['choices'][0]['message']['content'])
            except Exception as e:
                print(f"  [err] {str(e)[:120]}")
                if i < retries-1:
                    time.sleep(3)
    print("  [Groq 소진/실패] Gemini 폴백 시도")
    return gemini_json(prompt)

def fetch_news(keyword, lang='ko', retries=2):
    hl, gl = ('ko','KR') if lang=='ko' else ('en-US','US')
    ceid = f"{gl}:{hl.split('-')[0]}"
    url = f'https://news.google.com/rss/search?q={quote(keyword)}&hl={hl}&gl={gl}&ceid={ceid}'
    for attempt in range(retries):
        try:
            time.sleep(1.5)
            feed = feedparser.parse(url)
            titles = [e.title for e in feed.entries[:12]]
            if titles: return titles
            if attempt < retries-1:
                print(f"  [재시도 {attempt+1}/{retries}] 0개"); time.sleep(3)
        except Exception as e:
            print(f"  [뉴스 실패] {str(e)[:80]}"); time.sleep(2)
    return []

def discover_themes(market):
    kw = {'KR':'코스피 특징주','US':'stock market sector rally','FUTURES':'bitcoin news','UPBIT':'korean crypto theme'}[market]
    lang = 'ko' if market in ['KR','UPBIT'] else 'en'
    print(f"  [뉴스] '{kw}'"); news = fetch_news(kw, lang); print(f"  [뉴스] {len(news)}개")
    if not news: return []
    prompt = f"다음 뉴스로 {market} 시장 뜨는 테마 3개 뽑아줘. JSON만: {{\"themes\": [{{\"name\": \"테마\", \"reason\": \"이유\", \"strength\": 8}}]}}\n\n뉴스:\n" + chr(10).join(news[:12])
    r = groq_json(prompt)
    if isinstance(r, list):
        return r
    if isinstance(r, dict):
        themes = r.get('themes') or r.get('data') or []
        return themes if isinstance(themes, list) else []
    return []

def expand_stocks(theme, market):
    hint = {'KR':'6자리코드','US':'미국티커','FUTURES':'USDT심볼','UPBIT':'코인심볼'}[market]
    prompt = f"테마 '{theme['name']}' ({market}) 관련 종목 15개 ({hint}). JSON만: {{\"stocks\": [{{\"symbol\": \"심볼\", \"name\": \"이름\"}}]}}"
    r = groq_json(prompt)
    if isinstance(r, list):
        return r
    if isinstance(r, dict):
        stocks = r.get('stocks') or r.get('tickers') or r.get('data') or []
        return stocks if isinstance(stocks, list) else []
    return []

def market_from_symbol(sym):
    if sym.isdigit() and len(sym) == 6: return 'KR'
    if sym.endswith('USDT') and len(sym) > 4: return 'FUTURES'
    if sym.isupper() and 1 <= len(sym) <= 5: return 'US'
    return 'UPBIT'

def has_local_data(sym, market):
    base = sym.replace('USDT','').replace('_UPBIT','').replace('_KR','')
    c = {'KR':[f'./kr_5m_data/{sym}.json', f'./kr_5m_data/{base}.json'],
         'US':[f'./us_5m_data/{sym}.json'],
         'FUTURES':[f'./futures_5m_data/{sym}.json', f'./futures_5m_data/{base}USDT.json'],
         'UPBIT':[f'./upbit_5m_data/{sym}.json', f'./upbit_5m_data/{base}.json']}
    return any(os.path.exists(p) for p in c.get(market, []))

def run_pre_rise(sym, market):
    import pandas as pd, numpy as np
    base = sym.replace('USDT','').replace('_UPBIT','').replace('_KR','')
    c = {'KR':[f'./kr_5m_data/{sym}.json', f'./kr_5m_data/{base}.json'],
         'US':[f'./us_5m_data/{sym}.json'],
         'FUTURES':[f'./futures_5m_data/{sym}.json', f'./futures_5m_data/{base}USDT.json'],
         'UPBIT':[f'./upbit_5m_data/{sym}.json', f'./upbit_5m_data/{base}.json']}
    p = next((x for x in c.get(market, []) if os.path.exists(x)), None)
    if not p: return None
    try:
        df = pd.read_json(p); df.columns = [c.lower() for c in df.columns]
        if len(df) < 65: return None
        close = df['close'].values; vol = df['volume'].values
        rs = (close[-1]/close[-60]-1)*100
        vr = np.mean(vol[-5:]); vb = np.mean(vol[-25:-5])
        vg = (vr/vb-1)*100 if vb > 0 else 0
        lead = (close[-1]/close[-20]-1)*100
        if vg >= 150 and -2 <= rs <= 3 and lead >= 0:
            return {'rs': round(float(rs),2), 'vol_growth': round(float(vg),2), 'lead': round(float(lead),2)}
    except: pass
    return None

def main():
    print("="*60); print("🚀 AI 3단계 테마 파이프라인"); print("="*60)
    all_results = []
    for market in ['KR','US','FUTURES','UPBIT']:
        print(f"\n[{market}]")
        themes = discover_themes(market)
        themes = [t for t in themes if isinstance(t, dict) and t.get('name')]
        print(f"  → {len(themes)}개: {[t['name'] for t in themes]}")
        for theme in themes:
            stocks = [s for s in expand_stocks(theme, market) if isinstance(s, dict) and s.get('symbol')]
            passed = []
            for s in stocks:
                sym = str(s['symbol']).upper()
                mk = market_from_symbol(sym) if not has_local_data(sym, market) else market
                if not has_local_data(sym, mk): continue
                score = run_pre_rise(sym, mk)
                if score: passed.append({'symbol': sym, 'name': s.get('name',''), 'market': mk, **score})
            if passed:
                print(f"  [{theme['name']}] → {len(passed)}개")
                all_results.append({'theme': theme['name'], 'market': market, 'stocks': passed})
    out = []
    for r in all_results:
        for s in r['stocks']:
            sf = f"{s['symbol']}_KR" if s['market']=='KR' else (f"{s['symbol']}_UPBIT" if s['market']=='UPBIT' else s['symbol'])
            out.append({'theme': r['theme'], 'symbol': sf, 'name': s['name'], 'market': s['market'], 'vol_growth': s['vol_growth'], 'rs': s['rs'], 'lead': s['lead']})
    with open('/root/seungjae20260713/api-server/pre_rise_candidates.json','w') as f:
        json.dump({'updated': datetime.now().isoformat(), 'candidates': out}, f, ensure_ascii=False, indent=2)
    print(f"\n✅ 총 {len(out)}개 저장")
    for o in out[:20]: print(f"  {o['symbol']:<15} [{o['theme']}] vol={o['vol_growth']:+.0f}%")

if __name__ == '__main__': main()
