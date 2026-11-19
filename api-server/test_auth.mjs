import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config({ path: '/root/seungjae20260713/.env' });
dotenv.config({ path: '/root/seungjae20260713/api-server/.env' });

const API_KEY = process.env.BITGET_API_KEY || process.env.API_KEY || "";
const API_SECRET = process.env.BITGET_SECRET_KEY || process.env.SECRET_KEY || "";
const API_PASSPHRASE = process.env.BITGET_PASSPHRASE || process.env.PASSPHRASE || "";

console.log("🔑 [키 로드 상태 진단]");
console.log("- API_KEY:", API_KEY ? `${API_KEY.substring(0, 6)}... (길이: ${API_KEY.length})` : "❌ 비어있음");
console.log("- API_SECRET:", API_SECRET ? `(길이: ${API_SECRET.length})` : "❌ 비어있음");
console.log("- API_PASSPHRASE:", API_PASSPHRASE ? `(길이: ${API_PASSPHRASE.length})` : "❌ 비어있음");

if (!API_KEY || !API_SECRET) {
    console.error("❌ API Key 또는 Secret이 로드되지 않았습니다!");
    process.exit(1);
}

const timestamp = Date.now().toString();
const method = 'GET';
const requestPath = '/api/v2/mix/account/accounts?productType=usdt-futures';
const message = timestamp + method + requestPath + '';
const signature = crypto.createHmac('sha256', API_SECRET).update(message).digest('base64');

async function test() {
    try {
        const res = await fetch(`https://api.bitget.com${requestPath}`, {
            method: 'GET',
            headers: {
                'ACCESS-KEY': API_KEY,
                'ACCESS-SIGN': signature,
                'ACCESS-TIMESTAMP': timestamp,
                'ACCESS-PASSPHRASE': API_PASSPHRASE,
                'Content-Type': 'application/json',
                'Locale': 'en_US'
            }
        });
        const json = await res.json();
        console.log("🎯 [비트겟 응답 결과]:", JSON.stringify(json, null, 2));
    } catch (e) {
        console.error("❌ 통신 에러:", e.message);
    }
}

test();
