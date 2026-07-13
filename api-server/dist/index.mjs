
import { createRequire as __createRequire } from 'node:module';
const require = __createRequire(import.meta.url);


// src/index.ts
import express from "express";
import cors from "cors";
import path2 from "node:path";
import fs2 from "node:fs";
import { fileURLToPath } from "node:url";

// src/routes/index.ts
import { Router as Router9 } from "express";

// src/routes/health.ts
import { Router } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
var router = Router();
router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});
var health_default = router;

// src/routes/market.ts
import { Router as Router2 } from "express";

// src/data/catalog.ts
var CATALOG = [
  // US stocks
  { ticker: "HLP", name: "HLP Inc", market: "US", currency: "USD" },
  { ticker: "AAPL", name: "Apple", market: "US", currency: "USD" },
  { ticker: "MSFT", name: "Microsoft", market: "US", currency: "USD" },
  { ticker: "GOOGL", name: "Alphabet", market: "US", currency: "USD" },
  { ticker: "AMZN", name: "Amazon", market: "US", currency: "USD" },
  { ticker: "META", name: "Meta Platforms", market: "US", currency: "USD" },
  { ticker: "NVDA", name: "NVIDIA", market: "US", currency: "USD" },
  { ticker: "TSLA", name: "Tesla", market: "US", currency: "USD" },
  { ticker: "PLTR", name: "Palantir Technologies", market: "US", currency: "USD" },
  { ticker: "RGTI", name: "Rigetti Computing", market: "US", currency: "USD" },
  { ticker: "CMMB", name: "Chemomab Therapeutics", market: "US", currency: "USD" },
  { ticker: "ORCL", name: "Oracle", market: "US", currency: "USD" },
  { ticker: "ADBE", name: "Adobe", market: "US", currency: "USD" },
  { ticker: "CRM", name: "Salesforce", market: "US", currency: "USD" },
  { ticker: "INTC", name: "Intel", market: "US", currency: "USD" },
  { ticker: "AMD", name: "Advanced Micro Devices", market: "US", currency: "USD" },
  { ticker: "QCOM", name: "Qualcomm", market: "US", currency: "USD" },
  { ticker: "TXN", name: "Texas Instruments", market: "US", currency: "USD" },
  { ticker: "IBM", name: "IBM", market: "US", currency: "USD" },
  { ticker: "CSCO", name: "Cisco Systems", market: "US", currency: "USD" },
  { ticker: "NOW", name: "ServiceNow", market: "US", currency: "USD" },
  { ticker: "INTU", name: "Intuit", market: "US", currency: "USD" },
  { ticker: "PANW", name: "Palo Alto Networks", market: "US", currency: "USD" },
  { ticker: "SNOW", name: "Snowflake", market: "US", currency: "USD" },
  { ticker: "AVGO", name: "Broadcom", market: "US", currency: "USD" },
  { ticker: "MU", name: "Micron Technology", market: "US", currency: "USD" },
  { ticker: "ASML", name: "ASML Holding", market: "US", currency: "USD" },
  { ticker: "LRCX", name: "Lam Research", market: "US", currency: "USD" },
  { ticker: "KLAC", name: "KLA Corporation", market: "US", currency: "USD" },
  { ticker: "ON", name: "ON Semiconductor", market: "US", currency: "USD" },
  { ticker: "F", name: "Ford Motor", market: "US", currency: "USD" },
  { ticker: "GM", name: "General Motors", market: "US", currency: "USD" },
  { ticker: "RIVN", name: "Rivian Automotive", market: "US", currency: "USD" },
  { ticker: "LCID", name: "Lucid Group", market: "US", currency: "USD" },
  { ticker: "NIO", name: "NIO", market: "US", currency: "USD" },
  { ticker: "JPM", name: "JPMorgan Chase", market: "US", currency: "USD" },
  { ticker: "BAC", name: "Bank of America", market: "US", currency: "USD" },
  { ticker: "WFC", name: "Wells Fargo", market: "US", currency: "USD" },
  { ticker: "GS", name: "Goldman Sachs", market: "US", currency: "USD" },
  { ticker: "MS", name: "Morgan Stanley", market: "US", currency: "USD" },
  { ticker: "C", name: "Citigroup", market: "US", currency: "USD" },
  { ticker: "AXP", name: "American Express", market: "US", currency: "USD" },
  { ticker: "V", name: "Visa", market: "US", currency: "USD" },
  { ticker: "MA", name: "Mastercard", market: "US", currency: "USD" },
  { ticker: "PYPL", name: "PayPal Holdings", market: "US", currency: "USD" },
  { ticker: "SCHW", name: "Charles Schwab", market: "US", currency: "USD" },
  { ticker: "BLK", name: "BlackRock", market: "US", currency: "USD" },
  { ticker: "WMT", name: "Walmart", market: "US", currency: "USD" },
  { ticker: "COST", name: "Costco Wholesale", market: "US", currency: "USD" },
  { ticker: "TGT", name: "Target", market: "US", currency: "USD" },
  { ticker: "HD", name: "Home Depot", market: "US", currency: "USD" },
  { ticker: "LOW", name: "Lowe's", market: "US", currency: "USD" },
  { ticker: "NKE", name: "Nike", market: "US", currency: "USD" },
  { ticker: "SBUX", name: "Starbucks", market: "US", currency: "USD" },
  { ticker: "MCD", name: "McDonald's", market: "US", currency: "USD" },
  { ticker: "KO", name: "Coca-Cola", market: "US", currency: "USD" },
  { ticker: "PEP", name: "PepsiCo", market: "US", currency: "USD" },
  { ticker: "PG", name: "Procter & Gamble", market: "US", currency: "USD" },
  { ticker: "CL", name: "Colgate-Palmolive", market: "US", currency: "USD" },
  { ticker: "JNJ", name: "Johnson & Johnson", market: "US", currency: "USD" },
  { ticker: "PFE", name: "Pfizer", market: "US", currency: "USD" },
  { ticker: "MRK", name: "Merck", market: "US", currency: "USD" },
  { ticker: "UNH", name: "UnitedHealth Group", market: "US", currency: "USD" },
  { ticker: "ABBV", name: "AbbVie", market: "US", currency: "USD" },
  { ticker: "LLY", name: "Eli Lilly", market: "US", currency: "USD" },
  { ticker: "TMO", name: "Thermo Fisher Scientific", market: "US", currency: "USD" },
  { ticker: "ABT", name: "Abbott Laboratories", market: "US", currency: "USD" },
  { ticker: "MRNA", name: "Moderna", market: "US", currency: "USD" },
  { ticker: "GILD", name: "Gilead Sciences", market: "US", currency: "USD" },
  { ticker: "XOM", name: "ExxonMobil", market: "US", currency: "USD" },
  { ticker: "CVX", name: "Chevron", market: "US", currency: "USD" },
  { ticker: "COP", name: "ConocoPhillips", market: "US", currency: "USD" },
  { ticker: "SLB", name: "Schlumberger", market: "US", currency: "USD" },
  { ticker: "OXY", name: "Occidental Petroleum", market: "US", currency: "USD" },
  { ticker: "BA", name: "Boeing", market: "US", currency: "USD" },
  { ticker: "CAT", name: "Caterpillar", market: "US", currency: "USD" },
  { ticker: "GE", name: "General Electric", market: "US", currency: "USD" },
  { ticker: "HON", name: "Honeywell", market: "US", currency: "USD" },
  { ticker: "LMT", name: "Lockheed Martin", market: "US", currency: "USD" },
  { ticker: "RTX", name: "RTX Corporation", market: "US", currency: "USD" },
  { ticker: "UPS", name: "United Parcel Service", market: "US", currency: "USD" },
  { ticker: "FDX", name: "FedEx", market: "US", currency: "USD" },
  { ticker: "DIS", name: "Walt Disney", market: "US", currency: "USD" },
  { ticker: "NFLX", name: "Netflix", market: "US", currency: "USD" },
  { ticker: "CMCSA", name: "Comcast", market: "US", currency: "USD" },
  { ticker: "WBD", name: "Warner Bros. Discovery", market: "US", currency: "USD" },
  { ticker: "DAL", name: "Delta Air Lines", market: "US", currency: "USD" },
  { ticker: "UAL", name: "United Airlines", market: "US", currency: "USD" },
  { ticker: "AAL", name: "American Airlines", market: "US", currency: "USD" },
  { ticker: "LUV", name: "Southwest Airlines", market: "US", currency: "USD" },
  { ticker: "T", name: "AT&T", market: "US", currency: "USD" },
  { ticker: "VZ", name: "Verizon Communications", market: "US", currency: "USD" },
  { ticker: "TMUS", name: "T-Mobile US", market: "US", currency: "USD" },
  { ticker: "MSTR", name: "MicroStrategy", market: "US", currency: "USD" },
  { ticker: "COIN", name: "Coinbase Global", market: "US", currency: "USD" },
  { ticker: "SQ", name: "Block", market: "US", currency: "USD" },
  { ticker: "GME", name: "GameStop", market: "US", currency: "USD" },
  { ticker: "AMC", name: "AMC Entertainment", market: "US", currency: "USD" },
  { ticker: "SOFI", name: "SoFi Technologies", market: "US", currency: "USD" },
  // US ETF / leveraged / inverse
  { ticker: "SPY", name: "SPDR S&P 500 ETF Trust", market: "US", currency: "USD" },
  { ticker: "QQQ", name: "Invesco QQQ Trust", market: "US", currency: "USD" },
  { ticker: "DIA", name: "SPDR Dow Jones Industrial Average ETF", market: "US", currency: "USD" },
  { ticker: "IWM", name: "iShares Russell 2000 ETF", market: "US", currency: "USD" },
  { ticker: "VOO", name: "Vanguard S&P 500 ETF", market: "US", currency: "USD" },
  { ticker: "VTI", name: "Vanguard Total Stock Market ETF", market: "US", currency: "USD" },
  { ticker: "SCHD", name: "Schwab US Dividend Equity ETF", market: "US", currency: "USD" },
  { ticker: "JEPI", name: "JPMorgan Equity Premium Income ETF", market: "US", currency: "USD" },
  { ticker: "JEPQ", name: "JPMorgan Nasdaq Equity Premium Income ETF", market: "US", currency: "USD" },
  { ticker: "SMH", name: "VanEck Semiconductor ETF", market: "US", currency: "USD" },
  { ticker: "SOXX", name: "iShares Semiconductor ETF", market: "US", currency: "USD" },
  { ticker: "XLK", name: "Technology Select Sector SPDR Fund", market: "US", currency: "USD" },
  { ticker: "XLE", name: "Energy Select Sector SPDR Fund", market: "US", currency: "USD" },
  { ticker: "XLF", name: "Financial Select Sector SPDR Fund", market: "US", currency: "USD" },
  { ticker: "XLV", name: "Health Care Select Sector SPDR Fund", market: "US", currency: "USD" },
  { ticker: "XLI", name: "Industrial Select Sector SPDR Fund", market: "US", currency: "USD" },
  { ticker: "ARKK", name: "ARK Innovation ETF", market: "US", currency: "USD" },
  { ticker: "ARKG", name: "ARK Genomic Revolution ETF", market: "US", currency: "USD" },
  { ticker: "ARKW", name: "ARK Next Generation Internet ETF", market: "US", currency: "USD" },
  { ticker: "SOXL", name: "Direxion Daily Semiconductor Bull 3X", market: "US", currency: "USD" },
  { ticker: "SOXS", name: "Direxion Daily Semiconductor Bear 3X", market: "US", currency: "USD" },
  { ticker: "TQQQ", name: "ProShares UltraPro QQQ 3X", market: "US", currency: "USD" },
  { ticker: "SQQQ", name: "ProShares UltraPro Short QQQ 3X", market: "US", currency: "USD" },
  { ticker: "SPXL", name: "Direxion Daily S&P 500 Bull 3X", market: "US", currency: "USD" },
  { ticker: "SPXS", name: "Direxion Daily S&P 500 Bear 3X", market: "US", currency: "USD" },
  { ticker: "TECL", name: "Direxion Daily Technology Bull 3X", market: "US", currency: "USD" },
  { ticker: "TECS", name: "Direxion Daily Technology Bear 3X", market: "US", currency: "USD" },
  { ticker: "LABU", name: "Direxion Daily S&P Biotech Bull 3X", market: "US", currency: "USD" },
  { ticker: "LABD", name: "Direxion Daily S&P Biotech Bear 3X", market: "US", currency: "USD" },
  { ticker: "BOIL", name: "ProShares Ultra Bloomberg Natural Gas", market: "US", currency: "USD" },
  { ticker: "KOLD", name: "ProShares UltraShort Bloomberg Natural Gas", market: "US", currency: "USD" },
  { ticker: "UVXY", name: "ProShares Ultra VIX Short-Term Futures ETF", market: "US", currency: "USD" },
  // KR stocks
  { ticker: "005930", name: "\uC0BC\uC131\uC804\uC790", market: "KR", currency: "KRW" },
  { ticker: "000660", name: "SK\uD558\uC774\uB2C9\uC2A4", market: "KR", currency: "KRW" },
  { ticker: "005380", name: "\uD604\uB300\uCC28", market: "KR", currency: "KRW" },
  { ticker: "000270", name: "\uAE30\uC544", market: "KR", currency: "KRW" },
  { ticker: "005490", name: "POSCO\uD640\uB529\uC2A4", market: "KR", currency: "KRW" },
  { ticker: "035420", name: "NAVER", market: "KR", currency: "KRW" },
  { ticker: "035720", name: "\uCE74\uCE74\uC624", market: "KR", currency: "KRW" },
  { ticker: "373220", name: "LG\uC5D0\uB108\uC9C0\uC194\uB8E8\uC158", market: "KR", currency: "KRW" },
  { ticker: "068270", name: "\uC140\uD2B8\uB9AC\uC628", market: "KR", currency: "KRW" },
  { ticker: "207940", name: "\uC0BC\uC131\uBC14\uC774\uC624\uB85C\uC9C1\uC2A4", market: "KR", currency: "KRW" },
  { ticker: "051910", name: "LG\uD654\uD559", market: "KR", currency: "KRW" },
  { ticker: "006400", name: "\uC0BC\uC131SDI", market: "KR", currency: "KRW" },
  { ticker: "028260", name: "\uC0BC\uC131\uBB3C\uC0B0", market: "KR", currency: "KRW" },
  { ticker: "012330", name: "\uD604\uB300\uBAA8\uBE44\uC2A4", market: "KR", currency: "KRW" },
  { ticker: "066570", name: "LG\uC804\uC790", market: "KR", currency: "KRW" },
  { ticker: "003670", name: "\uD3EC\uC2A4\uCF54\uD4E8\uCC98\uC5E0", market: "KR", currency: "KRW" },
  { ticker: "096770", name: "SK\uC774\uB178\uBCA0\uC774\uC158", market: "KR", currency: "KRW" },
  { ticker: "034730", name: "SK", market: "KR", currency: "KRW" },
  { ticker: "015760", name: "\uD55C\uAD6D\uC804\uB825", market: "KR", currency: "KRW" },
  { ticker: "032830", name: "\uC0BC\uC131\uC0DD\uBA85", market: "KR", currency: "KRW" },
  { ticker: "086790", name: "\uD558\uB098\uAE08\uC735\uC9C0\uC8FC", market: "KR", currency: "KRW" },
  { ticker: "105560", name: "KB\uAE08\uC735", market: "KR", currency: "KRW" },
  { ticker: "055550", name: "\uC2E0\uD55C\uC9C0\uC8FC", market: "KR", currency: "KRW" },
  { ticker: "316140", name: "\uC6B0\uB9AC\uAE08\uC735\uC9C0\uC8FC", market: "KR", currency: "KRW" },
  { ticker: "024110", name: "\uAE30\uC5C5\uC740\uD589", market: "KR", currency: "KRW" },
  { ticker: "010130", name: "\uACE0\uB824\uC544\uC5F0", market: "KR", currency: "KRW" },
  { ticker: "011200", name: "HMM", market: "KR", currency: "KRW" },
  { ticker: "010950", name: "S-Oil", market: "KR", currency: "KRW" },
  { ticker: "009150", name: "\uC0BC\uC131\uC804\uAE30", market: "KR", currency: "KRW" },
  { ticker: "018260", name: "\uC0BC\uC131\uC5D0\uC2A4\uB514\uC5D0\uC2A4", market: "KR", currency: "KRW" },
  { ticker: "032640", name: "LG\uC720\uD50C\uB7EC\uC2A4", market: "KR", currency: "KRW" },
  { ticker: "030200", name: "KT", market: "KR", currency: "KRW" },
  { ticker: "017670", name: "SK\uD154\uB808\uCF64", market: "KR", currency: "KRW" },
  { ticker: "011070", name: "LG\uC774\uB178\uD14D", market: "KR", currency: "KRW" },
  { ticker: "000810", name: "\uC0BC\uC131\uD654\uC7AC", market: "KR", currency: "KRW" },
  { ticker: "036570", name: "\uC5D4\uC528\uC18C\uD504\uD2B8", market: "KR", currency: "KRW" },
  { ticker: "251270", name: "\uB137\uB9C8\uBE14", market: "KR", currency: "KRW" },
  { ticker: "263750", name: "\uD384\uC5B4\uBE44\uC2A4", market: "KR", currency: "KRW" },
  { ticker: "293490", name: "\uCE74\uCE74\uC624\uAC8C\uC784\uC988", market: "KR", currency: "KRW" },
  { ticker: "352820", name: "\uD558\uC774\uBE0C", market: "KR", currency: "KRW" },
  { ticker: "041510", name: "\uC5D0\uC2A4\uC5E0", market: "KR", currency: "KRW" },
  { ticker: "122870", name: "\uC640\uC774\uC9C0\uC5D4\uD130\uD14C\uC778\uBA3C\uD2B8", market: "KR", currency: "KRW" },
  { ticker: "035900", name: "JYP Ent.", market: "KR", currency: "KRW" },
  { ticker: "090430", name: "\uC544\uBAA8\uB808\uD37C\uC2DC\uD53D", market: "KR", currency: "KRW" },
  { ticker: "051900", name: "LG\uC0DD\uD65C\uAC74\uAC15", market: "KR", currency: "KRW" },
  { ticker: "097950", name: "CJ\uC81C\uC77C\uC81C\uB2F9", market: "KR", currency: "KRW" },
  { ticker: "004370", name: "\uB18D\uC2EC", market: "KR", currency: "KRW" },
  { ticker: "271560", name: "\uC624\uB9AC\uC628", market: "KR", currency: "KRW" },
  { ticker: "000080", name: "\uD558\uC774\uD2B8\uC9C4\uB85C", market: "KR", currency: "KRW" },
  { ticker: "139480", name: "\uC774\uB9C8\uD2B8", market: "KR", currency: "KRW" },
  { ticker: "069960", name: "\uD604\uB300\uBC31\uD654\uC810", market: "KR", currency: "KRW" },
  { ticker: "282330", name: "BGF\uB9AC\uD14C\uC77C", market: "KR", currency: "KRW" },
  { ticker: "078930", name: "GS", market: "KR", currency: "KRW" },
  { ticker: "000720", name: "\uD604\uB300\uAC74\uC124", market: "KR", currency: "KRW" },
  { ticker: "047040", name: "\uB300\uC6B0\uAC74\uC124", market: "KR", currency: "KRW" },
  { ticker: "006360", name: "GS\uAC74\uC124", market: "KR", currency: "KRW" },
  { ticker: "010060", name: "OCI\uD640\uB529\uC2A4", market: "KR", currency: "KRW" },
  { ticker: "011780", name: "\uAE08\uD638\uC11D\uC720", market: "KR", currency: "KRW" },
  { ticker: "010140", name: "\uC0BC\uC131\uC911\uACF5\uC5C5", market: "KR", currency: "KRW" },
  { ticker: "042660", name: "\uD55C\uD654\uC624\uC158", market: "KR", currency: "KRW" },
  { ticker: "329180", name: "HD\uD604\uB300\uC911\uACF5\uC5C5", market: "KR", currency: "KRW" },
  { ticker: "267250", name: "HD\uD604\uB300", market: "KR", currency: "KRW" },
  { ticker: "010620", name: "HD\uD604\uB300\uBBF8\uD3EC", market: "KR", currency: "KRW" },
  { ticker: "003490", name: "\uB300\uD55C\uD56D\uACF5", market: "KR", currency: "KRW" },
  { ticker: "020560", name: "\uC544\uC2DC\uC544\uB098\uD56D\uACF5", market: "KR", currency: "KRW" },
  { ticker: "180640", name: "\uD55C\uC9C4\uCE7C", market: "KR", currency: "KRW" },
  { ticker: "000120", name: "CJ\uB300\uD55C\uD1B5\uC6B4", market: "KR", currency: "KRW" },
  { ticker: "039490", name: "\uD0A4\uC6C0\uC99D\uAD8C", market: "KR", currency: "KRW" },
  { ticker: "016360", name: "\uC0BC\uC131\uC99D\uAD8C", market: "KR", currency: "KRW" },
  { ticker: "071050", name: "\uD55C\uAD6D\uAE08\uC735\uC9C0\uC8FC", market: "KR", currency: "KRW" },
  { ticker: "323410", name: "\uCE74\uCE74\uC624\uBC45\uD06C", market: "KR", currency: "KRW" },
  { ticker: "006800", name: "\uBBF8\uB798\uC5D0\uC14B\uC99D\uAD8C", market: "KR", currency: "KRW" },
  { ticker: "138040", name: "\uBA54\uB9AC\uCE20\uAE08\uC735\uC9C0\uC8FC", market: "KR", currency: "KRW" },
  { ticker: "000100", name: "\uC720\uD55C\uC591\uD589", market: "KR", currency: "KRW" },
  { ticker: "128940", name: "\uD55C\uBBF8\uC57D\uD488", market: "KR", currency: "KRW" },
  { ticker: "185750", name: "\uC885\uADFC\uB2F9", market: "KR", currency: "KRW" },
  { ticker: "069620", name: "\uB300\uC6C5\uC81C\uC57D", market: "KR", currency: "KRW" },
  { ticker: "326030", name: "SK\uBC14\uC774\uC624\uD31C", market: "KR", currency: "KRW" },
  { ticker: "145020", name: "\uD734\uC824", market: "KR", currency: "KRW" },
  { ticker: "214150", name: "\uD074\uB798\uC2DC\uC2A4", market: "KR", currency: "KRW" },
  { ticker: "006280", name: "\uB179\uC2ED\uC790", market: "KR", currency: "KRW" },
  { ticker: "034220", name: "LG\uB514\uC2A4\uD50C\uB808\uC774", market: "KR", currency: "KRW" },
  { ticker: "009830", name: "\uD55C\uD654\uC194\uB8E8\uC158", market: "KR", currency: "KRW" },
  { ticker: "000880", name: "\uD55C\uD654", market: "KR", currency: "KRW" },
  { ticker: "012450", name: "\uD55C\uD654\uC5D0\uC5B4\uB85C\uC2A4\uD398\uC774\uC2A4", market: "KR", currency: "KRW" },
  { ticker: "047810", name: "\uD55C\uAD6D\uD56D\uACF5\uC6B0\uC8FC", market: "KR", currency: "KRW" },
  { ticker: "272210", name: "\uD55C\uD654\uC2DC\uC2A4\uD15C", market: "KR", currency: "KRW" },
  { ticker: "042700", name: "\uD55C\uBBF8\uBC18\uB3C4\uCCB4", market: "KR", currency: "KRW" },
  { ticker: "000990", name: "DB\uD558\uC774\uD14D", market: "KR", currency: "KRW" },
  { ticker: "036460", name: "\uD55C\uAD6D\uAC00\uC2A4\uACF5\uC0AC", market: "KR", currency: "KRW" },
  { ticker: "004020", name: "\uD604\uB300\uC81C\uCCA0", market: "KR", currency: "KRW" },
  { ticker: "001450", name: "\uD604\uB300\uD574\uC0C1", market: "KR", currency: "KRW" },
  { ticker: "000060", name: "\uBA54\uB9AC\uCE20\uD654\uC7AC", market: "KR", currency: "KRW" },
  { ticker: "088350", name: "\uD55C\uD654\uC0DD\uBA85", market: "KR", currency: "KRW" },
  { ticker: "001040", name: "CJ", market: "KR", currency: "KRW" },
  { ticker: "302440", name: "SK\uBC14\uC774\uC624\uC0AC\uC774\uC5B8\uC2A4", market: "KR", currency: "KRW" },
  { ticker: "011790", name: "SKC", market: "KR", currency: "KRW" },
  { ticker: "003550", name: "LG", market: "KR", currency: "KRW" },
  { ticker: "005940", name: "NH\uD22C\uC790\uC99D\uAD8C", market: "KR", currency: "KRW" },
  { ticker: "064350", name: "\uD604\uB300\uB85C\uD15C", market: "KR", currency: "KRW" },
  // KR ETF / ETN
  { ticker: "069500", name: "KODEX 200", market: "KR", currency: "KRW" },
  { ticker: "102110", name: "TIGER 200", market: "KR", currency: "KRW" },
  { ticker: "278530", name: "KODEX 200TR", market: "KR", currency: "KRW" },
  { ticker: "091160", name: "KODEX \uBC18\uB3C4\uCCB4", market: "KR", currency: "KRW" },
  { ticker: "091230", name: "TIGER \uBC18\uB3C4\uCCB4", market: "KR", currency: "KRW" },
  { ticker: "396500", name: "TIGER Fn\uBC18\uB3C4\uCCB4TOP10", market: "KR", currency: "KRW" },
  { ticker: "381180", name: "TIGER \uBBF8\uAD6D\uD544\uB77C\uB378\uD53C\uC544\uBC18\uB3C4\uCCB4\uB098\uC2A4\uB2E5", market: "KR", currency: "KRW" },
  { ticker: "390390", name: "KODEX \uBBF8\uAD6D\uBC18\uB3C4\uCCB4MV", market: "KR", currency: "KRW" },
  { ticker: "133690", name: "TIGER \uBBF8\uAD6D\uB098\uC2A4\uB2E5100", market: "KR", currency: "KRW" },
  { ticker: "379810", name: "KODEX \uBBF8\uAD6D\uB098\uC2A4\uB2E5100TR", market: "KR", currency: "KRW" },
  { ticker: "360750", name: "TIGER \uBBF8\uAD6DS&P500", market: "KR", currency: "KRW" },
  { ticker: "379800", name: "KODEX \uBBF8\uAD6DS&P500TR", market: "KR", currency: "KRW" },
  { ticker: "233740", name: "KODEX \uCF54\uC2A4\uB2E5150\uB808\uBC84\uB9AC\uC9C0", market: "KR", currency: "KRW" },
  { ticker: "252670", name: "KODEX 200\uC120\uBB3C\uC778\uBC84\uC2A42X", market: "KR", currency: "KRW" },
  { ticker: "122630", name: "KODEX \uB808\uBC84\uB9AC\uC9C0", market: "KR", currency: "KRW" },
  { ticker: "114800", name: "KODEX \uC778\uBC84\uC2A4", market: "KR", currency: "KRW" },
  { ticker: "233160", name: "TIGER \uCF54\uC2A4\uB2E5150 \uB808\uBC84\uB9AC\uC9C0", market: "KR", currency: "KRW" },
  { ticker: "305720", name: "KODEX 2\uCC28\uC804\uC9C0\uC0B0\uC5C5", market: "KR", currency: "KRW" },
  { ticker: "305540", name: "TIGER 2\uCC28\uC804\uC9C0\uD14C\uB9C8", market: "KR", currency: "KRW" },
  { ticker: "449450", name: "PLUS K\uBC29\uC0B0", market: "KR", currency: "KRW" },
  { ticker: "483340", name: "ACE \uAD6C\uAE00\uBC38\uB958\uCCB4\uC778\uC561\uD2F0\uBE0C", market: "KR", currency: "KRW" },
  { ticker: "367380", name: "KODEX \uBBF8\uAD6D\uB098\uC2A4\uB2E5100\uB808\uBC84\uB9AC\uC9C0(\uD569\uC131 H)", market: "KR", currency: "KRW" },
  { ticker: "409820", name: "KODEX \uBBF8\uAD6D\uB098\uC2A4\uB2E5100\uC120\uBB3C\uC778\uBC84\uC2A4(H)", market: "KR", currency: "KRW" },
  // KR ETF / ETN 대표 종목
  { ticker: "364960", name: "TIGER KRX2\uCC28\uC804\uC9C0K-\uB274\uB51C", market: "KR", currency: "KRW" },
  { ticker: "371460", name: "TIGER \uCC28\uC774\uB098\uC804\uAE30\uCC28SOLACTIVE", market: "KR", currency: "KRW" },
  { ticker: "143850", name: "TIGER \uBBF8\uAD6DS&P500\uC120\uBB3C(H)", market: "KR", currency: "KRW" },
  { ticker: "195930", name: "TIGER \uC720\uB85C\uC2A4\uD0C1\uC2A450", market: "KR", currency: "KRW" },
  { ticker: "229200", name: "KODEX \uCF54\uC2A4\uB2E5150", market: "KR", currency: "KRW" },
  { ticker: "251340", name: "KODEX \uCF54\uC2A4\uB2E5150\uC120\uBB3C\uC778\uBC84\uC2A4", market: "KR", currency: "KRW" },
  { ticker: "250780", name: "TIGER \uCF54\uC2A4\uB2E5150\uC120\uBB3C\uC778\uBC84\uC2A4", market: "KR", currency: "KRW" },
  { ticker: "157490", name: "TIGER \uC18C\uD504\uD2B8\uC6E8\uC5B4", market: "KR", currency: "KRW" },
  { ticker: "228800", name: "TIGER \uC5EC\uD589\uB808\uC800", market: "KR", currency: "KRW" },
  { ticker: "364970", name: "TIGER KRX\uBC14\uC774\uC624K-\uB274\uB51C", market: "KR", currency: "KRW" },
  { ticker: "473460", name: "KODEX \uBBF8\uAD6D\uC11C\uD559\uAC1C\uBBF8", market: "KR", currency: "KRW" }
];
var BY_TICKER = new Map(CATALOG.map((e) => [e.ticker.toUpperCase(), e]));
var DYNAMIC = /* @__PURE__ */ new Map();
function registerDynamicEntry(e) {
  const k = e.ticker.toUpperCase();
  if (!BY_TICKER.has(k)) DYNAMIC.set(k, e);
}
function getCatalogEntry(ticker) {
  const k = ticker.toUpperCase();
  return BY_TICKER.get(k) ?? DYNAMIC.get(k);
}

// src/data/asset-type.ts
var KR_FUND_BRANDS = [
  "KODEX",
  "TIGER",
  "ACE",
  "SOL",
  "KBSTAR",
  "HANARO",
  "RISE",
  "TIMEFOLIO",
  "ARIRANG",
  "PLUS",
  "KOSEF",
  "KIWOOM",
  "WON",
  "FOCUS",
  "TREX",
  "BNK",
  "HK",
  "\uB9C8\uC774\uD2F0",
  "\uD788\uC5B4\uB85C\uC988"
];
function hasLeverage(name) {
  return /(레버리지|2배|3배|2X|3X|bull|ultra|leveraged)/i.test(name);
}
function hasInverse(name) {
  return /(인버스|곱버스|inverse|bear|short|-1x|-2x|reverse)/i.test(name);
}
function classifyAssetType(name, _market, rawType) {
  const n = name ?? "";
  const upper = n.toUpperCase();
  const t = (rawType ?? "").toLowerCase();
  const lev = hasLeverage(n);
  const inv = hasInverse(n);
  const isReit = /리츠$/.test(n) || /reit/i.test(n) || t.includes("reit");
  const isEtn2 = /상장지수증권|\betn\b/i.test(n) || t.includes("etn");
  const brandFund = KR_FUND_BRANDS.some((b) => upper.includes(b));
  const isEtf = t === "etp" || t.includes("etf") || /상장지수펀드|\betf\b/i.test(n) || brandFund || // Leverage/inverse naming (Bull/Bear/3X/UltraPro/...) is a reliable ETP
  // signal even when the provider type is missing (e.g. Finnhub tags SOXL as
  // a common stock).
  (lev || inv) && !isEtn2;
  if (isReit) return "REIT";
  if (isEtn2) {
    if (inv) return "INVERSE_ETN";
    if (lev) return "LEVERAGED_ETN";
    return "ETN";
  }
  if (isEtf) {
    if (inv) return "INVERSE_ETF";
    if (lev) return "LEVERAGED_ETF";
    return "ETF";
  }
  if (t === "adr" || /\badr\b/i.test(n)) return "ADR";
  return "STOCK";
}
var ETP_TYPES = /* @__PURE__ */ new Set([
  "ETF",
  "ETN",
  "LEVERAGED_ETF",
  "INVERSE_ETF",
  "LEVERAGED_ETN",
  "INVERSE_ETN"
]);
function isEtp(a) {
  return ETP_TYPES.has(a);
}
function isLeveraged(a) {
  return a === "LEVERAGED_ETF" || a === "LEVERAGED_ETN";
}
function isInverse(a) {
  return a === "INVERSE_ETF" || a === "INVERSE_ETN";
}
function isEtn(a) {
  return a === "ETN" || a === "LEVERAGED_ETN" || a === "INVERSE_ETN";
}

// src/sample/rng.ts
function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
var ANCHOR_MS = Date.UTC(2026, 6, 8);
function anchorDate() {
  return new Date(ANCHOR_MS);
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return function() {
    a |= 0;
    a = a + 1831565813 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function seeded(...parts) {
  return mulberry32(hashString(parts.join(":")));
}
function rangeInt(rng, min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}
function rangeFloat(rng, min, max) {
  return rng() * (max - min) + min;
}
function qualityScore(ticker) {
  const r = seeded(ticker, "quality");
  return Math.round(r() * 100);
}

// src/sample/market.ts
function basePrice(entry) {
  const r = seeded(entry.ticker, "price");
  if (entry.market === "KR") return Math.round(rangeFloat(r, 5e3, 28e4) / 10) * 10;
  return Math.round(rangeFloat(r, 8, 460) * 100) / 100;
}
function shares(entry) {
  const r = seeded(entry.ticker, "shares");
  return entry.market === "KR" ? Math.round(rangeFloat(r, 1e8, 6e9)) : Math.round(rangeFloat(r, 4e7, 3e9));
}
function fmtDay(d) {
  return d.toISOString().slice(0, 10);
}
function tradingDays(n, end) {
  const out = [];
  const d = new Date(end);
  while (out.length < n) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) out.unshift(fmtDay(d));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}
function walk(rng, start, times, vol, drift) {
  let price = start;
  const bars = [];
  for (const time of times) {
    const open = price;
    const change = (rng() - 0.5) * 2 * vol + drift;
    let close = open * (1 + change);
    if (close < 0.5) close = 0.5;
    const hi = Math.max(open, close) * (1 + rng() * vol * 0.6);
    const lo = Math.min(open, close) * (1 - rng() * vol * 0.6);
    const volume = Math.round(rangeFloat(rng, 0.4, 2.4) * 1e6);
    bars.push({ time, open: r2(open), high: r2(hi), low: r2(lo), close: r2(close), volume });
    price = close;
  }
  return bars;
}
function r2(n) {
  return Math.round(n * 100) / 100;
}
var DAILY_COUNT = 400;
function dailySeries(entry) {
  const rng = seeded(entry.ticker, "daily");
  const vol = rangeFloat(rng, 0.012, 0.032);
  const drift = (qualityScore(entry.ticker) - 50) / 50 * 7e-4;
  const days = tradingDays(DAILY_COUNT, anchorDate());
  const start = basePrice(entry) / (1 + drift * DAILY_COUNT);
  return walk(rng, Math.max(start, 1), days, vol, drift);
}
function aggregate(daily, keyOf) {
  const groups = /* @__PURE__ */ new Map();
  const order = [];
  for (const c of daily) {
    const key = keyOf(String(c.time));
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key).push(c);
  }
  return order.map((key) => {
    const g = groups.get(key);
    return {
      time: g[g.length - 1].time,
      open: g[0].open,
      high: Math.max(...g.map((c) => c.high)),
      low: Math.min(...g.map((c) => c.low)),
      close: g[g.length - 1].close,
      volume: g.reduce((s, c) => s + c.volume, 0)
    };
  });
}
function isoWeekKey(dateStr) {
  const d = /* @__PURE__ */ new Date(dateStr + "T00:00:00Z");
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return fmtDay(d);
}
function intradaySeries(entry, tf) {
  const stepMin = { "1m": 1, "5m": 5, "15m": 15, "30m": 30, "60m": 60 };
  const step = stepMin[tf] ?? 5;
  const count = 200;
  const rng = seeded(entry.ticker, "intraday", tf);
  const daily = dailySeries(entry);
  const last = daily[daily.length - 1].close;
  const now = Math.floor(ANCHOR_MS / 1e3);
  const stepSec = step * 60;
  const times = [];
  for (let i = count - 1; i >= 0; i--) times.push(now - i * stepSec);
  const vol = 4e-3 + step / 60 * 4e-3;
  const start = last * (1 - rangeFloat(rng, -0.01, 0.01));
  return walk(rng, start, times, vol, 0);
}
function getCandles(ticker, tf) {
  const entry = getCatalogEntry(ticker);
  if (!entry) return [];
  if (tf === "1D") return dailySeries(entry).slice(-260);
  if (tf === "1W") return aggregate(dailySeries(entry), isoWeekKey).slice(-120);
  if (tf === "1M") return aggregate(dailySeries(entry), (d) => d.slice(0, 7)).slice(-60);
  return intradaySeries(entry, tf);
}
function getQuote(ticker) {
  const entry = getCatalogEntry(ticker);
  if (!entry) return null;
  const daily = dailySeries(entry);
  const last = daily[daily.length - 1];
  const prev = daily[daily.length - 2];
  const price = last.close;
  const changeAmount = r2(last.close - prev.close);
  const changePercent = r2(changeAmount / prev.close * 100);
  const window = daily.slice(-252);
  return {
    price,
    changeAmount,
    changePercent,
    volume: last.volume,
    marketCap: Math.round(price * shares(entry)),
    week52High: r2(Math.max(...window.map((c) => c.high))),
    week52Low: r2(Math.min(...window.map((c) => c.low)))
  };
}

// src/sample/company.ts
var SECTORS = {
  \uBC18\uB3C4\uCCB4: { industry: "\uBC18\uB3C4\uCCB4 \uBC0F \uC7A5\uBE44", business: "\uBC18\uB3C4\uCCB4 \uC124\uACC4\xB7\uC81C\uC870 \uBC0F \uAD00\uB828 \uC7A5\uBE44 \uACF5\uAE09" },
  "IT\xB7\uC18C\uD504\uD2B8\uC6E8\uC5B4": { industry: "\uC18C\uD504\uD2B8\uC6E8\uC5B4\xB7\uD074\uB77C\uC6B0\uB4DC", business: "\uC18C\uD504\uD2B8\uC6E8\uC5B4 \uBC0F \uD074\uB77C\uC6B0\uB4DC \uC11C\uBE44\uC2A4 \uAC1C\uBC1C" },
  "\uC778\uD130\uB137\xB7\uD50C\uB7AB\uD3FC": { industry: "\uC778\uD130\uB137 \uC11C\uBE44\uC2A4", business: "\uC628\uB77C\uC778 \uD50C\uB7AB\uD3FC \uBC0F \uB514\uC9C0\uD138 \uAD11\uACE0 \uC0AC\uC5C5" },
  "\uC804\uAE30\uCC28\xB7\uC790\uB3D9\uCC28": { industry: "\uC790\uB3D9\uCC28\xB7\uBD80\uD488", business: "\uC644\uC131\uCC28 \uBC0F \uC790\uB3D9\uCC28 \uBD80\uD488 \uC81C\uC870" },
  "2\uCC28\uC804\uC9C0": { industry: "2\uCC28\uC804\uC9C0\xB7\uC18C\uC7AC", business: "\uC804\uAE30\uCC28\uC6A9 \uBC30\uD130\uB9AC \uBC0F \uC18C\uC7AC \uC0DD\uC0B0" },
  "\uBC14\uC774\uC624\xB7\uC81C\uC57D": { industry: "\uC81C\uC57D\xB7\uBC14\uC774\uC624", business: "\uC758\uC57D\uD488 \uC5F0\uAD6C\uAC1C\uBC1C \uBC0F \uC704\uD0C1\uC0DD\uC0B0" },
  \uAE08\uC735: { industry: "\uC740\uD589\xB7\uBCF4\uD5D8", business: "\uC740\uD589, \uBCF4\uD5D8 \uBC0F \uC790\uC0B0\uC6B4\uC6A9 \uC11C\uBE44\uC2A4" },
  \uC5D0\uB108\uC9C0: { industry: "\uC5D0\uB108\uC9C0\xB7\uD654\uD559", business: "\uC11D\uC720\uD654\uD559 \uBC0F \uC5D0\uB108\uC9C0 \uC0AC\uC5C5" },
  \uC18C\uBE44\uC7AC: { industry: "\uC18C\uBE44\uC7AC\xB7\uC720\uD1B5", business: "\uC18C\uBE44\uC7AC \uC81C\uC870 \uBC0F \uC720\uD1B5" },
  \uD1B5\uC2E0: { industry: "\uD1B5\uC2E0 \uC11C\uBE44\uC2A4", business: "\uC774\uB3D9\uD1B5\uC2E0 \uBC0F \uB124\uD2B8\uC6CC\uD06C \uC11C\uBE44\uC2A4" },
  \uC0B0\uC5C5\uC7AC: { industry: "\uC0B0\uC5C5\uC7AC\xB7\uAC74\uC124", business: "\uAC74\uC124 \uBC0F \uC0B0\uC5C5 \uC124\uBE44 \uC0AC\uC5C5" },
  \uC5D4\uD130\uD14C\uC778\uBA3C\uD2B8: { industry: "\uBBF8\uB514\uC5B4\xB7\uC5D4\uD130", business: "\uCF58\uD150\uCE20 \uC81C\uC791 \uBC0F \uC5D4\uD130\uD14C\uC778\uBA3C\uD2B8 \uC0AC\uC5C5" },
  \uC591\uC790\uCEF4\uD4E8\uD305: { industry: "\uC591\uC790\uCEF4\uD4E8\uD305", business: "\uC591\uC790\uCEF4\uD4E8\uD305 \uD558\uB4DC\uC6E8\uC5B4 \uBC0F \uD074\uB77C\uC6B0\uB4DC \uAC1C\uBC1C" },
  \uAE30\uD0C0: { industry: "\uBCF5\uD569 \uC0B0\uC5C5", business: "\uB2E4\uAC01\uD654\uB41C \uC0AC\uC5C5" }
};
var RULES = [
  { kw: ["quantum", "rigetti", "ionq"], sector: "\uC591\uC790\uCEF4\uD4E8\uD305" },
  {
    kw: ["semiconductor", "nvidia", "amd", "advanced micro", "intel", "qualcomm", "broadcom", "micron", "asml", "marvell", "microchip", "analog devices", "texas instruments", "arm", "tsmc", "hynix", "\uD558\uC774\uB2C9\uC2A4", "\uBC18\uB3C4\uCCB4", "\uC804\uAE30", "sk\uD558\uC774\uB2C9\uC2A4", "\uC774\uB178\uD14D"],
    sector: "\uBC18\uB3C4\uCCB4"
  },
  { kw: ["battery", "\uC5D0\uB108\uC9C0\uC194\uB8E8\uC158", "sdi", "\uC5D4\uC194", "2\uCC28\uC804\uC9C0", "\uD4E8\uCC98\uC5E0", "\uC5D8\uC564\uC5D0\uD504"], sector: "2\uCC28\uC804\uC9C0" },
  {
    kw: ["bio", "pharma", "therapeutics", "biologics", "genomics", "\uBC14\uC774\uC624", "\uC81C\uC57D", "\uC140\uD2B8\uB9AC\uC628", "\uBC14\uC774\uC624\uB85C\uC9C1\uC2A4", "\uBA54\uB514"],
    sector: "\uBC14\uC774\uC624\xB7\uC81C\uC57D"
  },
  {
    kw: ["motor", "automotive", "tesla", "rivian", "lucid", "\uD604\uB300\uCC28", "\uAE30\uC544", "\uBAA8\uBE44\uC2A4", "\uC790\uB3D9\uCC28"],
    sector: "\uC804\uAE30\uCC28\xB7\uC790\uB3D9\uCC28"
  },
  {
    kw: ["bank", "financial", "insurance", "\uAE08\uC735", "\uC9C0\uC8FC", "\uC740\uD589", "\uC0DD\uBA85", "\uD654\uC7AC", "\uC99D\uAD8C", "\uCE74\uB4DC"],
    sector: "\uAE08\uC735"
  },
  {
    kw: ["software", "cloud", "oracle", "salesforce", "adobe", "servicenow", "snowflake", "palantir", "sap", "crowdstrike", "datadog", "\uC5D0\uC2A4\uB514\uC5D0\uC2A4", "\uC18C\uD504\uD2B8"],
    sector: "IT\xB7\uC18C\uD504\uD2B8\uC6E8\uC5B4"
  },
  {
    kw: ["internet", "meta", "alphabet", "google", "amazon", "netflix", "naver", "kakao", "\uB124\uC774\uBC84", "\uCE74\uCE74\uC624", "\uCFE0\uD321"],
    sector: "\uC778\uD130\uB137\xB7\uD50C\uB7AB\uD3FC"
  },
  {
    kw: ["game", "entertainment", "ent", "\uC5D4\uC528", "\uB137\uB9C8\uBE14", "\uD384\uC5B4\uBE44\uC2A4", "\uD558\uC774\uBE0C", "\uC5D0\uC2A4\uC5E0", "\uC640\uC774\uC9C0", "jyp", "\uAC8C\uC784\uC988", "\uC5D4\uD130"],
    sector: "\uC5D4\uD130\uD14C\uC778\uBA3C\uD2B8"
  },
  {
    kw: ["energy", "oil", "chemical", "posco", "holdings", "\uD654\uD559", "\uC774\uB178\uBCA0\uC774\uC158", "s-oil", "\uC804\uB825", "\uC815\uC720", "\uCF00\uBBF8\uCE7C"],
    sector: "\uC5D0\uB108\uC9C0"
  },
  { kw: ["telecom", "\uD154\uB808\uCF64", "kt", "\uC720\uD50C\uB7EC\uC2A4", "lg\uC720\uD50C\uB7EC\uC2A4"], sector: "\uD1B5\uC2E0" },
  {
    kw: ["construction", "\uAC74\uC124", "\uBB3C\uC0B0", "gs", "\uC911\uACF5\uC5C5", "\uC5D4\uC9C0\uB2C8\uC5B4\uB9C1"],
    sector: "\uC0B0\uC5C5\uC7AC"
  },
  {
    kw: ["retail", "food", "beverage", "\uC81C\uC77C\uC81C\uB2F9", "\uB18D\uC2EC", "\uC624\uB9AC\uC628", "\uC774\uB9C8\uD2B8", "\uB9AC\uD14C\uC77C", "\uBC31\uD654\uC810", "\uC0DD\uD65C\uAC74\uAC15", "\uD37C\uC2DC\uD53D", "\uD558\uC774\uD2B8", "\uC9C4\uB85C", "\uC81C\uACFC"],
    sector: "\uC18C\uBE44\uC7AC"
  }
];
function classify(entry) {
  const hay = `${entry.name} ${entry.ticker}`.toLowerCase();
  for (const rule of RULES) {
    if (rule.kw.some((k) => hay.includes(k.toLowerCase()))) return rule.sector;
  }
  return "\uAE30\uD0C0";
}
var peerIndex = null;
function peersFor(entry, sector) {
  if (!peerIndex) {
    peerIndex = /* @__PURE__ */ new Map();
    for (const e of CATALOG) {
      const s = classify(e);
      const list2 = peerIndex.get(s) ?? [];
      list2.push(e.name);
      peerIndex.set(s, list2);
    }
  }
  const list = (peerIndex.get(sector) ?? []).filter((n) => n !== entry.name);
  const r = seeded(entry.ticker, "peers");
  const out = [];
  const pool = [...list];
  while (out.length < 3 && pool.length > 0) {
    const idx = Math.floor(r() * pool.length);
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}
var CURATED = {
  "005930": { sector: "\uBC18\uB3C4\uCCB4", industry: "\uBC18\uB3C4\uCCB4\xB7\uC804\uC790", mainBusiness: "\uBA54\uBAA8\uB9AC \uBC18\uB3C4\uCCB4, \uC2A4\uB9C8\uD2B8\uD3F0, \uB514\uC2A4\uD50C\uB808\uC774, \uAC00\uC804 \uC0AC\uC5C5", competitors: ["SK\uD558\uC774\uB2C9\uC2A4", "TSMC", "Apple"], description: "\uC0BC\uC131\uC804\uC790\uB294 \uBA54\uBAA8\uB9AC \uBC18\uB3C4\uCCB4\uC640 \uC2A4\uB9C8\uD2B8\uD3F0(\uAC24\uB7ED\uC2DC), \uB514\uC2A4\uD50C\uB808\uC774, \uAC00\uC804\uC744 \uC544\uC6B0\uB974\uB294 \uAE00\uB85C\uBC8C \uC885\uD569 \uC804\uC790\xB7IT \uAE30\uC5C5\uC785\uB2C8\uB2E4." },
  "000660": { sector: "\uBC18\uB3C4\uCCB4", industry: "\uBA54\uBAA8\uB9AC \uBC18\uB3C4\uCCB4", mainBusiness: "DRAM\xB7NAND \uB4F1 \uBA54\uBAA8\uB9AC \uBC18\uB3C4\uCCB4 \uC81C\uC870", competitors: ["\uC0BC\uC131\uC804\uC790", "Micron", "TSMC"], description: "SK\uD558\uC774\uB2C9\uC2A4\uB294 DRAM\uACFC NAND \uD50C\uB798\uC2DC\uB97C \uC911\uC2EC\uC73C\uB85C \uD55C \uC138\uACC4\uC801\uC778 \uBA54\uBAA8\uB9AC \uBC18\uB3C4\uCCB4 \uC804\uBB38 \uAE30\uC5C5\uC785\uB2C8\uB2E4." },
  "005380": { sector: "\uC804\uAE30\uCC28\xB7\uC790\uB3D9\uCC28", industry: "\uC644\uC131\uCC28", mainBusiness: "\uB0B4\uC5F0\uAE30\uAD00\xB7\uC804\uAE30\uCC28 \uC644\uC131\uCC28 \uC81C\uC870 \uBC0F \uD310\uB9E4", competitors: ["\uAE30\uC544", "Tesla", "Toyota"], description: "\uD604\uB300\uCC28\uB294 \uC2B9\uC6A9\xB7\uC0C1\uC6A9\uCC28\uC640 \uC804\uAE30\uCC28\uB97C \uC0DD\uC0B0\uD558\uB294 \uB300\uD55C\uBBFC\uAD6D \uB300\uD45C \uC644\uC131\uCC28 \uAE30\uC5C5\uC785\uB2C8\uB2E4." },
  "035420": { sector: "\uC778\uD130\uB137\xB7\uD50C\uB7AB\uD3FC", industry: "\uC778\uD130\uB137 \uC11C\uBE44\uC2A4", mainBusiness: "\uAC80\uC0C9 \uD3EC\uD138, \uCEE4\uBA38\uC2A4, \uD540\uD14C\uD06C, \uD074\uB77C\uC6B0\uB4DC", competitors: ["\uCE74\uCE74\uC624", "Google", "\uCFE0\uD321"], description: "NAVER\uB294 \uAC80\uC0C9 \uD3EC\uD138\uC744 \uAE30\uBC18\uC73C\uB85C \uCEE4\uBA38\uC2A4\xB7\uD540\uD14C\uD06C\xB7\uD074\uB77C\uC6B0\uB4DC\xB7\uCF58\uD150\uCE20\uB85C \uD655\uC7A5\uD55C \uB300\uD45C \uC778\uD130\uB137 \uAE30\uC5C5\uC785\uB2C8\uB2E4." },
  "035720": { sector: "\uC778\uD130\uB137\xB7\uD50C\uB7AB\uD3FC", industry: "\uBAA8\uBC14\uC77C \uD50C\uB7AB\uD3FC", mainBusiness: "\uBA54\uC2E0\uC800, \uD540\uD14C\uD06C, \uBAA8\uBE4C\uB9AC\uD2F0, \uCF58\uD150\uCE20", competitors: ["NAVER", "Google", "\uCFE0\uD321"], description: "\uCE74\uCE74\uC624\uB294 \uAD6D\uBBFC \uBA54\uC2E0\uC800 \uCE74\uCE74\uC624\uD1A1\uC744 \uAE30\uBC18\uC73C\uB85C \uD540\uD14C\uD06C\xB7\uBAA8\uBE4C\uB9AC\uD2F0\xB7\uCF58\uD150\uCE20 \uC0AC\uC5C5\uC744 \uC6B4\uC601\uD569\uB2C8\uB2E4." },
  AAPL: { sector: "IT\xB7\uC18C\uD504\uD2B8\uC6E8\uC5B4", industry: "\uC18C\uBE44\uC790 \uC804\uC790\uAE30\uAE30", mainBusiness: "iPhone, Mac, \uC11C\uBE44\uC2A4 \uC0DD\uD0DC\uACC4", competitors: ["\uC0BC\uC131\uC804\uC790", "Microsoft", "Google"], description: "Apple\uC740 iPhone, Mac, iPad\uC640 \uC11C\uBE44\uC2A4 \uC0DD\uD0DC\uACC4\uB97C \uBCF4\uC720\uD55C \uC138\uACC4 \uCD5C\uB300 \uC18C\uBE44\uC790 \uC804\uC790\xB7IT \uAE30\uC5C5\uC785\uB2C8\uB2E4." },
  MSFT: { sector: "IT\xB7\uC18C\uD504\uD2B8\uC6E8\uC5B4", industry: "\uC18C\uD504\uD2B8\uC6E8\uC5B4\xB7\uD074\uB77C\uC6B0\uB4DC", mainBusiness: "Windows, Office, Azure \uD074\uB77C\uC6B0\uB4DC", competitors: ["Apple", "Google", "Amazon"], description: "Microsoft\uB294 Windows\xB7Office\uC640 Azure \uD074\uB77C\uC6B0\uB4DC\uB97C \uC911\uC2EC\uC73C\uB85C \uD55C \uAE00\uB85C\uBC8C \uC18C\uD504\uD2B8\uC6E8\uC5B4 \uAE30\uC5C5\uC785\uB2C8\uB2E4." },
  NVDA: { sector: "\uBC18\uB3C4\uCCB4", industry: "GPU\xB7AI \uBC18\uB3C4\uCCB4", mainBusiness: "AI\xB7\uADF8\uB798\uD53D GPU \uC124\uACC4", competitors: ["AMD", "Intel", "Qualcomm"], description: "NVIDIA\uB294 AI \uBC0F \uADF8\uB798\uD53D \uCC98\uB9AC\uB97C \uC704\uD55C GPU\uB97C \uC124\uACC4\uD558\uB294 \uC138\uACC4\uC801\uC778 \uBC18\uB3C4\uCCB4 \uAE30\uC5C5\uC785\uB2C8\uB2E4." },
  TSLA: { sector: "\uC804\uAE30\uCC28\xB7\uC790\uB3D9\uCC28", industry: "\uC804\uAE30\uCC28", mainBusiness: "\uC804\uAE30\uCC28 \uBC0F \uC5D0\uB108\uC9C0 \uC800\uC7A5\uC7A5\uCE58 \uC81C\uC870", competitors: ["\uD604\uB300\uCC28", "BYD", "Rivian"], description: "Tesla\uB294 \uC804\uAE30\uCC28\uC640 \uC5D0\uB108\uC9C0 \uC800\uC7A5\uC7A5\uCE58, \uC790\uC728\uC8FC\uD589 \uAE30\uC220\uC744 \uAC1C\uBC1C\uD558\uB294 \uC120\uB3C4 \uC804\uAE30\uCC28 \uAE30\uC5C5\uC785\uB2C8\uB2E4." },
  RGTI: { sector: "\uC591\uC790\uCEF4\uD4E8\uD305", industry: "\uC591\uC790\uCEF4\uD4E8\uD305", mainBusiness: "\uCD08\uC804\uB3C4 \uC591\uC790\uCEF4\uD4E8\uD130 \uBC0F \uD074\uB77C\uC6B0\uB4DC", competitors: ["IonQ", "D-Wave", "IBM"], description: "Rigetti Computing\uC740 \uCD08\uC804\uB3C4 \uBC29\uC2DD\uC758 \uC591\uC790\uCEF4\uD4E8\uD130\uC640 \uD074\uB77C\uC6B0\uB4DC \uC811\uADFC\uC744 \uC81C\uACF5\uD558\uB294 \uC591\uC790\uCEF4\uD4E8\uD305 \uAE30\uC5C5\uC785\uB2C8\uB2E4." },
  AMD: { sector: "\uBC18\uB3C4\uCCB4", industry: "CPU\xB7GPU", mainBusiness: "CPU\xB7GPU \uBC18\uB3C4\uCCB4 \uC124\uACC4", competitors: ["Intel", "NVIDIA", "Qualcomm"], description: "AMD\uB294 CPU\uC640 GPU\uB97C \uC124\uACC4\uD558\uB294 \uAE00\uB85C\uBC8C \uD339\uB9AC\uC2A4 \uBC18\uB3C4\uCCB4 \uAE30\uC5C5\uC785\uB2C8\uB2E4." }
};
function getCompanyProfile(ticker) {
  const entry = getCatalogEntry(ticker);
  if (!entry) return null;
  const sector = CURATED[entry.ticker]?.sector ?? classify(entry);
  const info = SECTORS[sector] ?? SECTORS["\uAE30\uD0C0"];
  const country = entry.market === "KR" ? "\uB300\uD55C\uBBFC\uAD6D" : "\uBBF8\uAD6D";
  const curated = CURATED[entry.ticker] ?? {};
  const competitors = curated.competitors ?? peersFor(entry, sector);
  const industry = curated.industry ?? info.industry;
  const mainBusiness = curated.mainBusiness ?? info.business;
  const description = curated.description ?? `${entry.name}\uC740(\uB294) ${country}\uC758 ${sector} \uAE30\uC5C5\uC73C\uB85C, ${mainBusiness}\uC744 \uC601\uC704\uD558\uACE0 \uC788\uC2B5\uB2C8\uB2E4.`;
  return {
    ticker: entry.ticker,
    name: entry.name,
    market: entry.market,
    currency: entry.currency,
    description,
    industry,
    sector,
    country,
    mainBusiness,
    competitors
  };
}

// src/sample/indicators.ts
function sma(values, period) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    out.push(i >= period - 1 ? sum / period : null);
  }
  return out;
}
function rsiSeries(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const g = d >= 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}
function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    if (prev === null) {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += values[j];
      prev = sum / period;
    } else {
      prev = values[i] * k + prev * (1 - k);
    }
    out[i] = prev;
  }
  return out;
}
function macdSeries(values) {
  const fast = ema(values, 12);
  const slow = ema(values, 26);
  const macd = values.map(
    (_, i) => fast[i] !== null && slow[i] !== null ? fast[i] - slow[i] : null
  );
  const macdVals = macd.map((v) => v === null ? 0 : v);
  const firstIdx = macd.findIndex((v) => v !== null);
  const signalRaw = ema(macdVals, 9);
  const signal = signalRaw.map((v, i) => i >= firstIdx + 8 && v !== null ? v : null);
  const hist = macd.map(
    (v, i) => v !== null && signal[i] !== null ? v - signal[i] : null
  );
  return { macd, signal, hist };
}
function computeIndicators(candles5) {
  const closes = candles5.map((c) => c.close);
  return {
    ma20: sma(closes, 20),
    ma60: sma(closes, 60),
    ma120: sma(closes, 120),
    ma240: sma(closes, 240),
    rsi: rsiSeries(closes, 14),
    macd: macdSeries(closes)
  };
}
function lastTwo(arr) {
  const n = arr.length;
  const a = arr[n - 2];
  const b = arr[n - 1];
  if (a === null || b === null || a === void 0 || b === void 0) return null;
  return [a, b];
}
function detectSignals(candles5, ind) {
  const signals = [];
  const n = candles5.length;
  const s20 = lastTwo(ind.ma20);
  const s60 = lastTwo(ind.ma60);
  let golden = false;
  let dead = false;
  if (s20 && s60) {
    golden = s20[0] <= s60[0] && s20[1] > s60[1];
    dead = s20[0] >= s60[0] && s20[1] < s60[1];
  }
  signals.push({
    key: "golden_cross",
    label: "\uACE8\uB4E0\uD06C\uB85C\uC2A4",
    active: golden,
    tone: golden ? "positive" : "neutral",
    detail: golden ? "20\uC77C\uC120\uC774 60\uC77C\uC120\uC744 \uC0C1\uD5A5 \uB3CC\uD30C\uD588\uC2B5\uB2C8\uB2E4." : "\uCD5C\uADFC \uACE8\uB4E0\uD06C\uB85C\uC2A4\uB294 \uBC1C\uC0DD\uD558\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4."
  });
  signals.push({
    key: "dead_cross",
    label: "\uB370\uB4DC\uD06C\uB85C\uC2A4",
    active: dead,
    tone: dead ? "negative" : "neutral",
    detail: dead ? "20\uC77C\uC120\uC774 60\uC77C\uC120\uC744 \uD558\uD5A5 \uB3CC\uD30C\uD588\uC2B5\uB2C8\uB2E4." : "\uCD5C\uADFC \uB370\uB4DC\uD06C\uB85C\uC2A4\uB294 \uBC1C\uC0DD\uD558\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4."
  });
  let volSurge = false;
  let ratio = 0;
  if (n >= 21) {
    const avg = candles5.slice(n - 21, n - 1).reduce((s, c) => s + c.volume, 0) / 20;
    ratio = avg > 0 ? candles5[n - 1].volume / avg : 0;
    volSurge = ratio >= 1.8;
  }
  signals.push({
    key: "volume_surge",
    label: "\uAC70\uB798\uB7C9 \uAE09\uC99D",
    active: volSurge,
    tone: volSurge ? "positive" : "neutral",
    detail: volSurge ? `\uCD5C\uADFC \uAC70\uB798\uB7C9\uC774 20\uBD09 \uD3C9\uADE0\uC758 ${ratio.toFixed(1)}\uBC30\uC785\uB2C8\uB2E4.` : "\uAC70\uB798\uB7C9\uC740 \uD3C9\uADE0 \uC218\uC900\uC785\uB2C8\uB2E4."
  });
  const rsi = ind.rsi[n - 1];
  const overbought = rsi !== null && rsi !== void 0 && rsi >= 70;
  const oversold = rsi !== null && rsi !== void 0 && rsi <= 30;
  signals.push({
    key: "rsi_overbought",
    label: "RSI \uACFC\uB9E4\uC218",
    active: overbought,
    tone: "neutral",
    detail: rsi == null ? "RSI \uB370\uC774\uD130\uAC00 \uBD80\uC871\uD569\uB2C8\uB2E4." : `RSI ${rsi.toFixed(0)} \u2014 ${overbought ? "\uACFC\uB9E4\uC218 \uAD6C\uAC04" : "\uACFC\uB9E4\uC218 \uC544\uB2D8"}.`
  });
  signals.push({
    key: "rsi_oversold",
    label: "RSI \uACFC\uB9E4\uB3C4",
    active: oversold,
    tone: "neutral",
    detail: rsi == null ? "RSI \uB370\uC774\uD130\uAC00 \uBD80\uC871\uD569\uB2C8\uB2E4." : `RSI ${rsi.toFixed(0)} \u2014 ${oversold ? "\uACFC\uB9E4\uB3C4 \uAD6C\uAC04" : "\uACFC\uB9E4\uB3C4 \uC544\uB2D8"}.`
  });
  const m = lastTwo(ind.macd.macd);
  const sig = lastTwo(ind.macd.signal);
  let macdBuy = false;
  let macdSell = false;
  if (m && sig) {
    macdBuy = m[0] <= sig[0] && m[1] > sig[1];
    macdSell = m[0] >= sig[0] && m[1] < sig[1];
  }
  signals.push({
    key: "macd_buy",
    label: "MACD \uB9E4\uC218 \uC2E0\uD638",
    active: macdBuy,
    tone: macdBuy ? "positive" : "neutral",
    detail: macdBuy ? "MACD\uAC00 \uC2DC\uADF8\uB110\uC120\uC744 \uC0C1\uD5A5 \uB3CC\uD30C\uD588\uC2B5\uB2C8\uB2E4." : "MACD \uB9E4\uC218 \uC2E0\uD638\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4."
  });
  signals.push({
    key: "macd_sell",
    label: "MACD \uB9E4\uB3C4 \uC2E0\uD638",
    active: macdSell,
    tone: macdSell ? "negative" : "neutral",
    detail: macdSell ? "MACD\uAC00 \uC2DC\uADF8\uB110\uC120\uC744 \uD558\uD5A5 \uB3CC\uD30C\uD588\uC2B5\uB2C8\uB2E4." : "MACD \uB9E4\uB3C4 \uC2E0\uD638\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4."
  });
  return signals;
}
function technicalScore(candles5, ind, signals) {
  let score = 50;
  const map = new Map(signals.map((s) => [s.key, s]));
  if (map.get("golden_cross")?.active) score += 12;
  if (map.get("dead_cross")?.active) score -= 12;
  if (map.get("volume_surge")?.active) score += 5;
  if (map.get("macd_buy")?.active) score += 10;
  if (map.get("macd_sell")?.active) score -= 10;
  const n = candles5.length;
  const price = candles5[n - 1]?.close ?? 0;
  const ma60 = ind.ma60[n - 1];
  if (ma60) score += price > ma60 ? 8 : -8;
  const rsi = ind.rsi[n - 1];
  if (rsi != null) {
    if (rsi >= 70) score -= 6;
    else if (rsi <= 30) score += 6;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

// src/sample/financials.ts
function r0(n) {
  return Math.round(n);
}
function getFinancials(ticker) {
  const entry = getCatalogEntry(ticker);
  if (!entry) return null;
  const quote5 = getQuote(ticker);
  if (!quote5) return null;
  const q = qualityScore(entry.ticker);
  const rng = seeded(entry.ticker, "fin");
  const marketCap = quote5.marketCap;
  const ps = rangeFloat(rng, 1.5, 8);
  const latestRevenue = marketCap / ps;
  const opMargin = q / 100 * 0.28 - 0.05 + rangeFloat(rng, -0.04, 0.06);
  const netMargin = opMargin - rangeFloat(rng, 5e-3, 0.05);
  const yoyGrowth = (q - 45) / 100 * 0.4 + rangeFloat(rng, -0.06, 0.08);
  const thisYear = new Date(ANCHOR_MS).getUTCFullYear();
  const annual = [];
  for (let i = 4; i >= 0; i--) {
    const rev = latestRevenue / Math.pow(1 + yoyGrowth, i);
    const cash = rev * rangeFloat(rng, 0.15, 0.6);
    const debt = rev * rangeFloat(rng, 0.1, 0.9);
    annual.push({
      period: `${thisYear - i}`,
      revenue: r0(rev),
      operatingIncome: r0(rev * opMargin),
      netIncome: r0(rev * netMargin),
      cash: r0(cash),
      debt: r0(debt)
    });
  }
  const latest = annual[annual.length - 1];
  const quarterly = [];
  const qLabels = ["1Q", "2Q", "3Q", "4Q"];
  for (let i = 0; i < 4; i++) {
    const season = 1 + (rng() - 0.5) * 0.2;
    const rev = latest.revenue / 4 * season;
    quarterly.push({
      period: `${thisYear} ${qLabels[i]}`,
      revenue: r0(rev),
      operatingIncome: r0(rev * opMargin * season),
      netIncome: r0(rev * netMargin * season),
      cash: r0(latest.cash * (0.85 + i * 0.05)),
      debt: r0(latest.debt * (1.05 - i * 0.02))
    });
  }
  const equity = latestRevenue * rangeFloat(rng, 0.5, 1.4);
  const netIncome = latest.netIncome;
  const eps = netIncome / shares(entry);
  const per = eps > 0 ? Math.round(quote5.price / eps * 10) / 10 : 0;
  const pbr = Math.round(marketCap / equity * 100) / 100;
  const roe = Math.round(netIncome / equity * 1e3) / 10;
  const debtRatio = Math.round(latest.debt / equity * 1e3) / 10;
  const revenueGrowth = [];
  const profitGrowth = [];
  for (let i = 1; i < annual.length; i++) {
    revenueGrowth.push(
      Math.round((annual[i].revenue - annual[i - 1].revenue) / Math.abs(annual[i - 1].revenue) * 1e3) / 10
    );
    const prev = annual[i - 1].netIncome;
    profitGrowth.push(
      prev !== 0 ? Math.round((annual[i].netIncome - prev) / Math.abs(prev) * 1e3) / 10 : 0
    );
  }
  const quarterlyNet = quarterly[quarterly.length - 1].netIncome;
  const quarterlyBurn = r0(quarterlyNet);
  const cashBalance = quarterly[quarterly.length - 1].cash;
  const survivalQuarters = quarterlyBurn < 0 ? Math.max(1, Math.round(cashBalance / Math.abs(quarterlyBurn))) : null;
  let healthScore = 50;
  if (netMargin > 0) healthScore += 15;
  else healthScore -= 20;
  if (yoyGrowth > 0.08) healthScore += 12;
  else if (yoyGrowth < 0) healthScore -= 10;
  if (debtRatio < 80) healthScore += 8;
  else healthScore -= 8;
  if (survivalQuarters !== null) healthScore -= 10;
  healthScore = Math.max(0, Math.min(100, healthScore));
  const level = healthScore >= 66 ? "STRONG" : healthScore >= 40 ? "AVERAGE" : "WEAK";
  const confidence = Math.round(60 + Math.abs(healthScore - 50) / 50 * 35);
  return {
    quarterly,
    annual,
    ratios: { eps: Math.round(eps * 100) / 100, per, pbr, roe, debtRatio },
    growth: { revenue: revenueGrowth, profit: profitGrowth },
    cashBurn: { cashBalance, quarterlyBurn, survivalQuarters },
    health: { level, confidence }
  };
}
function fundamentalScore(ticker) {
  const fin = getFinancials(ticker);
  if (!fin) return 50;
  let s = 50;
  if (fin.ratios.roe > 12) s += 10;
  else if (fin.ratios.roe < 0) s -= 12;
  const avgRevGrowth = fin.growth.revenue.reduce((a, b) => a + b, 0) / (fin.growth.revenue.length || 1);
  if (avgRevGrowth > 10) s += 12;
  else if (avgRevGrowth < 0) s -= 10;
  if (fin.ratios.debtRatio > 120) s -= 10;
  if (fin.cashBurn.survivalQuarters !== null) s -= 12;
  if (fin.health.level === "STRONG") s += 10;
  else if (fin.health.level === "WEAK") s -= 10;
  return Math.max(0, Math.min(100, Math.round(s)));
}

// src/sample/scores.ts
function computeScores(ticker) {
  const candles5 = getCandles(ticker, "1D");
  const ind = computeIndicators(candles5);
  const signals = detectSignals(candles5, ind);
  const technical = technicalScore(candles5, ind, signals);
  const fundamental = fundamentalScore(ticker);
  const overall = Math.round(fundamental * 0.55 + technical * 0.45);
  return { fundamental, technical, overall, signals };
}

// src/sample/rating.ts
function scoreToRating(score) {
  const s = Math.max(0, Math.min(100, Math.round(score)));
  let rating;
  if (s >= 80) rating = "STRONG_BUY";
  else if (s >= 60) rating = "BUY";
  else if (s >= 40) rating = "HOLD";
  else if (s >= 20) rating = "SELL";
  else rating = "STRONG_SELL";
  const dist = Math.abs(s - 50) / 50;
  const confidence = Math.round(58 + dist * 38);
  return { rating, confidence, score: s };
}

// src/providers/yahoo.ts
function cleanTicker(value) {
  return String(value ?? "").trim().toUpperCase();
}
function safeNumber(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[,\s$%]/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}
function isKrTicker(ticker) {
  return /^\d{6}$/.test(ticker);
}
function getTickerFromEntry(entryOrTicker) {
  if (typeof entryOrTicker === "string") return cleanTicker(entryOrTicker);
  return cleanTicker(entryOrTicker.ticker);
}
function getNameFromEntry(entryOrTicker, fallback) {
  if (typeof entryOrTicker === "string") return fallback;
  return String(entryOrTicker.name ?? fallback);
}
function yahooSymbol(ticker) {
  const clean = cleanTicker(ticker);
  if (isKrTicker(clean)) return `${clean}.KS`;
  return clean;
}
async function fetchJson(url) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      accept: "application/json,text/plain,*/*",
      "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
    }
  });
  if (!res.ok) {
    throw new Error(`YAHOO_CHART_HTTP_${res.status}`);
  }
  return await res.json();
}
async function fetchYahooChart(symbol) {
  const encoded = encodeURIComponent(symbol);
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?range=5d&interval=1d`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encoded}?range=5d&interval=1d`,
    `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?range=1mo&interval=1d`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encoded}?range=1mo&interval=1d`
  ];
  const errors = [];
  for (const url of urls) {
    try {
      const data = await fetchJson(url);
      const result = data?.chart?.result?.[0];
      if (result?.indicators?.quote?.[0]) {
        return result;
      }
      errors.push(`EMPTY_RESULT:${url}`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(`YAHOO_PROVIDER_MARKER_20260711_FAILED:${symbol}:${errors.join("|")}`);
}
function lastValidIndex(values) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return index;
    }
  }
  return -1;
}
async function getQuote2(entryOrTicker) {
  const ticker = getTickerFromEntry(entryOrTicker);
  const symbol = yahooSymbol(ticker);
  const result = await fetchYahooChart(symbol);
  const quote5 = result.indicators?.quote?.[0];
  if (!quote5?.close?.length) {
    throw new Error(`YAHOO_PROVIDER_MARKER_20260711_NO_CLOSE:${symbol}`);
  }
  const index = lastValidIndex(quote5.close);
  if (index < 0) {
    throw new Error(`YAHOO_PROVIDER_MARKER_20260711_NO_VALID_PRICE:${symbol}`);
  }
  const price = safeNumber(result.meta?.regularMarketPrice) || safeNumber(quote5.close[index]);
  if (!price) {
    throw new Error(`YAHOO_PROVIDER_MARKER_20260711_ZERO_PRICE:${symbol}`);
  }
  let previousClose = safeNumber(result.meta?.previousClose) || safeNumber(result.meta?.chartPreviousClose);
  if (!previousClose) {
    for (let i = index - 1; i >= 0; i -= 1) {
      const candidate = safeNumber(quote5.close[i]);
      if (candidate > 0) {
        previousClose = candidate;
        break;
      }
    }
  }
  if (!previousClose) previousClose = price;
  const changeAmount = price - previousClose;
  const changePercent = previousClose ? changeAmount / previousClose * 100 : 0;
  const volume = safeNumber(quote5.volume?.[index]);
  const tradingValue = price * volume;
  return {
    ticker,
    symbol,
    name: getNameFromEntry(entryOrTicker, ticker),
    price,
    currentPrice: price,
    regularMarketPrice: price,
    close: price,
    previousClose,
    prevClose: previousClose,
    change: changeAmount,
    changeAmount,
    changePercent,
    regularMarketChangePercent: changePercent,
    volume,
    tradingValue,
    open: safeNumber(quote5.open?.[index]),
    high: safeNumber(quote5.high?.[index]),
    low: safeNumber(quote5.low?.[index]),
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
var quote = getQuote2;
async function getCandles2(entryOrTicker) {
  const ticker = getTickerFromEntry(entryOrTicker);
  const symbol = yahooSymbol(ticker);
  const result = await fetchYahooChart(symbol);
  const quote5 = result.indicators?.quote?.[0];
  if (!result.timestamp?.length || !quote5) return [];
  return result.timestamp.map((timestamp, index) => {
    const close = safeNumber(quote5.close?.[index]);
    return {
      time: new Date(timestamp * 1e3).toISOString(),
      open: safeNumber(quote5.open?.[index]),
      high: safeNumber(quote5.high?.[index]),
      low: safeNumber(quote5.low?.[index]),
      close,
      volume: safeNumber(quote5.volume?.[index])
    };
  }).filter((candle) => candle.close > 0);
}
var candles = getCandles2;
async function getCompanyProfile2(entryOrTicker) {
  const ticker = getTickerFromEntry(entryOrTicker);
  return {
    ticker,
    name: getNameFromEntry(entryOrTicker, ticker),
    market: isKrTicker(ticker) ? "KR" : "US",
    currency: isKrTicker(ticker) ? "KRW" : "USD",
    description: `${getNameFromEntry(entryOrTicker, ticker)} \uAE30\uC5C5 \uC815\uBCF4\uC785\uB2C8\uB2E4.`,
    sector: "",
    industry: "",
    website: ""
  };
}
var companyProfile = getCompanyProfile2;

// src/providers/naver.ts
function cleanTicker2(value) {
  return String(value ?? "").trim().toUpperCase();
}
function onlyDigits(value) {
  return value.replace(/\D/g, "");
}
function safeNumber2(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[,\s%원]/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}
function isKrTicker2(ticker) {
  return /^\d{6}$/.test(ticker);
}
function getTickerFromEntry2(entryOrTicker) {
  if (typeof entryOrTicker === "string") return cleanTicker2(entryOrTicker);
  return cleanTicker2(entryOrTicker.ticker);
}
function getNameFromEntry2(entryOrTicker, fallback) {
  if (typeof entryOrTicker === "string") return fallback;
  return String(entryOrTicker.name ?? fallback);
}
function dateToIso(localDate) {
  if (!/^\d{8}$/.test(localDate)) return (/* @__PURE__ */ new Date()).toISOString();
  const yyyy = localDate.slice(0, 4);
  const mm = localDate.slice(4, 6);
  const dd = localDate.slice(6, 8);
  return (/* @__PURE__ */ new Date(`${yyyy}-${mm}-${dd}T00:00:00+09:00`)).toISOString();
}
async function fetchJson2(url) {
  const res = await fetch(url, {
    headers: {
      accept: "application/json,text/plain,*/*",
      "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      referer: "https://finance.naver.com/"
    }
  });
  if (!res.ok) {
    throw new Error(`NAVER_HTTP_${res.status}`);
  }
  return await res.json();
}
async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      referer: "https://finance.naver.com/"
    }
  });
  if (!res.ok) {
    throw new Error(`NAVER_HTML_HTTP_${res.status}`);
  }
  return await res.text();
}
function stripHtml(value) {
  return value.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}
function parseNumberNear(label, html) {
  const index = html.indexOf(label);
  if (index < 0) return 0;
  const sliced = html.slice(index, index + 1500);
  const match = sliced.match(/[-+]?\d[\d,]*(?:\.\d+)?%?/);
  return safeNumber2(match?.[0]);
}
function parseByClass(className, html) {
  const regex = new RegExp(
    `<[^>]+class=["'][^"']*${className}[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`,
    "i"
  );
  const match = html.match(regex);
  if (!match?.[1]) return "";
  return stripHtml(match[1]);
}
function parseNameFromHtml(html, fallback) {
  const nameByWrap = html.match(/<div\s+class=["']wrap_company["'][\s\S]*?<h2[^>]*>([\s\S]*?)<\/h2>/i);
  if (nameByWrap?.[1]) {
    const parsed = stripHtml(nameByWrap[1]);
    if (parsed) return parsed;
  }
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title?.[1]) {
    const parsed = stripHtml(title[1]).replace(/: 네이버페이 증권.*/g, "").replace(/종목분석.*/g, "").trim();
    if (parsed) return parsed;
  }
  return fallback;
}
function parseNaverHtmlQuote(code, html, fallbackName) {
  const noToday = parseByClass("no_today", html);
  const price = safeNumber2(noToday) || parseNumberNear("\uD604\uC7AC\uAC00", html);
  const previousClose = parseNumberNear("\uC804\uC77C", html) || parseNumberNear("\uC804\uC77C\uAC00", html);
  const open = parseNumberNear("\uC2DC\uAC00", html);
  const high = parseNumberNear("\uACE0\uAC00", html);
  const low = parseNumberNear("\uC800\uAC00", html);
  const volume = parseNumberNear("\uAC70\uB798\uB7C9", html);
  const tradingValue = parseNumberNear("\uAC70\uB798\uB300\uAE08", html) * 1e6;
  let changeAmount = 0;
  let changePercent = 0;
  const rateMatch = html.match(/rate_info[\s\S]*?([-+]?\d+(?:\.\d+)?)\s*%/i) ?? html.match(/전일대비[\s\S]*?([-+]?\d+(?:\.\d+)?)\s*%/i);
  if (rateMatch?.[1]) {
    changePercent = safeNumber2(rateMatch[1]);
  }
  if (previousClose > 0 && price > 0) {
    changeAmount = price - previousClose;
    if (!changePercent) {
      changePercent = changeAmount / previousClose * 100;
    }
  }
  return {
    ticker: code,
    name: parseNameFromHtml(html, fallbackName),
    price,
    currentPrice: price,
    regularMarketPrice: price,
    close: price,
    previousClose: previousClose || price - changeAmount,
    prevClose: previousClose || price - changeAmount,
    change: changeAmount,
    changeAmount,
    changePercent,
    regularMarketChangePercent: changePercent,
    volume,
    tradingValue: tradingValue || price * volume,
    open,
    high,
    low,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
async function fetchNaverPoll(code) {
  const cleanCode = onlyDigits(code);
  if (!isKrTicker2(cleanCode)) return null;
  const urls = [
    `https://polling.finance.naver.com/api/realtime/domestic/stock/${cleanCode}`,
    `https://api.stock.naver.com/stock/${cleanCode}/basic`
  ];
  for (const url of urls) {
    try {
      const data = await fetchJson2(url);
      const item = data?.datas?.[0] ?? data?.areas?.[0]?.datas?.[0] ?? data?.result?.areas?.[0]?.datas?.[0] ?? data?.result?.datas?.[0] ?? data;
      if (!item) continue;
      return {
        cd: cleanCode,
        nm: item.nm ?? item.stockName ?? item.name,
        nv: item.nv ?? item.closePrice ?? item.nowPrice,
        cv: item.cv ?? item.compareToPreviousClosePrice ?? item.changePrice,
        cr: item.cr ?? item.fluctuationsRatio ?? item.changeRate,
        aq: item.aq ?? item.accumulatedTradingVolume,
        aa: item.aa ?? item.accumulatedTradingValue,
        hv: item.hv ?? item.highPrice,
        lv: item.lv ?? item.lowPrice,
        ov: item.ov ?? item.openPrice,
        pcv: item.pcv ?? item.previousClosePrice
      };
    } catch {
    }
  }
  return null;
}
async function getQuote3(entryOrTicker) {
  const ticker = getTickerFromEntry2(entryOrTicker);
  const code = onlyDigits(ticker);
  const fallbackName = getNameFromEntry2(entryOrTicker, code);
  if (!isKrTicker2(code)) {
    throw new Error(`NAVER_ONLY_SUPPORTS_KR_TICKER:${ticker}`);
  }
  const item = await fetchNaverPoll(code);
  if (item) {
    const price = safeNumber2(item.nv);
    if (price > 0) {
      const changeAmount = safeNumber2(item.cv);
      const changePercent = safeNumber2(item.cr);
      const previousClose = safeNumber2(item.pcv) || (changePercent === -100 ? price : price - changeAmount);
      const volume = safeNumber2(item.aq);
      const tradingValue = safeNumber2(item.aa) || price * volume;
      return {
        ticker: code,
        name: String(item.nm ?? fallbackName),
        price,
        currentPrice: price,
        regularMarketPrice: price,
        close: price,
        previousClose,
        prevClose: previousClose,
        change: changeAmount,
        changeAmount,
        changePercent,
        regularMarketChangePercent: changePercent,
        volume,
        tradingValue,
        open: safeNumber2(item.ov),
        high: safeNumber2(item.hv),
        low: safeNumber2(item.lv),
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
    }
  }
  const html = await fetchText(`https://finance.naver.com/item/main.naver?code=${code}`);
  const parsed = parseNaverHtmlQuote(code, html, fallbackName);
  if (!safeNumber2(parsed.price)) {
    throw new Error(`NAVER_PRICE_PARSE_FAILED:${code}`);
  }
  return parsed;
}
var quote2 = getQuote3;
async function getCandles3(entryOrTicker) {
  const ticker = getTickerFromEntry2(entryOrTicker);
  const code = onlyDigits(ticker);
  if (!isKrTicker2(code)) {
    throw new Error(`NAVER_ONLY_SUPPORTS_KR_TICKER:${ticker}`);
  }
  const now = /* @__PURE__ */ new Date();
  const endDate = now.toISOString().slice(0, 10).replace(/-/g, "");
  const start = new Date(now);
  start.setDate(start.getDate() - 180);
  const startDate = start.toISOString().slice(0, 10).replace(/-/g, "");
  const url = `https://api.stock.naver.com/chart/domestic/item/${code}/day?startDateTime=${startDate}&endDateTime=${endDate}`;
  const data = await fetchJson2(url);
  const rows = Array.isArray(data) ? data : data?.data ?? [];
  return rows.map((row) => {
    const time = dateToIso(String(row.localDate ?? ""));
    return {
      time,
      open: safeNumber2(row.openPrice),
      high: safeNumber2(row.highPrice),
      low: safeNumber2(row.lowPrice),
      close: safeNumber2(row.closePrice),
      volume: safeNumber2(row.accumulatedTradingVolume)
    };
  }).filter((candle) => candle.close > 0);
}
var candles2 = getCandles3;

// src/lib/errors.ts
var ProviderError = class extends Error {
  code;
  provider;
  constructor(code, provider, message) {
    super(message ?? `${provider}: ${code}`);
    this.name = "ProviderError";
    this.code = code;
    this.provider = provider;
  }
};

// src/lib/config.ts
function getFinnhubKey() {
  const key = process.env["FINNHUB_API_KEY"];
  if (!key) throw new ProviderError("NOT_CONFIGURED", "finnhub");
  return key;
}
var SEC_USER_AGENT = process.env["SEC_USER_AGENT"] ?? "stock-analyzer support@example.com";
function providerStatus() {
  return {
    finnhub: Boolean(process.env["FINNHUB_API_KEY"]),
    alphavantage: Boolean(process.env["ALPHA_VANTAGE_API_KEY"]),
    dart: Boolean(process.env["DART_API_KEY"]),
    secEdgar: true
    // free, no key required
  };
}

// src/lib/http.ts
async function fetchJson3(url, opts) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 1e4);
  try {
    const res = await fetch(url, {
      headers: opts.headers,
      signal: controller.signal
    });
    if (res.status === 429) {
      throw new ProviderError("RATE_LIMITED", opts.provider);
    }
    if (!res.ok) {
      throw new ProviderError(
        "UPSTREAM_ERROR",
        opts.provider,
        `HTTP ${res.status}`
      );
    }
    return await res.json();
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new ProviderError("UPSTREAM_ERROR", opts.provider, "timeout");
    }
    throw new ProviderError(
      "UPSTREAM_ERROR",
      opts.provider,
      err instanceof Error ? err.message : "network error"
    );
  } finally {
    clearTimeout(timeout);
  }
}
async function fetchText2(url, opts) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 1e4);
  try {
    const res = await fetch(url, {
      headers: opts.headers,
      signal: controller.signal
    });
    if (res.status === 429) {
      throw new ProviderError("RATE_LIMITED", opts.provider);
    }
    if (!res.ok) {
      throw new ProviderError(
        "UPSTREAM_ERROR",
        opts.provider,
        `HTTP ${res.status}`
      );
    }
    return await res.text();
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new ProviderError("UPSTREAM_ERROR", opts.provider, "timeout");
    }
    throw new ProviderError(
      "UPSTREAM_ERROR",
      opts.provider,
      err instanceof Error ? err.message : "network error"
    );
  } finally {
    clearTimeout(timeout);
  }
}

// src/lib/supabase.ts
import { createClient } from "@supabase/supabase-js";
var client = null;
function serverKey() {
  return process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
}
function hasSupabaseServerKey() {
  return Boolean(process.env.SUPABASE_URL) && Boolean(serverKey());
}
function getSupabase() {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = serverKey() ?? process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      "Supabase is not configured: set SUPABASE_URL and SUPABASE_ANON_KEY (or SUPABASE_SERVICE_ROLE_KEY)."
    );
  }
  client = createClient(url, key, {
    auth: {
      // Server context: no browser session persistence.
      persistSession: false,
      autoRefreshToken: false
    }
  });
  return client;
}

// src/lib/cache.ts
var store = /* @__PURE__ */ new Map();
var PERSIST_TABLE = "market_cache";
var PERSIST_MIN_TTL_MS = 5 * 60 * 1e3;
var persistWarned = false;
function warnPersistOnce(action, error) {
  if (persistWarned) return;
  persistWarned = true;
  const message = error instanceof Error ? error.message : String(error);
  console.warn(
    `[cache] Supabase persistent tier disabled for this issue (${action}): ${message}`
  );
}
function persistable(ttlMs) {
  return ttlMs >= PERSIST_MIN_TTL_MS && hasSupabaseServerKey();
}
async function readPersistent(key) {
  try {
    const { data, error } = await getSupabase().from(PERSIST_TABLE).select("payload,expires_at").eq("cache_key", key).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    const expires = Date.parse(data.expires_at);
    if (!Number.isFinite(expires) || expires <= Date.now()) return null;
    return { value: data.payload, expires };
  } catch (error) {
    warnPersistOnce("read", error);
    return null;
  }
}
function writePersistent(key, value, ttlMs, expires) {
  void getSupabase().from(PERSIST_TABLE).upsert(
    {
      cache_key: key,
      payload: value,
      ttl_ms: ttlMs,
      expires_at: new Date(expires).toISOString(),
      updated_at: (/* @__PURE__ */ new Date()).toISOString()
    },
    { onConflict: "cache_key" }
  ).then(({ error }) => {
    if (error) warnPersistOnce("write", new Error(error.message));
  });
}
async function cached(key, ttlMs, loader) {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expires > now) {
    return hit.value;
  }
  if (persistable(ttlMs)) {
    const persisted = await readPersistent(key);
    if (persisted) {
      store.set(key, persisted);
      return persisted.value;
    }
  }
  const value = await loader();
  const expires = now + ttlMs;
  store.set(key, { value, expires });
  if (persistable(ttlMs)) {
    writePersistent(key, value, ttlMs, expires);
  }
  return value;
}
var TTL = {
  quote: 60 * 1e3,
  // 1 min
  news: 15 * 60 * 1e3,
  // 15 min
  financials: 24 * 60 * 60 * 1e3,
  // 24 h (rate-limit friendly)
  signals: 12 * 60 * 60 * 1e3,
  // 12 h
  risk: 6 * 60 * 60 * 1e3,
  // 6 h
  profile: 24 * 60 * 60 * 1e3,
  // 24 h
  mapping: 24 * 60 * 60 * 1e3,
  // 24 h (CIK / corp_code maps)
  market: 6 * 60 * 60 * 1e3
  // 6 h (full market listings)
};

// src/providers/finnhub.ts
var BASE = "https://finnhub.io/api/v1";
function toFinnhubSymbol(entry) {
  if (entry.market === "US") return entry.ticker;
  const suffix = /^[6]/.test(entry.ticker) ? ".KQ" : ".KS";
  return `${entry.ticker}${suffix}`;
}
async function getQuote4(entry) {
  const key = getFinnhubKey();
  const symbol = toFinnhubSymbol(entry);
  return cached(`finnhub:quote:${symbol}`, TTL.quote, async () => {
    const data = await fetchJson3(
      `${BASE}/quote?symbol=${encodeURIComponent(symbol)}&token=${key}`,
      { provider: "finnhub" }
    );
    if (!data || !data.c) {
      throw new ProviderError(
        "UNAVAILABLE",
        "finnhub",
        `no quote for ${symbol}`
      );
    }
    return {
      price: data.c,
      changeAmount: data.d ?? 0,
      changePercent: data.dp ?? 0,
      high: data.h,
      low: data.l,
      open: data.o,
      previousClose: data.pc
    };
  });
}
function ymd(d) {
  return d.toISOString().slice(0, 10);
}
async function getCompanyNews(entry) {
  const key = getFinnhubKey();
  const symbol = toFinnhubSymbol(entry);
  return cached(`finnhub:news:${symbol}`, TTL.news, async () => {
    const to = /* @__PURE__ */ new Date();
    const from = new Date(to.getTime() - 14 * 24 * 60 * 60 * 1e3);
    const data = await fetchJson3(
      `${BASE}/company-news?symbol=${encodeURIComponent(symbol)}&from=${ymd(
        from
      )}&to=${ymd(to)}&token=${key}`,
      { provider: "finnhub" }
    );
    if (!Array.isArray(data)) return [];
    return data.filter((n) => n.headline).slice(0, 20).map((n) => ({
      headline: n.headline,
      summary: n.summary ?? "",
      source: n.source ?? "",
      url: n.url ?? "",
      datetime: n.datetime ?? 0
    }));
  });
}

// src/providers/krx.ts
var KRX_URL = "http://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd";
async function krxFinder(bld) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15e3);
  try {
    const res = await fetch(KRX_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: "http://data.krx.co.kr/contents/MDC/MDI/mdiLoader/index.cmd",
        "User-Agent": "Mozilla/5.0"
      },
      body: `bld=${encodeURIComponent(bld)}&mktsel=ALL&searchText=`,
      signal: controller.signal
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.block1) ? data.block1 : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}
async function getKrUniverse() {
  return cached("krx:universe", TTL.mapping, async () => {
    const [stocks, products] = await Promise.all([
      krxFinder("dbms/comm/finder/finder_stkisu"),
      // all listed stocks
      krxFinder("dbms/comm/finder/finder_secuprodisu")
      // ETF + ETN products
    ]);
    const out = [];
    for (const s of stocks) {
      if (!s.short_code || !s.codeName) continue;
      out.push({
        ticker: s.short_code,
        name: s.codeName,
        marketName: s.marketName ?? "",
        assetType: classifyAssetType(s.codeName, "KR")
      });
    }
    for (const p of products) {
      if (!p.short_code || !p.codeName) continue;
      let at = classifyAssetType(p.codeName, "KR");
      if (at === "STOCK" || at === "ADR" || at === "REIT") at = "ETF";
      out.push({
        ticker: p.short_code,
        name: p.codeName,
        marketName: "ETF\xB7ETN",
        assetType: at
      });
    }
    return out;
  });
}

// src/services/market-data.service.ts
var EXTRA_ALIASES = {
  \uC0BC\uC131\uC804\uC790: {
    ticker: "005930",
    name: "\uC0BC\uC131\uC804\uC790",
    market: "KR",
    currency: "KRW",
    aliases: ["\uC0BC\uC131", "\uC0BC\uC804", "samsung electronics", "samsung"]
  },
  \uC0BC\uC804: {
    ticker: "005930",
    name: "\uC0BC\uC131\uC804\uC790",
    market: "KR",
    currency: "KRW",
    aliases: ["\uC0BC\uC131\uC804\uC790", "\uC0BC\uC131", "samsung"]
  },
  sk\uD558\uC774\uB2C9\uC2A4: {
    ticker: "000660",
    name: "SK\uD558\uC774\uB2C9\uC2A4",
    market: "KR",
    currency: "KRW",
    aliases: ["\uD558\uC774\uB2C9\uC2A4", "sk hynix", "hynix"]
  },
  \uD558\uC774\uB2C9\uC2A4: {
    ticker: "000660",
    name: "SK\uD558\uC774\uB2C9\uC2A4",
    market: "KR",
    currency: "KRW",
    aliases: ["sk\uD558\uC774\uB2C9\uC2A4", "sk hynix"]
  },
  \uD604\uB300\uCC28: {
    ticker: "005380",
    name: "\uD604\uB300\uCC28",
    market: "KR",
    currency: "KRW",
    aliases: ["\uD604\uB300\uC790\uB3D9\uCC28", "hyundai motor"]
  },
  \uAE30\uC544: {
    ticker: "000270",
    name: "\uAE30\uC544",
    market: "KR",
    currency: "KRW",
    aliases: ["kia"]
  },
  \uB124\uC774\uBC84: {
    ticker: "035420",
    name: "NAVER",
    market: "KR",
    currency: "KRW",
    aliases: ["naver"]
  },
  \uCE74\uCE74\uC624: {
    ticker: "035720",
    name: "\uCE74\uCE74\uC624",
    market: "KR",
    currency: "KRW",
    aliases: ["kakao"]
  },
  \uC5D4\uBE44\uB514\uC544: {
    ticker: "NVDA",
    name: "NVIDIA",
    market: "US",
    currency: "USD",
    aliases: ["nvidia", "nvda"]
  },
  nvda: {
    ticker: "NVDA",
    name: "NVIDIA",
    market: "US",
    currency: "USD",
    aliases: ["\uC5D4\uBE44\uB514\uC544", "nvidia"]
  },
  \uC560\uD50C: {
    ticker: "AAPL",
    name: "Apple",
    market: "US",
    currency: "USD",
    aliases: ["apple", "aapl"]
  },
  \uD14C\uC2AC\uB77C: {
    ticker: "TSLA",
    name: "Tesla",
    market: "US",
    currency: "USD",
    aliases: ["tesla", "tsla"]
  },
  \uB9C8\uC774\uD06C\uB85C\uC18C\uD504\uD2B8: {
    ticker: "MSFT",
    name: "Microsoft",
    market: "US",
    currency: "USD",
    aliases: ["msft", "microsoft"]
  },
  \uC544\uB9C8\uC874: {
    ticker: "AMZN",
    name: "Amazon",
    market: "US",
    currency: "USD",
    aliases: ["amazon", "amzn"]
  },
  \uAD6C\uAE00: {
    ticker: "GOOGL",
    name: "Alphabet A",
    market: "US",
    currency: "USD",
    aliases: ["google", "alphabet", "googl", "goog"]
  },
  \uBA54\uD0C0: {
    ticker: "META",
    name: "Meta Platforms",
    market: "US",
    currency: "USD",
    aliases: ["meta", "facebook"]
  },
  \uBE0C\uB85C\uB4DC\uCEF4: {
    ticker: "AVGO",
    name: "Broadcom",
    market: "US",
    currency: "USD",
    aliases: ["broadcom", "avgo"]
  },
  amd: {
    ticker: "AMD",
    name: "AMD",
    market: "US",
    currency: "USD",
    aliases: ["advanced micro devices"]
  },
  \uC778\uD154: {
    ticker: "INTC",
    name: "Intel",
    market: "US",
    currency: "USD",
    aliases: ["intel", "intc"]
  },
  \uB9AC\uAC8C\uD2F0: {
    ticker: "RGTI",
    name: "Rigetti Computing",
    market: "US",
    currency: "USD",
    aliases: ["rigetti", "rgti"]
  },
  \uC544\uC774\uC628\uD050: {
    ticker: "IONQ",
    name: "IonQ",
    market: "US",
    currency: "USD",
    aliases: ["ionq"]
  }
};
var FALLBACK_CATALOG = [
  createEntry("005930", "\uC0BC\uC131\uC804\uC790", "KR", "KRW", ["\uC0BC\uC131", "\uC0BC\uC804"]),
  createEntry("000660", "SK\uD558\uC774\uB2C9\uC2A4", "KR", "KRW", ["\uD558\uC774\uB2C9\uC2A4"]),
  createEntry("005380", "\uD604\uB300\uCC28", "KR", "KRW", ["\uD604\uB300\uC790\uB3D9\uCC28"]),
  createEntry("000270", "\uAE30\uC544", "KR", "KRW", ["kia"]),
  createEntry("035420", "NAVER", "KR", "KRW", ["\uB124\uC774\uBC84"]),
  createEntry("035720", "\uCE74\uCE74\uC624", "KR", "KRW", ["kakao"]),
  createEntry("373220", "LG\uC5D0\uB108\uC9C0\uC194\uB8E8\uC158", "KR", "KRW", ["lg\uC5D4\uC194"]),
  createEntry("207940", "\uC0BC\uC131\uBC14\uC774\uC624\uB85C\uC9C1\uC2A4", "KR", "KRW", ["\uC0BC\uBC14"]),
  createEntry("068270", "\uC140\uD2B8\uB9AC\uC628", "KR", "KRW", []),
  createEntry("051910", "LG\uD654\uD559", "KR", "KRW", []),
  createEntry("006400", "\uC0BC\uC131SDI", "KR", "KRW", []),
  createEntry("005490", "POSCO\uD640\uB529\uC2A4", "KR", "KRW", ["\uD3EC\uC2A4\uCF54"]),
  createEntry("003670", "\uD3EC\uC2A4\uCF54\uD4E8\uCC98\uC5E0", "KR", "KRW", []),
  createEntry("012330", "\uD604\uB300\uBAA8\uBE44\uC2A4", "KR", "KRW", []),
  createEntry("028260", "\uC0BC\uC131\uBB3C\uC0B0", "KR", "KRW", []),
  createEntry("055550", "\uC2E0\uD55C\uC9C0\uC8FC", "KR", "KRW", []),
  createEntry("105560", "KB\uAE08\uC735", "KR", "KRW", []),
  createEntry("086790", "\uD558\uB098\uAE08\uC735\uC9C0\uC8FC", "KR", "KRW", []),
  createEntry("316140", "\uC6B0\uB9AC\uAE08\uC735\uC9C0\uC8FC", "KR", "KRW", []),
  createEntry("066570", "LG\uC804\uC790", "KR", "KRW", []),
  createEntry("096770", "SK\uC774\uB178\uBCA0\uC774\uC158", "KR", "KRW", []),
  createEntry("017670", "SK\uD154\uB808\uCF64", "KR", "KRW", []),
  createEntry("030200", "KT", "KR", "KRW", []),
  createEntry("032830", "\uC0BC\uC131\uC0DD\uBA85", "KR", "KRW", []),
  createEntry("000810", "\uC0BC\uC131\uD654\uC7AC", "KR", "KRW", []),
  createEntry("033780", "KT&G", "KR", "KRW", []),
  createEntry("015760", "\uD55C\uAD6D\uC804\uB825", "KR", "KRW", []),
  createEntry("034020", "\uB450\uC0B0\uC5D0\uB108\uBE4C\uB9AC\uD2F0", "KR", "KRW", []),
  createEntry("010130", "\uACE0\uB824\uC544\uC5F0", "KR", "KRW", []),
  createEntry("009540", "HD\uD55C\uAD6D\uC870\uC120\uD574\uC591", "KR", "KRW", []),
  createEntry("010140", "\uC0BC\uC131\uC911\uACF5\uC5C5", "KR", "KRW", []),
  createEntry("329180", "HD\uD604\uB300\uC911\uACF5\uC5C5", "KR", "KRW", []),
  createEntry("000720", "\uD604\uB300\uAC74\uC124", "KR", "KRW", []),
  createEntry("006360", "GS\uAC74\uC124", "KR", "KRW", []),
  createEntry("047040", "\uB300\uC6B0\uAC74\uC124", "KR", "KRW", []),
  createEntry("003490", "\uB300\uD55C\uD56D\uACF5", "KR", "KRW", []),
  createEntry("089590", "\uC81C\uC8FC\uD56D\uACF5", "KR", "KRW", []),
  createEntry("086520", "\uC5D0\uCF54\uD504\uB85C", "KR", "KRW", []),
  createEntry("247540", "\uC5D0\uCF54\uD504\uB85C\uBE44\uC5E0", "KR", "KRW", []),
  createEntry("196170", "\uC54C\uD14C\uC624\uC820", "KR", "KRW", []),
  createEntry("028300", "HLB", "KR", "KRW", []),
  createEntry("277810", "\uB808\uC778\uBCF4\uC6B0\uB85C\uBCF4\uD2F1\uC2A4", "KR", "KRW", []),
  createEntry("042700", "\uD55C\uBBF8\uBC18\uB3C4\uCCB4", "KR", "KRW", []),
  createEntry("352820", "\uD558\uC774\uBE0C", "KR", "KRW", []),
  createEntry("259960", "\uD06C\uB798\uD504\uD1A4", "KR", "KRW", []),
  createEntry("036570", "\uC5D4\uC528\uC18C\uD504\uD2B8", "KR", "KRW", []),
  createEntry("251270", "\uB137\uB9C8\uBE14", "KR", "KRW", []),
  createEntry("011200", "HMM", "KR", "KRW", []),
  createEntry("018260", "\uC0BC\uC131\uC5D0\uC2A4\uB514\uC5D0\uC2A4", "KR", "KRW", []),
  createEntry("090430", "\uC544\uBAA8\uB808\uD37C\uC2DC\uD53D", "KR", "KRW", []),
  createEntry("004020", "\uD604\uB300\uC81C\uCCA0", "KR", "KRW", []),
  createEntry("011070", "LG\uC774\uB178\uD14D", "KR", "KRW", []),
  createEntry("AAPL", "Apple", "US", "USD", ["\uC560\uD50C"]),
  createEntry("MSFT", "Microsoft", "US", "USD", ["\uB9C8\uC774\uD06C\uB85C\uC18C\uD504\uD2B8"]),
  createEntry("NVDA", "NVIDIA", "US", "USD", ["\uC5D4\uBE44\uB514\uC544"]),
  createEntry("GOOGL", "Alphabet A", "US", "USD", ["\uAD6C\uAE00", "\uC54C\uD30C\uBCB3"]),
  createEntry("GOOG", "Alphabet C", "US", "USD", ["\uAD6C\uAE00"]),
  createEntry("AMZN", "Amazon", "US", "USD", ["\uC544\uB9C8\uC874"]),
  createEntry("META", "Meta Platforms", "US", "USD", ["\uBA54\uD0C0", "\uD398\uC774\uC2A4\uBD81"]),
  createEntry("TSLA", "Tesla", "US", "USD", ["\uD14C\uC2AC\uB77C"]),
  createEntry("AVGO", "Broadcom", "US", "USD", ["\uBE0C\uB85C\uB4DC\uCEF4"]),
  createEntry("NFLX", "Netflix", "US", "USD", ["\uB137\uD50C\uB9AD\uC2A4"]),
  createEntry("AMD", "AMD", "US", "USD", []),
  createEntry("INTC", "Intel", "US", "USD", ["\uC778\uD154"]),
  createEntry("PLTR", "Palantir", "US", "USD", ["\uD314\uB780\uD2F0\uC5B4"]),
  createEntry("SOFI", "SoFi", "US", "USD", []),
  createEntry("COIN", "Coinbase", "US", "USD", ["\uCF54\uC778\uBCA0\uC774\uC2A4"]),
  createEntry("UBER", "Uber", "US", "USD", ["\uC6B0\uBC84"]),
  createEntry("AAL", "American Airlines", "US", "USD", []),
  createEntry("DAL", "Delta Air Lines", "US", "USD", []),
  createEntry("UAL", "United Airlines", "US", "USD", []),
  createEntry("JPM", "JPMorgan Chase", "US", "USD", []),
  createEntry("BAC", "Bank of America", "US", "USD", []),
  createEntry("XOM", "Exxon Mobil", "US", "USD", []),
  createEntry("CVX", "Chevron", "US", "USD", []),
  createEntry("LLY", "Eli Lilly", "US", "USD", []),
  createEntry("UNH", "UnitedHealth", "US", "USD", []),
  createEntry("WMT", "Walmart", "US", "USD", []),
  createEntry("COST", "Costco", "US", "USD", []),
  createEntry("ORCL", "Oracle", "US", "USD", []),
  createEntry("ADBE", "Adobe", "US", "USD", []),
  createEntry("CRM", "Salesforce", "US", "USD", []),
  createEntry("TXN", "Texas Instruments", "US", "USD", []),
  createEntry("QCOM", "Qualcomm", "US", "USD", []),
  createEntry("AMAT", "Applied Materials", "US", "USD", []),
  createEntry("MU", "Micron", "US", "USD", []),
  createEntry("SMCI", "Super Micro Computer", "US", "USD", []),
  createEntry("ARM", "Arm Holdings", "US", "USD", []),
  createEntry("TSM", "TSMC", "US", "USD", []),
  createEntry("ASML", "ASML", "US", "USD", []),
  createEntry("NVO", "Novo Nordisk", "US", "USD", []),
  createEntry("MRNA", "Moderna", "US", "USD", []),
  createEntry("PFE", "Pfizer", "US", "USD", []),
  createEntry("JNJ", "Johnson & Johnson", "US", "USD", []),
  createEntry("BA", "Boeing", "US", "USD", []),
  createEntry("DIS", "Disney", "US", "USD", []),
  createEntry("NKE", "Nike", "US", "USD", []),
  createEntry("SHOP", "Shopify", "US", "USD", []),
  createEntry("CRWD", "CrowdStrike", "US", "USD", []),
  createEntry("SNOW", "Snowflake", "US", "USD", []),
  createEntry("RGTI", "Rigetti Computing", "US", "USD", ["\uB9AC\uAC8C\uD2F0"]),
  createEntry("IONQ", "IonQ", "US", "USD", ["\uC544\uC774\uC628\uD050"])
];
function createEntry(ticker, name, marketValue, currency, aliases) {
  return {
    ticker,
    name,
    market: marketValue,
    currency,
    aliases
  };
}
function safeNumber3(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}
function cleanTicker3(ticker) {
  return String(ticker ?? "").trim().toUpperCase();
}
function normalizeText(value) {
  return String(value ?? "").toLowerCase().replace(/\s+/g, "").replace(/[()［］\[\]{}·.,_\-]/g, "");
}
function isKrTicker3(ticker) {
  return /^\d/.test(ticker);
}
function normalizeMarketValue(value, ticker) {
  const text = String(value ?? "").toUpperCase();
  if (text.includes("KR") || text.includes("KOSPI") || text.includes("KOSDAQ")) {
    return "KR";
  }
  if (text.includes("US") || text.includes("NASDAQ") || text.includes("NYSE")) {
    return "US";
  }
  return isKrTicker3(ticker) ? "KR" : "US";
}
function normalizeCurrencyValue(value, marketValue) {
  const text = String(value ?? "").toUpperCase();
  if (text === "KRW" || text === "USD") return text;
  return marketValue === "KR" ? "KRW" : "USD";
}
function catalogArray() {
  const base = Array.isArray(CATALOG) ? CATALOG : [];
  return dedupeEntries([...base, ...FALLBACK_CATALOG]);
}
function dedupeEntries(entries) {
  const map = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    const ticker = cleanTicker3(entry.ticker);
    if (!ticker) continue;
    const prev = map.get(ticker);
    map.set(ticker, {
      ...prev,
      ...entry,
      ticker,
      name: entry.name || prev?.name || ticker,
      market: normalizeMarketValue(entry.market, ticker),
      currency: normalizeCurrencyValue(
        entry.currency,
        normalizeMarketValue(entry.market, ticker)
      ),
      aliases: Array.from(
        /* @__PURE__ */ new Set([
          ...prev?.aliases ?? [],
          ...entry.aliases ?? []
        ])
      )
    });
  }
  return Array.from(map.values());
}
function toSearchResult(entry) {
  const ticker = cleanTicker3(entry.ticker);
  const marketValue = normalizeMarketValue(entry.market, ticker);
  const currency = normalizeCurrencyValue(entry.currency, marketValue);
  return {
    ticker,
    name: String(entry.name ?? ticker),
    market: String(marketValue),
    currency: String(currency),
    assetType: classifyAssetType(entry),
    aliases: entry.aliases ?? []
  };
}
function searchScore(entry, query) {
  const q = normalizeText(query);
  const ticker = normalizeText(entry.ticker);
  const name = normalizeText(entry.name);
  const aliases = (entry.aliases ?? []).map(normalizeText);
  if (!q) return 1;
  if (ticker === q) return 1e3;
  if (name === q) return 950;
  if (aliases.some((alias) => alias === q)) return 900;
  if (ticker.startsWith(q)) return 800;
  if (name.startsWith(q)) return 700;
  if (aliases.some((alias) => alias.startsWith(q))) return 650;
  if (ticker.includes(q)) return 500;
  if (name.includes(q)) return 450;
  if (aliases.some((alias) => alias.includes(q))) return 400;
  return 0;
}
function fallbackEntryFor(ticker) {
  const clean = cleanTicker3(ticker);
  const marketValue = normalizeMarketValue(void 0, clean);
  const currency = normalizeCurrencyValue(void 0, marketValue);
  return createEntry(clean, clean, marketValue, currency, []);
}
function resolveEntry(ticker) {
  const clean = cleanTicker3(ticker);
  const fromCatalog = getCatalogEntry(clean);
  if (fromCatalog) return fromCatalog;
  const fromFallback = catalogArray().find(
    (entry) => cleanTicker3(entry.ticker) === clean
  );
  if (fromFallback) return fromFallback;
  return fallbackEntryFor(clean);
}
function quotePrice(q) {
  return safeNumber3(
    q.price ?? q.currentPrice ?? q.regularMarketPrice ?? q.close ?? q.previousClose ?? q.prevClose,
    0
  );
}
function quotePreviousClose(q, price) {
  return safeNumber3(q.previousClose ?? q.prevClose, price);
}
function quoteChangeAmount(q, price, previousClose) {
  const direct = safeNumber3(q.changeAmount ?? q.change, Number.NaN);
  if (Number.isFinite(direct)) return direct;
  return price - previousClose;
}
function quoteChangePercent(q, price, previousClose, changeAmount) {
  const direct = safeNumber3(
    q.changePercent ?? q.regularMarketChangePercent ?? q.percent,
    Number.NaN
  );
  if (Number.isFinite(direct)) return direct;
  if (previousClose === 0) return 0;
  return changeAmount / previousClose * 100;
}
function defaultRating() {
  return scoreToRating(50);
}
function ratingFromQuote(quote5, entry) {
  try {
    const scores = computeScores({
      quote: quote5,
      entry
    });
    if (typeof scores === "number") return scoreToRating(scores);
    if (typeof scores?.total === "number") {
      return scoreToRating(scores.total);
    }
    if (typeof scores?.score === "number") {
      return scoreToRating(scores.score);
    }
    return defaultRating();
  } catch {
    return defaultRating();
  }
}
function toQuoteRow(entry, quote5) {
  const ticker = cleanTicker3(entry.ticker);
  const marketValue = normalizeMarketValue(entry.market, ticker);
  const currency = normalizeCurrencyValue(entry.currency, marketValue);
  const price = quotePrice(quote5);
  const previousClose = quotePreviousClose(quote5, price);
  const changeAmount = quoteChangeAmount(quote5, price, previousClose);
  const changePercent = quoteChangePercent(
    quote5,
    price,
    previousClose,
    changeAmount
  );
  const volume = safeNumber3(quote5.volume, 0);
  const tradingValue = safeNumber3(quote5.tradingValue, 0) || Math.max(price * volume, 0);
  return {
    ticker,
    name: String(entry.name ?? quote5.name ?? ticker),
    market: String(marketValue),
    currency: String(currency),
    assetType: classifyAssetType(entry),
    price,
    changeAmount,
    changePercent,
    volume,
    tradingValue,
    high: safeNumber3(quote5.high, 0),
    low: safeNumber3(quote5.low, 0),
    open: safeNumber3(quote5.open, 0),
    previousClose,
    updatedAt: String(quote5.updatedAt ?? (/* @__PURE__ */ new Date()).toISOString()),
    rating: ratingFromQuote(quote5, entry)
  };
}
function sampleQuoteFor(entry) {
  const ticker = cleanTicker3(entry.ticker);
  const base = isKrTicker3(ticker) ? 5e3 + (Number(ticker.slice(-3)) || 100) * 100 : 20 + ticker.charCodeAt(0) * 3;
  const seed = [...ticker].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const changePercent = Number(((seed % 1800 - 900) / 100).toFixed(2));
  const price = Math.max(1, Math.round(base * (1 + changePercent / 100)));
  const previousClose = price / (1 + changePercent / 100);
  const volume = 1e5 + seed * 1377;
  return {
    ticker,
    name: String(entry.name ?? ticker),
    price,
    previousClose,
    changeAmount: price - previousClose,
    changePercent,
    volume,
    tradingValue: price * volume,
    open: previousClose,
    high: Math.max(price, previousClose) * 1.02,
    low: Math.min(price, previousClose) * 0.98,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
async function tryQuoteProvider(entry) {
  const providers = providerStatus();
  const marketValue = normalizeMarketValue(entry.market, entry.ticker);
  const attempts = [];
  if (marketValue === "KR") {
    attempts.push(() => getQuote3?.(entry));
    attempts.push(() => quote2?.(entry));
  }
  attempts.push(() => getQuote2?.(entry));
  attempts.push(() => quote?.(entry));
  if (providers.finnhub) {
    attempts.push(() => getQuote4?.(entry));
    attempts.push(() => (void 0)?.(entry));
  }
  attempts.push(() => getQuote?.(entry.ticker));
  attempts.push(() => (void 0)?.(entry.ticker));
  for (const attempt of attempts) {
    try {
      const result = await attempt();
      if (result && typeof result === "object") {
        const quote5 = result;
        const price = quotePrice(quote5);
        if (price > 0 || quote5.changePercent != null || quote5.volume != null) {
          return quote5;
        }
      }
    } catch {
    }
  }
  return null;
}
async function tryCandlesProvider(entry, timeframe) {
  const attempts = [
    () => getCandles2?.(entry, timeframe),
    () => candles?.(entry, timeframe),
    () => getCandles3?.(entry, timeframe),
    () => candles2?.(entry, timeframe),
    () => (void 0)?.(entry, timeframe),
    () => (void 0)?.(entry, timeframe),
    () => getCandles?.(entry.ticker, timeframe),
    () => (void 0)?.(entry.ticker, timeframe)
  ];
  for (const attempt of attempts) {
    try {
      const result = await attempt();
      if (Array.isArray(result) && result.length > 0) {
        return result;
      }
    } catch {
    }
  }
  return buildFallbackCandles(entry);
}
function buildFallbackCandles(entry) {
  const quote5 = sampleQuoteFor(entry);
  const now = Date.now();
  const base = quotePrice(quote5);
  const candles5 = [];
  for (let i = 59; i >= 0; i -= 1) {
    const wave = Math.sin(i / 5) * 0.015;
    const close = Math.max(1, base * (1 + wave));
    const open = close * (1 - wave / 3);
    const high = Math.max(open, close) * 1.01;
    const low = Math.min(open, close) * 0.99;
    candles5.push({
      time: new Date(now - i * 864e5).toISOString(),
      open,
      high,
      low,
      close,
      volume: safeNumber3(quote5.volume, 1e5) + i * 1e3
    });
  }
  return candles5;
}
async function tryProfileProvider(entry) {
  const attempts = [
    () => (void 0)?.(entry),
    () => (void 0)?.(entry),
    () => getCompanyProfile2?.(entry),
    () => companyProfile?.(entry),
    () => getCompanyProfile(entry.ticker)
  ];
  for (const attempt of attempts) {
    try {
      const result = await attempt();
      if (result && typeof result === "object") {
        return result;
      }
    } catch {
    }
  }
  return {
    ticker: cleanTicker3(entry.ticker),
    name: String(entry.name ?? entry.ticker),
    market: String(entry.market ?? ""),
    currency: String(entry.currency ?? ""),
    description: "\uAE30\uC5C5 \uC815\uBCF4\uB97C \uD655\uC778 \uC911\uC785\uB2C8\uB2E4.",
    sector: "",
    industry: "",
    website: ""
  };
}
async function buildKrUniverseEntries() {
  try {
    const rows = await getKrUniverse();
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => {
      const ticker = cleanTicker3(row.ticker ?? row.code ?? row.symbol);
      const name = String(row.name ?? row.companyName ?? ticker);
      if (!ticker) return null;
      return createEntry(ticker, name, "KR", "KRW", [
        name
      ]);
    }).filter((entry) => Boolean(entry));
  } catch {
    return [];
  }
}
var MarketDataService = class {
  static async search(q, limit = 80) {
    const query = String(q ?? "").trim();
    const aliasEntries = Object.entries(EXTRA_ALIASES).map(
      ([, value]) => createEntry(
        value.ticker,
        value.name,
        value.market,
        value.currency,
        value.aliases
      )
    );
    const entries = dedupeEntries([
      ...catalogArray(),
      ...aliasEntries,
      ...query.length >= 2 ? await buildKrUniverseEntries() : []
    ]);
    for (const entry of entries) {
      try {
        registerDynamicEntry(entry);
      } catch {
      }
    }
    const scored = entries.map((entry) => ({
      entry,
      score: searchScore(entry, query)
    })).filter((item) => query ? item.score > 0 : true).sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return String(a.entry.ticker).localeCompare(
        String(b.entry.ticker)
      );
    }).slice(0, limit).map((item) => toSearchResult(item.entry));
    return scored;
  }
  static async getQuote(ticker) {
    const entry = resolveEntry(ticker);
    return cached(`quote:${cleanTicker3(ticker)}`, TTL.quote, async () => {
      const providerQuote = await tryQuoteProvider(entry);
      const quote5 = providerQuote ?? sampleQuoteFor(entry);
      return {
        ...quote5,
        ticker: cleanTicker3(entry.ticker),
        name: String(entry.name ?? entry.ticker)
      };
    });
  }
  static async getQuoteRow(ticker) {
    const entry = resolveEntry(ticker);
    try {
      const quote5 = await this.getQuote(ticker);
      return toQuoteRow(entry, quote5);
    } catch {
      try {
        return toQuoteRow(entry, sampleQuoteFor(entry));
      } catch {
        return null;
      }
    }
  }
  static async getQuotes(tickers) {
    const rows = await Promise.all(
      tickers.map((ticker) => this.getQuoteRow(ticker))
    );
    return rows.filter((row) => Boolean(row));
  }
  static async getCandles(ticker, timeframe = "1D") {
    const entry = resolveEntry(ticker);
    return cached(
      `candles:${cleanTicker3(ticker)}:${String(timeframe)}`,
      TTL.candles ?? TTL.quote,
      async () => tryCandlesProvider(entry, timeframe)
    );
  }
  static async getCompanyProfile(ticker) {
    const entry = resolveEntry(ticker);
    return cached(
      `company:${cleanTicker3(ticker)}`,
      TTL.profile ?? TTL.quote,
      async () => tryProfileProvider(entry)
    );
  }
  static async getProfile(ticker) {
    return this.getCompanyProfile(ticker);
  }
  static async getRating(ticker) {
    const quote5 = await this.getQuoteRow(ticker);
    return quote5?.rating ?? defaultRating();
  }
  static async getCatalogEntry(ticker) {
    return resolveEntry(ticker);
  }
  static async getUniverse(marketValue) {
    const entries = dedupeEntries([...catalogArray(), ...await buildKrUniverseEntries()]);
    const filtered = entries.filter((entry) => {
      if (!marketValue || marketValue === "ALL") return true;
      const ticker = cleanTicker3(entry.ticker);
      const entryMarket = normalizeMarketValue(entry.market, ticker);
      return String(entryMarket) === marketValue;
    });
    return filtered.map(toSearchResult);
  }
};

// src/data/sectors.ts
var SECTOR_MAP = {
  // ---- US ----
  AAPL: "IT\xB7\uD558\uB4DC\uC6E8\uC5B4",
  MSFT: "\uC18C\uD504\uD2B8\uC6E8\uC5B4",
  GOOGL: "\uC778\uD130\uB137\xB7\uD50C\uB7AB\uD3FC",
  GOOG: "\uC778\uD130\uB137\xB7\uD50C\uB7AB\uD3FC",
  AMZN: "\uC778\uD130\uB137\xB7\uD50C\uB7AB\uD3FC",
  META: "\uC778\uD130\uB137\xB7\uD50C\uB7AB\uD3FC",
  NFLX: "\uBBF8\uB514\uC5B4\xB7\uCF58\uD150\uCE20",
  DIS: "\uBBF8\uB514\uC5B4\xB7\uCF58\uD150\uCE20",
  CMCSA: "\uBBF8\uB514\uC5B4\xB7\uCF58\uD150\uCE20",
  WBD: "\uBBF8\uB514\uC5B4\xB7\uCF58\uD150\uCE20",
  NVDA: "\uBC18\uB3C4\uCCB4",
  AMD: "\uBC18\uB3C4\uCCB4",
  INTC: "\uBC18\uB3C4\uCCB4",
  AVGO: "\uBC18\uB3C4\uCCB4",
  QCOM: "\uBC18\uB3C4\uCCB4",
  TXN: "\uBC18\uB3C4\uCCB4",
  MU: "\uBC18\uB3C4\uCCB4",
  ASML: "\uBC18\uB3C4\uCCB4",
  LRCX: "\uBC18\uB3C4\uCCB4",
  KLAC: "\uBC18\uB3C4\uCCB4",
  ON: "\uBC18\uB3C4\uCCB4",
  TSLA: "\uC804\uAE30\uCC28\xB7\uBAA8\uBE4C\uB9AC\uD2F0",
  F: "\uC790\uB3D9\uCC28",
  GM: "\uC790\uB3D9\uCC28",
  RIVN: "\uC804\uAE30\uCC28\xB7\uBAA8\uBE4C\uB9AC\uD2F0",
  LCID: "\uC804\uAE30\uCC28\xB7\uBAA8\uBE4C\uB9AC\uD2F0",
  NIO: "\uC804\uAE30\uCC28\xB7\uBAA8\uBE4C\uB9AC\uD2F0",
  ORCL: "\uC18C\uD504\uD2B8\uC6E8\uC5B4",
  ADBE: "\uC18C\uD504\uD2B8\uC6E8\uC5B4",
  CRM: "\uC18C\uD504\uD2B8\uC6E8\uC5B4",
  NOW: "\uC18C\uD504\uD2B8\uC6E8\uC5B4",
  INTU: "\uC18C\uD504\uD2B8\uC6E8\uC5B4",
  PANW: "\uC0AC\uC774\uBC84\uBCF4\uC548",
  SNOW: "\uC18C\uD504\uD2B8\uC6E8\uC5B4",
  PLTR: "\uC18C\uD504\uD2B8\uC6E8\uC5B4",
  IBM: "IT\xB7\uC11C\uBE44\uC2A4",
  CSCO: "IT\xB7\uD558\uB4DC\uC6E8\uC5B4",
  COIN: "\uAC00\uC0C1\uC790\uC0B0\xB7\uD540\uD14C\uD06C",
  MSTR: "\uAC00\uC0C1\uC790\uC0B0\xB7\uD540\uD14C\uD06C",
  SQ: "\uAC00\uC0C1\uC790\uC0B0\xB7\uD540\uD14C\uD06C",
  SOFI: "\uAC00\uC0C1\uC790\uC0B0\xB7\uD540\uD14C\uD06C",
  UBER: "\uC778\uD130\uB137\xB7\uD50C\uB7AB\uD3FC",
  JPM: "\uAE08\uC735",
  BAC: "\uAE08\uC735",
  WFC: "\uAE08\uC735",
  GS: "\uC99D\uAD8C",
  MS: "\uC99D\uAD8C",
  C: "\uAE08\uC735",
  SCHW: "\uC99D\uAD8C",
  BLK: "\uC99D\uAD8C",
  AXP: "\uAE08\uC735\xB7\uACB0\uC81C",
  V: "\uAE08\uC735\xB7\uACB0\uC81C",
  MA: "\uAE08\uC735\xB7\uACB0\uC81C",
  PYPL: "\uAC00\uC0C1\uC790\uC0B0\xB7\uD540\uD14C\uD06C",
  XOM: "\uC5D0\uB108\uC9C0\xB7\uC815\uC720",
  CVX: "\uC5D0\uB108\uC9C0\xB7\uC815\uC720",
  COP: "\uC5D0\uB108\uC9C0\xB7\uC815\uC720",
  SLB: "\uC5D0\uB108\uC9C0\xB7\uC815\uC720",
  OXY: "\uC5D0\uB108\uC9C0\xB7\uC815\uC720",
  LLY: "\uC81C\uC57D\xB7\uBC14\uC774\uC624",
  PFE: "\uC81C\uC57D\xB7\uBC14\uC774\uC624",
  MRNA: "\uC81C\uC57D\xB7\uBC14\uC774\uC624",
  JNJ: "\uC81C\uC57D\xB7\uBC14\uC774\uC624",
  MRK: "\uC81C\uC57D\xB7\uBC14\uC774\uC624",
  ABBV: "\uC81C\uC57D\xB7\uBC14\uC774\uC624",
  GILD: "\uC81C\uC57D\xB7\uBC14\uC774\uC624",
  TMO: "\uC758\uB8CC\uAE30\uAE30",
  ABT: "\uC758\uB8CC\uAE30\uAE30",
  UNH: "\uAE08\uC735",
  // 건강보험
  RGTI: "\uC591\uC790\xB7\uC2E0\uAE30\uC220",
  CMMB: "\uC81C\uC57D\xB7\uBC14\uC774\uC624",
  BA: "\uBC29\uC0B0\xB7\uD56D\uACF5\uC6B0\uC8FC",
  LMT: "\uBC29\uC0B0\xB7\uD56D\uACF5\uC6B0\uC8FC",
  RTX: "\uBC29\uC0B0\xB7\uD56D\uACF5\uC6B0\uC8FC",
  CAT: "\uAE30\uACC4\xB7\uC911\uACF5\uC5C5",
  GE: "\uAE30\uACC4\xB7\uC911\uACF5\uC5C5",
  HON: "\uAE30\uACC4\xB7\uC911\uACF5\uC5C5",
  UPS: "\uC6B4\uC1A1\xB7\uBB3C\uB958",
  FDX: "\uC6B4\uC1A1\xB7\uBB3C\uB958",
  DAL: "\uD56D\uACF5\xB7\uC5EC\uD589",
  UAL: "\uD56D\uACF5\xB7\uC5EC\uD589",
  AAL: "\uD56D\uACF5\xB7\uC5EC\uD589",
  LUV: "\uD56D\uACF5\xB7\uC5EC\uD589",
  T: "\uD1B5\uC2E0",
  VZ: "\uD1B5\uC2E0",
  TMUS: "\uD1B5\uC2E0",
  WMT: "\uC720\uD1B5\xB7\uC18C\uBE44\uC7AC",
  COST: "\uC720\uD1B5\xB7\uC18C\uBE44\uC7AC",
  TGT: "\uC720\uD1B5\xB7\uC18C\uBE44\uC7AC",
  HD: "\uC720\uD1B5\xB7\uC18C\uBE44\uC7AC",
  LOW: "\uC720\uD1B5\xB7\uC18C\uBE44\uC7AC",
  NKE: "\uC720\uD1B5\xB7\uC18C\uBE44\uC7AC",
  SBUX: "\uC74C\uC2DD\xB7\uC2DD\uD488",
  MCD: "\uC74C\uC2DD\xB7\uC2DD\uD488",
  KO: "\uC74C\uC2DD\xB7\uC2DD\uD488",
  PEP: "\uC74C\uC2DD\xB7\uC2DD\uD488",
  PG: "\uC720\uD1B5\xB7\uC18C\uBE44\uC7AC",
  CL: "\uC720\uD1B5\xB7\uC18C\uBE44\uC7AC",
  GME: "\uC720\uD1B5\xB7\uC18C\uBE44\uC7AC",
  AMC: "\uBBF8\uB514\uC5B4\xB7\uCF58\uD150\uCE20",
  // ---- KR ----
  "005930": "\uBC18\uB3C4\uCCB4",
  "000660": "\uBC18\uB3C4\uCCB4",
  "042700": "\uBC18\uB3C4\uCCB4",
  "000990": "\uBC18\uB3C4\uCCB4",
  "011070": "\uC804\uC790\uBD80\uD488",
  "009150": "\uC804\uC790\uBD80\uD488",
  "066570": "\uC804\uC790\xB7\uAC00\uC804",
  "034220": "\uC804\uC790\uBD80\uD488",
  "018260": "IT\xB7\uC11C\uBE44\uC2A4",
  "005380": "\uC790\uB3D9\uCC28",
  "000270": "\uC790\uB3D9\uCC28",
  "012330": "\uC790\uB3D9\uCC28\uBD80\uD488",
  "064350": "\uBC29\uC0B0\xB7\uCCA0\uB3C4",
  "035420": "\uC778\uD130\uB137\xB7\uD50C\uB7AB\uD3FC",
  "035720": "\uC778\uD130\uB137\xB7\uD50C\uB7AB\uD3FC",
  "323410": "\uAC00\uC0C1\uC790\uC0B0\xB7\uD540\uD14C\uD06C",
  "373220": "2\uCC28\uC804\uC9C0",
  "006400": "2\uCC28\uC804\uC9C0",
  "003670": "2\uCC28\uC804\uC9C0",
  "011790": "2\uCC28\uC804\uC9C0",
  "051910": "\uD654\uD559\xB72\uCC28\uC804\uC9C0",
  "009830": "\uD0DC\uC591\uAD11\xB7\uC2E0\uC7AC\uC0DD",
  "010060": "\uD0DC\uC591\uAD11\xB7\uC2E0\uC7AC\uC0DD",
  "011780": "\uD654\uD559\xB72\uCC28\uC804\uC9C0",
  "207940": "\uC81C\uC57D\xB7\uBC14\uC774\uC624",
  "068270": "\uC81C\uC57D\xB7\uBC14\uC774\uC624",
  "000100": "\uC81C\uC57D\xB7\uBC14\uC774\uC624",
  "128940": "\uC81C\uC57D\xB7\uBC14\uC774\uC624",
  "185750": "\uC81C\uC57D\xB7\uBC14\uC774\uC624",
  "069620": "\uC81C\uC57D\xB7\uBC14\uC774\uC624",
  "326030": "\uC81C\uC57D\xB7\uBC14\uC774\uC624",
  "006280": "\uC81C\uC57D\xB7\uBC14\uC774\uC624",
  "302440": "\uC81C\uC57D\xB7\uBC14\uC774\uC624",
  "145750": "\uC758\uB8CC\uAE30\uAE30",
  "145020": "\uC758\uB8CC\uAE30\uAE30",
  "214150": "\uC758\uB8CC\uAE30\uAE30",
  "005490": "\uCCA0\uAC15\xB7\uC18C\uC7AC",
  "004020": "\uCCA0\uAC15\xB7\uC18C\uC7AC",
  "010130": "\uCCA0\uAC15\xB7\uC18C\uC7AC",
  "105560": "\uAE08\uC735",
  "055550": "\uAE08\uC735",
  "086790": "\uAE08\uC735",
  "316140": "\uAE08\uC735",
  "024110": "\uAE08\uC735",
  "138040": "\uAE08\uC735",
  "032830": "\uBCF4\uD5D8",
  "000810": "\uBCF4\uD5D8",
  "001450": "\uBCF4\uD5D8",
  "000060": "\uBCF4\uD5D8",
  "088350": "\uBCF4\uD5D8",
  "039490": "\uC99D\uAD8C",
  "016360": "\uC99D\uAD8C",
  "071050": "\uC99D\uAD8C",
  "006800": "\uC99D\uAD8C",
  "005940": "\uC99D\uAD8C",
  "015760": "\uC804\uB825\xB7\uC720\uD2F8\uB9AC\uD2F0",
  "036460": "\uC5D0\uB108\uC9C0\xB7\uC815\uC720",
  "017670": "\uD1B5\uC2E0",
  "030200": "\uD1B5\uC2E0",
  "032640": "\uD1B5\uC2E0",
  "028260": "\uC9C0\uC8FC\xB7\uAC74\uC124",
  "000720": "\uC9C0\uC8FC\xB7\uAC74\uC124",
  "047040": "\uC9C0\uC8FC\xB7\uAC74\uC124",
  "006360": "\uC9C0\uC8FC\xB7\uAC74\uC124",
  "011200": "\uC6B4\uC1A1\xB7\uD574\uC6B4",
  "096770": "\uC5D0\uB108\uC9C0\xB7\uC815\uC720",
  "010950": "\uC5D0\uB108\uC9C0\xB7\uC815\uC720",
  "036570": "\uAC8C\uC784",
  "251270": "\uAC8C\uC784",
  "263750": "\uAC8C\uC784",
  "293490": "\uAC8C\uC784",
  "352820": "\uC5D4\uD130\xB7\uBBF8\uB514\uC5B4",
  "041510": "\uC5D4\uD130\xB7\uBBF8\uB514\uC5B4",
  "122870": "\uC5D4\uD130\xB7\uBBF8\uB514\uC5B4",
  "035900": "\uC5D4\uD130\xB7\uBBF8\uB514\uC5B4",
  "090430": "\uD654\uC7A5\uD488",
  "051900": "\uD654\uC7A5\uD488",
  "097950": "\uC74C\uC2DD\xB7\uC2DD\uD488",
  "004370": "\uC74C\uC2DD\xB7\uC2DD\uD488",
  "271560": "\uC74C\uC2DD\xB7\uC2DD\uD488",
  "000080": "\uC74C\uC2DD\xB7\uC2DD\uD488",
  "139480": "\uC720\uD1B5\xB7\uC18C\uBE44\uC7AC",
  "069960": "\uC720\uD1B5\xB7\uC18C\uBE44\uC7AC",
  "282330": "\uC720\uD1B5\xB7\uC18C\uBE44\uC7AC",
  "078930": "\uC9C0\uC8FC\xB7\uAC74\uC124",
  "010140": "\uC870\uC120",
  "042660": "\uC870\uC120",
  "329180": "\uC870\uC120",
  "267250": "\uC9C0\uC8FC\xB7\uAC74\uC124",
  "010620": "\uC870\uC120",
  "003490": "\uD56D\uACF5\xB7\uC5EC\uD589",
  "020560": "\uD56D\uACF5\xB7\uC5EC\uD589",
  "180640": "\uD56D\uACF5\xB7\uC5EC\uD589",
  "000120": "\uC6B4\uC1A1\xB7\uBB3C\uB958",
  "012450": "\uBC29\uC0B0\xB7\uD56D\uACF5\uC6B0\uC8FC",
  "047810": "\uBC29\uC0B0\xB7\uD56D\uACF5\uC6B0\uC8FC",
  "272210": "\uBC29\uC0B0\xB7\uD56D\uACF5\uC6B0\uC8FC",
  "000880": "\uC9C0\uC8FC\xB7\uAC74\uC124",
  "034730": "\uC9C0\uC8FC\xB7\uAC74\uC124",
  "003550": "\uC9C0\uC8FC\xB7\uAC74\uC124",
  "001040": "\uC9C0\uC8FC\xB7\uAC74\uC124",
  "267260": "\uC9C0\uC8FC\xB7\uAC74\uC124"
};

// src/services/themes.service.ts
var THEME_STOCK_LIMIT = 100;
var SURGE_PCT = 3;
var PLUNGE_PCT = -3;
var LARGE_CAP_MIN_USD = 1e10;
var LARGE_CAP_MIN_KRW = 1e13;
function largeCapMin(currency) {
  return currency === "USD" ? LARGE_CAP_MIN_USD : LARGE_CAP_MIN_KRW;
}
var DYNAMIC_LIMIT = 40;
var THEME_DEFS = [
  {
    key: "semiconductor",
    label: "\uBC18\uB3C4\uCCB4",
    sectors: ["\uBC18\uB3C4\uCCB4", "\uC804\uC790\uBD80\uD488"],
    keywords: [
      "semiconductor",
      "semi",
      "chip",
      "foundry",
      "micron",
      "nvidia",
      "broadcom",
      "\uBC18\uB3C4\uCCB4",
      "\uD558\uC774\uB2C9\uC2A4",
      "\uB514\uBE44\uD558\uC774\uD14D",
      "db\uD558\uC774\uD14D",
      "\uD55C\uBBF8\uBC18\uB3C4\uCCB4",
      "\uC774\uB178\uD14D",
      "\uC804\uAE30"
    ]
  },
  {
    key: "ai",
    label: "AI\xB7\uC778\uACF5\uC9C0\uB2A5",
    sectors: ["\uC591\uC790\xB7\uC2E0\uAE30\uC220"],
    keywords: [
      "ai",
      "artificial intelligence",
      "palantir",
      "nvidia",
      "quantum",
      "rigetti",
      "\uC778\uACF5\uC9C0\uB2A5",
      "\uC591\uC790"
    ]
  },
  {
    key: "ev",
    label: "\uC804\uAE30\uCC28",
    sectors: ["\uC804\uAE30\uCC28\xB7\uBAA8\uBE4C\uB9AC\uD2F0"],
    keywords: [
      "ev",
      "electric vehicle",
      "tesla",
      "rivian",
      "lucid",
      "nio",
      "\uC804\uAE30\uCC28",
      "\uCC28\uC774\uB098\uC804\uAE30\uCC28"
    ]
  },
  {
    key: "battery",
    label: "2\uCC28\uC804\uC9C0\xB7\uBC30\uD130\uB9AC",
    sectors: ["2\uCC28\uC804\uC9C0", "\uD654\uD559\xB72\uCC28\uC804\uC9C0"],
    keywords: [
      "battery",
      "lithium",
      "\uBC30\uD130\uB9AC",
      "2\uCC28\uC804\uC9C0",
      "\uC774\uCC28\uC804\uC9C0",
      "\uC804\uC9C0",
      "\uC5D0\uB108\uC9C0\uC194\uB8E8\uC158",
      "\uC5D0\uC2A4\uB514\uC544\uC774",
      "sdi",
      "\uC5D8\uC564\uC5D0\uD504",
      "\uD3EC\uC2A4\uCF54\uD4E8\uCC98\uC5E0",
      "\uD4E8\uCC98\uC5E0"
    ]
  },
  {
    key: "bio",
    label: "\uBC14\uC774\uC624\xB7\uC81C\uC57D",
    sectors: ["\uC81C\uC57D\xB7\uBC14\uC774\uC624"],
    keywords: [
      "bio",
      "pharma",
      "therapeut",
      "genom",
      "drug",
      "lilly",
      "pfizer",
      "moderna",
      "\uBC14\uC774\uC624",
      "\uC81C\uC57D",
      "\uD31C",
      "\uC0DD\uBA85\uACFC\uD559",
      "\uC2E0\uC57D",
      "\uC140\uD2B8\uB9AC\uC628",
      "\uC720\uD55C\uC591\uD589",
      "\uD55C\uBBF8\uC57D\uD488",
      "\uC885\uADFC\uB2F9",
      "\uB300\uC6C5",
      "\uB179\uC2ED\uC790",
      "\uBC14\uC774\uC624\uC0AC\uC774\uC5B8\uC2A4",
      "\uBC14\uC774\uC624\uB85C\uC9C1\uC2A4"
    ]
  },
  {
    key: "medical",
    label: "\uC758\uB8CC\uAE30\uAE30",
    sectors: ["\uC758\uB8CC\uAE30\uAE30"],
    keywords: [
      "medical device",
      "diagnostic",
      "thermo fisher",
      "abbott",
      "\uC758\uB8CC\uAE30\uAE30",
      "\uD734\uC824",
      "\uD074\uB798\uC2DC\uC2A4",
      "\uB8E8\uB2DB",
      "\uBA54\uB514\uD1A1\uC2A4"
    ]
  },
  {
    key: "robot",
    label: "\uB85C\uBD07",
    sectors: [],
    keywords: [
      "robot",
      "robotics",
      "automation",
      "\uB85C\uBD07",
      "\uB85C\uBCF4",
      "\uB808\uC778\uBCF4\uC6B0",
      "\uB450\uC0B0\uB85C\uBCF4\uD2F1\uC2A4"
    ]
  },
  {
    key: "defense",
    label: "\uBC29\uC0B0",
    sectors: ["\uBC29\uC0B0\xB7\uD56D\uACF5\uC6B0\uC8FC", "\uBC29\uC0B0\xB7\uCCA0\uB3C4"],
    keywords: [
      "defense",
      "aerospace",
      "lockheed",
      "rtx",
      "boeing",
      "\uBC29\uC0B0",
      "\uBC29\uC704",
      "\uD56D\uACF5\uC6B0\uC8FC",
      "\uC5D0\uC5B4\uB85C\uC2A4\uD398\uC774\uC2A4",
      "\uD55C\uD654\uC2DC\uC2A4\uD15C",
      "\uD55C\uAD6D\uD56D\uACF5\uC6B0\uC8FC",
      "\uD604\uB300\uB85C\uD15C",
      "k\uBC29\uC0B0"
    ]
  },
  {
    key: "shipbuilding",
    label: "\uC870\uC120",
    sectors: ["\uC870\uC120"],
    keywords: [
      "shipbuild",
      "marine",
      "\uC870\uC120",
      "\uC911\uACF5\uC5C5",
      "\uD55C\uD654\uC624\uC158",
      "\uD604\uB300\uC911\uACF5\uC5C5",
      "\uD604\uB300\uBBF8\uD3EC",
      "\uC0BC\uC131\uC911\uACF5\uC5C5"
    ]
  },
  {
    key: "auto",
    label: "\uC790\uB3D9\uCC28",
    sectors: ["\uC790\uB3D9\uCC28", "\uC790\uB3D9\uCC28\uBD80\uD488", "\uC804\uAE30\uCC28\xB7\uBAA8\uBE4C\uB9AC\uD2F0"],
    keywords: [
      "motor",
      "auto",
      "vehicle",
      "ford",
      "general motors",
      "\uC790\uB3D9\uCC28",
      "\uBAA8\uBE44\uC2A4",
      "\uD604\uB300\uCC28",
      "\uAE30\uC544"
    ]
  },
  {
    key: "bank",
    label: "\uAE08\uC735\xB7\uC740\uD589",
    sectors: ["\uAE08\uC735"],
    keywords: [
      "bank",
      "financial",
      "jpmorgan",
      "wells fargo",
      "citigroup",
      "\uAE08\uC735",
      "\uC740\uD589",
      "\uC9C0\uC8FC",
      "\uCE74\uB4DC",
      "\uCE90\uD53C\uD0C8",
      "\uCE74\uCE74\uC624\uBC45\uD06C",
      "\uAE30\uC5C5\uC740\uD589"
    ]
  },
  {
    key: "insurance",
    label: "\uBCF4\uD5D8",
    sectors: ["\uBCF4\uD5D8"],
    keywords: [
      "insurance",
      "\uBCF4\uD5D8",
      "\uD654\uC7AC",
      "\uC0DD\uBA85",
      "\uD574\uC0C1",
      "\uBA54\uB9AC\uCE20\uD654\uC7AC",
      "\uC0BC\uC131\uC0DD\uBA85",
      "\uD55C\uD654\uC0DD\uBA85",
      "\uD604\uB300\uD574\uC0C1"
    ]
  },
  {
    key: "securities",
    label: "\uC99D\uAD8C",
    sectors: ["\uC99D\uAD8C"],
    keywords: [
      "securities",
      "goldman",
      "morgan stanley",
      "schwab",
      "blackrock",
      "\uC99D\uAD8C",
      "\uD22C\uC790\uC99D\uAD8C",
      "\uAE08\uC735\uC9C0\uC8FC",
      "\uD0A4\uC6C0"
    ]
  },
  {
    key: "construction",
    label: "\uAC74\uC124",
    sectors: ["\uC9C0\uC8FC\xB7\uAC74\uC124"],
    keywords: [
      "construction",
      "engineering",
      "\uAC74\uC124",
      "\uC5D4\uC9C0\uB2C8\uC5B4\uB9C1",
      "\uD604\uB300\uAC74\uC124",
      "\uB300\uC6B0\uAC74\uC124",
      "gs\uAC74\uC124",
      "\uC0BC\uC131\uBB3C\uC0B0"
    ]
  },
  {
    key: "steel",
    label: "\uCCA0\uAC15",
    sectors: ["\uCCA0\uAC15\xB7\uC18C\uC7AC"],
    keywords: [
      "steel",
      "metal",
      "\uCCA0\uAC15",
      "\uC81C\uCCA0",
      "posco",
      "\uD3EC\uC2A4\uCF54",
      "\uACE0\uB824\uC544\uC5F0",
      "\uD604\uB300\uC81C\uCCA0"
    ]
  },
  {
    key: "chemical",
    label: "\uD654\uD559",
    sectors: ["\uD654\uD559\xB72\uCC28\uC804\uC9C0"],
    keywords: [
      "chemical",
      "chem",
      "\uD654\uD559",
      "lg\uD654\uD559",
      "\uAE08\uD638\uC11D\uC720",
      "\uD55C\uD654\uC194\uB8E8\uC158",
      "oci",
      "skc",
      "\uB86F\uB370\uCF00\uBBF8\uCE7C"
    ]
  },
  {
    key: "oil-energy",
    label: "\uC815\uC720\xB7\uC5D0\uB108\uC9C0",
    sectors: ["\uC5D0\uB108\uC9C0\xB7\uC815\uC720", "\uC5D0\uB108\uC9C0"],
    keywords: [
      "oil",
      "gas",
      "petroleum",
      "exxon",
      "chevron",
      "conocophillips",
      "schlumberger",
      "occidental",
      "\uC815\uC720",
      "\uC11D\uC720",
      "\uAC00\uC2A4",
      "s-oil",
      "sk\uC774\uB178\uBCA0\uC774\uC158",
      "\uAC00\uC2A4\uACF5\uC0AC"
    ]
  },
  {
    key: "nuclear",
    label: "\uC6D0\uC804",
    sectors: [],
    keywords: [
      "nuclear",
      "uranium",
      "\uC6D0\uC804",
      "\uC6D0\uC790\uB825",
      "\uB450\uC0B0\uC5D0\uB108\uBE4C\uB9AC\uD2F0",
      "\uD55C\uC804\uAE30\uC220"
    ]
  },
  {
    key: "solar",
    label: "\uD0DC\uC591\uAD11\xB7\uC2E0\uC7AC\uC0DD",
    sectors: ["\uD0DC\uC591\uAD11\xB7\uC2E0\uC7AC\uC0DD"],
    keywords: [
      "solar",
      "renewable",
      "\uD0DC\uC591\uAD11",
      "\uC2E0\uC7AC\uC0DD",
      "\uD55C\uD654\uC194\uB8E8\uC158",
      "oci",
      "\uD48D\uB825"
    ]
  },
  {
    key: "power",
    label: "\uC804\uB825\xB7\uC804\uC120",
    sectors: ["\uC804\uB825\xB7\uC720\uD2F8\uB9AC\uD2F0"],
    keywords: [
      "power",
      "utility",
      "electric power",
      "\uC804\uB825",
      "\uC804\uC120",
      "\uD55C\uAD6D\uC804\uB825",
      "\uD55C\uC804",
      "\uB300\uD55C\uC804\uC120",
      "ls"
    ]
  },
  {
    key: "food",
    label: "\uC74C\uC2DD\xB7\uC2DD\uD488",
    sectors: ["\uC74C\uC2DD\xB7\uC2DD\uD488"],
    keywords: [
      "food",
      "beverage",
      "coca-cola",
      "pepsi",
      "mcdonald",
      "starbucks",
      "\uC2DD\uD488",
      "\uC81C\uB2F9",
      "\uC74C\uB8CC",
      "\uC81C\uACFC",
      "\uB18D\uC2EC",
      "\uC624\uB9AC\uC628",
      "\uC9C4\uB85C",
      "\uC81C\uC77C\uC81C\uB2F9"
    ]
  },
  {
    key: "cosmetics",
    label: "\uD654\uC7A5\uD488",
    sectors: ["\uD654\uC7A5\uD488"],
    keywords: [
      "cosmetic",
      "beauty",
      "\uD654\uC7A5\uD488",
      "\uC544\uBAA8\uB808",
      "\uC0DD\uD65C\uAC74\uAC15",
      "\uCF54\uC2A4\uBA54\uD2F1"
    ]
  },
  {
    key: "game",
    label: "\uAC8C\uC784",
    sectors: ["\uAC8C\uC784"],
    keywords: [
      "game",
      "gaming",
      "\uAC8C\uC784",
      "\uC5D4\uC528",
      "\uB137\uB9C8\uBE14",
      "\uD384\uC5B4\uBE44\uC2A4",
      "\uCE74\uCE74\uC624\uAC8C\uC784\uC988",
      "\uD06C\uB798\uD504\uD1A4",
      "\uC704\uBA54\uC774\uB4DC"
    ]
  },
  {
    key: "entertainment",
    label: "\uC5D4\uD130",
    sectors: ["\uC5D4\uD130\xB7\uBBF8\uB514\uC5B4"],
    keywords: [
      "entertainment",
      "\uC5D4\uD130",
      "\uD558\uC774\uBE0C",
      "\uC5D0\uC2A4\uC5E0",
      "\uC640\uC774\uC9C0",
      "jyp",
      "\uAE30\uD68D\uC0AC"
    ]
  },
  {
    key: "media",
    label: "\uBBF8\uB514\uC5B4",
    sectors: ["\uBBF8\uB514\uC5B4\xB7\uCF58\uD150\uCE20"],
    keywords: [
      "media",
      "content",
      "studio",
      "netflix",
      "disney",
      "warner",
      "comcast",
      "\uBBF8\uB514\uC5B4",
      "\uCF58\uD150\uCE20",
      "\uBC29\uC1A1",
      "cj enm"
    ]
  },
  {
    key: "telecom",
    label: "\uD1B5\uC2E0",
    sectors: ["\uD1B5\uC2E0"],
    keywords: [
      "telecom",
      "wireless",
      "communications",
      "verizon",
      "t-mobile",
      "\uD1B5\uC2E0",
      "skt",
      "sk\uD154\uB808\uCF64",
      "kt",
      "lg\uC720\uD50C\uB7EC\uC2A4"
    ]
  },
  {
    key: "internet",
    label: "\uC778\uD130\uB137\xB7\uD50C\uB7AB\uD3FC",
    sectors: ["\uC778\uD130\uB137\xB7\uD50C\uB7AB\uD3FC"],
    keywords: [
      "internet",
      "platform",
      "commerce",
      "\uC778\uD130\uB137",
      "\uD50C\uB7AB\uD3FC",
      "naver",
      "\uB124\uC774\uBC84",
      "\uCE74\uCE74\uC624",
      "kakao",
      "amazon",
      "alphabet",
      "meta",
      "uber"
    ]
  },
  {
    key: "cloud-software",
    label: "\uD074\uB77C\uC6B0\uB4DC\xB7\uC18C\uD504\uD2B8\uC6E8\uC5B4",
    sectors: ["\uC18C\uD504\uD2B8\uC6E8\uC5B4", "IT\xB7\uC11C\uBE44\uC2A4", "IT\xB7\uD558\uB4DC\uC6E8\uC5B4"],
    keywords: [
      "cloud",
      "software",
      "oracle",
      "adobe",
      "salesforce",
      "servicenow",
      "intuit",
      "snowflake",
      "microsoft",
      "\uC18C\uD504\uD2B8\uC6E8\uC5B4",
      "\uD074\uB77C\uC6B0\uB4DC",
      "\uC5D0\uC2A4\uB514\uC5D0\uC2A4"
    ]
  },
  {
    key: "cybersecurity",
    label: "\uC0AC\uC774\uBC84\uBCF4\uC548",
    sectors: ["\uC0AC\uC774\uBC84\uBCF4\uC548"],
    keywords: ["cybersecurity", "security", "palo alto", "\uBCF4\uC548", "\uC0AC\uC774\uBC84"]
  },
  {
    key: "travel",
    label: "\uD56D\uACF5\xB7\uC5EC\uD589",
    sectors: ["\uD56D\uACF5\xB7\uC5EC\uD589"],
    keywords: [
      "airline",
      "air lines",
      "travel",
      "delta",
      "united airlines",
      "southwest",
      "\uD56D\uACF5",
      "\uC5EC\uD589",
      "\uB300\uD55C\uD56D\uACF5",
      "\uC544\uC2DC\uC544\uB098",
      "\uC5EC\uD589\uB808\uC800"
    ]
  },
  {
    key: "logistics",
    label: "\uD574\uC6B4\xB7\uBB3C\uB958",
    sectors: ["\uC6B4\uC1A1\xB7\uD574\uC6B4", "\uC6B4\uC1A1\xB7\uBB3C\uB958"],
    keywords: [
      "shipping",
      "logistics",
      "parcel",
      "fedex",
      "\uD574\uC6B4",
      "\uBB3C\uB958",
      "\uD0DD\uBC30",
      "hmm",
      "\uB300\uD55C\uD1B5\uC6B4"
    ]
  },
  {
    key: "retail",
    label: "\uC720\uD1B5",
    sectors: ["\uC720\uD1B5\xB7\uC18C\uBE44\uC7AC"],
    keywords: [
      "retail",
      "wholesale",
      "walmart",
      "costco",
      "target",
      "home depot",
      "nike",
      "\uC720\uD1B5",
      "\uB9AC\uD14C\uC77C",
      "\uC774\uB9C8\uD2B8",
      "\uBC31\uD654\uC810"
    ]
  },
  {
    key: "reit",
    label: "\uB9AC\uCE20\xB7\uBD80\uB3D9\uC0B0",
    sectors: [],
    keywords: ["reit", "realty", "real estate", "\uB9AC\uCE20", "\uBD80\uB3D9\uC0B0"]
  }
];
var ETP_KEYS = {
  etf: "etf",
  etn: "etn",
  leverage: "leverage",
  inverse: "inverse"
};
var ETP_KEYWORD_THEMES = [
  {
    key: "commodity",
    label: "\uC6D0\uC790\uC7AC",
    keywords: [
      "commodity",
      "natural gas",
      "crude",
      "oil",
      "copper",
      "agriculture",
      "\uC6D0\uC790\uC7AC",
      "\uCC9C\uC5F0\uAC00\uC2A4",
      "\uC6D0\uC720",
      "\uAD6C\uB9AC",
      "\uB18D\uC0B0\uBB3C",
      "bloomberg"
    ]
  },
  {
    key: "gold-silver",
    label: "\uAE08\xB7\uC740",
    keywords: ["gold", "silver", "\uAE08", "\uC740", "\uACE8\uB4DC", "\uC2E4\uBC84"]
  },
  {
    key: "bond",
    label: "\uCC44\uAD8C",
    keywords: [
      "bond",
      "treasury",
      "aggregate",
      "\uCC44\uAD8C",
      "\uAD6D\uCC44",
      "\uD68C\uC0AC\uCC44",
      "\uB9CC\uAE30"
    ]
  }
];
var DYNAMIC_THEMES = [
  { key: "surge", label: "\uAE09\uB4F1\uC8FC" },
  { key: "plunge", label: "\uAE09\uB77D\uC8FC" },
  { key: "large-cap", label: "\uB300\uD615\uC8FC" },
  { key: "mid-small-cap", label: "\uC911\uC18C\uD615\uC8FC" }
];
function inferSector(entry) {
  return SECTOR_MAP[entry.ticker];
}
function matchThemes(entry) {
  const sector = inferSector(entry);
  const name = entry.name.toLowerCase();
  const matched = [];
  for (const def of THEME_DEFS) {
    const bySector = sector != null && def.sectors.includes(sector);
    const byKeyword = def.keywords.some(
      (kw) => name.includes(kw.toLowerCase())
    );
    if (bySector || byKeyword) matched.push(def);
  }
  return matched;
}
function matchEtpKeywordThemes(entry) {
  const name = entry.name.toLowerCase();
  return ETP_KEYWORD_THEMES.filter(
    (t) => t.keywords.some((kw) => name.includes(kw.toLowerCase()))
  );
}
function assetTypeOf(entry) {
  return classifyAssetType(entry.name, entry.market);
}
function toThemeStock(entry, quote5, assetType) {
  return {
    ticker: entry.ticker,
    name: entry.name,
    market: entry.market,
    currency: entry.currency,
    price: quote5?.price ?? 0,
    changePercent: quote5?.changePercent ?? 0,
    marketCap: quote5?.marketCap,
    assetType
  };
}
async function buildThemes(market) {
  return cached(`themes:v4:${market}`, TTL.quote, async () => {
    const entries = CATALOG.filter((e) => e.market === market);
    const live = await Promise.all(
      entries.map(async (entry) => {
        let quote5 = null;
        try {
          quote5 = await MarketDataService.getQuote(entry.ticker);
        } catch {
          quote5 = null;
        }
        return { entry, quote: quote5, assetType: assetTypeOf(entry) };
      })
    );
    const buckets = /* @__PURE__ */ new Map();
    const push = (key, stock) => {
      const list = buckets.get(key) ?? [];
      list.push(stock);
      buckets.set(key, list);
    };
    for (const { entry, quote: quote5, assetType } of live) {
      const stock = toThemeStock(entry, quote5, assetType);
      if (isEtp(assetType)) {
        if (isLeveraged(assetType)) {
          push(ETP_KEYS.leverage, stock);
        } else if (isInverse(assetType)) {
          push(ETP_KEYS.inverse, stock);
        } else if (isEtn(assetType)) {
          push(ETP_KEYS.etn, stock);
        } else {
          push(ETP_KEYS.etf, stock);
        }
        for (const t of matchEtpKeywordThemes(entry)) {
          push(t.key, stock);
        }
        continue;
      }
      for (const theme of matchThemes(entry)) {
        push(theme.key, stock);
      }
      if (quote5 && Number.isFinite(quote5.changePercent)) {
        if (quote5.changePercent >= SURGE_PCT) push("surge", stock);
        if (quote5.changePercent <= PLUNGE_PCT) push("plunge", stock);
      }
      if (quote5 && Number.isFinite(quote5.marketCap) && quote5.marketCap > 0) {
        const capMin = largeCapMin(entry.currency);
        if (quote5.marketCap >= capMin) {
          push("large-cap", stock);
        } else {
          push("mid-small-cap", stock);
        }
      }
    }
    const themeOrder = [
      ...THEME_DEFS.map((t) => ({ key: t.key, label: t.label })),
      ...ETP_KEYWORD_THEMES.map((t) => ({ key: t.key, label: t.label })),
      { key: ETP_KEYS.etf, label: "ETF" },
      { key: ETP_KEYS.etn, label: "ETN" },
      { key: ETP_KEYS.leverage, label: "\uB808\uBC84\uB9AC\uC9C0" },
      { key: ETP_KEYS.inverse, label: "\uC778\uBC84\uC2A4" },
      ...DYNAMIC_THEMES.map((t) => ({
        key: t.key,
        label: t.label,
        dynamic: true
      }))
    ];
    const themes = [];
    for (const { key, label, dynamic } of themeOrder) {
      const list = buckets.get(key) ?? [];
      if (list.length === 0) continue;
      const sorted = [...list];
      if (key === "plunge") {
        sorted.sort((a, b) => a.changePercent - b.changePercent);
      } else if (key === "surge") {
        sorted.sort((a, b) => b.changePercent - a.changePercent);
      } else {
        sorted.sort(
          (a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0) || b.changePercent - a.changePercent
        );
      }
      const limit = dynamic ? DYNAMIC_LIMIT : THEME_STOCK_LIMIT;
      const stocks = sorted.slice(0, limit);
      themes.push({ key, label, count: stocks.length, stocks });
    }
    return { market, themes };
  });
}
var ThemesService = {
  getThemes: buildThemes
};

// src/routes/market.ts
var router2 = Router2();
var FALLBACK_UNIVERSE = [
  { ticker: "005930", name: "\uC0BC\uC131\uC804\uC790", market: "KR", currency: "KRW" },
  { ticker: "000660", name: "SK\uD558\uC774\uB2C9\uC2A4", market: "KR", currency: "KRW" },
  { ticker: "005380", name: "\uD604\uB300\uCC28", market: "KR", currency: "KRW" },
  { ticker: "000270", name: "\uAE30\uC544", market: "KR", currency: "KRW" },
  { ticker: "035420", name: "NAVER", market: "KR", currency: "KRW" },
  { ticker: "035720", name: "\uCE74\uCE74\uC624", market: "KR", currency: "KRW" },
  { ticker: "373220", name: "LG\uC5D0\uB108\uC9C0\uC194\uB8E8\uC158", market: "KR", currency: "KRW" },
  { ticker: "207940", name: "\uC0BC\uC131\uBC14\uC774\uC624\uB85C\uC9C1\uC2A4", market: "KR", currency: "KRW" },
  { ticker: "068270", name: "\uC140\uD2B8\uB9AC\uC628", market: "KR", currency: "KRW" },
  { ticker: "051910", name: "LG\uD654\uD559", market: "KR", currency: "KRW" },
  { ticker: "006400", name: "\uC0BC\uC131SDI", market: "KR", currency: "KRW" },
  { ticker: "005490", name: "POSCO\uD640\uB529\uC2A4", market: "KR", currency: "KRW" },
  { ticker: "003670", name: "\uD3EC\uC2A4\uCF54\uD4E8\uCC98\uC5E0", market: "KR", currency: "KRW" },
  { ticker: "012330", name: "\uD604\uB300\uBAA8\uBE44\uC2A4", market: "KR", currency: "KRW" },
  { ticker: "028260", name: "\uC0BC\uC131\uBB3C\uC0B0", market: "KR", currency: "KRW" },
  { ticker: "055550", name: "\uC2E0\uD55C\uC9C0\uC8FC", market: "KR", currency: "KRW" },
  { ticker: "105560", name: "KB\uAE08\uC735", market: "KR", currency: "KRW" },
  { ticker: "086790", name: "\uD558\uB098\uAE08\uC735\uC9C0\uC8FC", market: "KR", currency: "KRW" },
  { ticker: "316140", name: "\uC6B0\uB9AC\uAE08\uC735\uC9C0\uC8FC", market: "KR", currency: "KRW" },
  { ticker: "066570", name: "LG\uC804\uC790", market: "KR", currency: "KRW" },
  { ticker: "096770", name: "SK\uC774\uB178\uBCA0\uC774\uC158", market: "KR", currency: "KRW" },
  { ticker: "017670", name: "SK\uD154\uB808\uCF64", market: "KR", currency: "KRW" },
  { ticker: "030200", name: "KT", market: "KR", currency: "KRW" },
  { ticker: "032830", name: "\uC0BC\uC131\uC0DD\uBA85", market: "KR", currency: "KRW" },
  { ticker: "000810", name: "\uC0BC\uC131\uD654\uC7AC", market: "KR", currency: "KRW" },
  { ticker: "033780", name: "KT&G", market: "KR", currency: "KRW" },
  { ticker: "015760", name: "\uD55C\uAD6D\uC804\uB825", market: "KR", currency: "KRW" },
  { ticker: "034020", name: "\uB450\uC0B0\uC5D0\uB108\uBE4C\uB9AC\uD2F0", market: "KR", currency: "KRW" },
  { ticker: "010130", name: "\uACE0\uB824\uC544\uC5F0", market: "KR", currency: "KRW" },
  { ticker: "009540", name: "HD\uD55C\uAD6D\uC870\uC120\uD574\uC591", market: "KR", currency: "KRW" },
  { ticker: "010140", name: "\uC0BC\uC131\uC911\uACF5\uC5C5", market: "KR", currency: "KRW" },
  { ticker: "329180", name: "HD\uD604\uB300\uC911\uACF5\uC5C5", market: "KR", currency: "KRW" },
  { ticker: "000720", name: "\uD604\uB300\uAC74\uC124", market: "KR", currency: "KRW" },
  { ticker: "006360", name: "GS\uAC74\uC124", market: "KR", currency: "KRW" },
  { ticker: "047040", name: "\uB300\uC6B0\uAC74\uC124", market: "KR", currency: "KRW" },
  { ticker: "003490", name: "\uB300\uD55C\uD56D\uACF5", market: "KR", currency: "KRW" },
  { ticker: "089590", name: "\uC81C\uC8FC\uD56D\uACF5", market: "KR", currency: "KRW" },
  { ticker: "086520", name: "\uC5D0\uCF54\uD504\uB85C", market: "KR", currency: "KRW" },
  { ticker: "247540", name: "\uC5D0\uCF54\uD504\uB85C\uBE44\uC5E0", market: "KR", currency: "KRW" },
  { ticker: "196170", name: "\uC54C\uD14C\uC624\uC820", market: "KR", currency: "KRW" },
  { ticker: "028300", name: "HLB", market: "KR", currency: "KRW" },
  { ticker: "277810", name: "\uB808\uC778\uBCF4\uC6B0\uB85C\uBCF4\uD2F1\uC2A4", market: "KR", currency: "KRW" },
  { ticker: "042700", name: "\uD55C\uBBF8\uBC18\uB3C4\uCCB4", market: "KR", currency: "KRW" },
  { ticker: "352820", name: "\uD558\uC774\uBE0C", market: "KR", currency: "KRW" },
  { ticker: "259960", name: "\uD06C\uB798\uD504\uD1A4", market: "KR", currency: "KRW" },
  { ticker: "036570", name: "\uC5D4\uC528\uC18C\uD504\uD2B8", market: "KR", currency: "KRW" },
  { ticker: "251270", name: "\uB137\uB9C8\uBE14", market: "KR", currency: "KRW" },
  { ticker: "011200", name: "HMM", market: "KR", currency: "KRW" },
  { ticker: "018260", name: "\uC0BC\uC131\uC5D0\uC2A4\uB514\uC5D0\uC2A4", market: "KR", currency: "KRW" },
  { ticker: "090430", name: "\uC544\uBAA8\uB808\uD37C\uC2DC\uD53D", market: "KR", currency: "KRW" },
  { ticker: "004020", name: "\uD604\uB300\uC81C\uCCA0", market: "KR", currency: "KRW" },
  { ticker: "011070", name: "LG\uC774\uB178\uD14D", market: "KR", currency: "KRW" },
  { ticker: "AAPL", name: "Apple", market: "US", currency: "USD" },
  { ticker: "MSFT", name: "Microsoft", market: "US", currency: "USD" },
  { ticker: "NVDA", name: "NVIDIA", market: "US", currency: "USD" },
  { ticker: "GOOGL", name: "Alphabet A", market: "US", currency: "USD" },
  { ticker: "GOOG", name: "Alphabet C", market: "US", currency: "USD" },
  { ticker: "AMZN", name: "Amazon", market: "US", currency: "USD" },
  { ticker: "META", name: "Meta Platforms", market: "US", currency: "USD" },
  { ticker: "TSLA", name: "Tesla", market: "US", currency: "USD" },
  { ticker: "AVGO", name: "Broadcom", market: "US", currency: "USD" },
  { ticker: "NFLX", name: "Netflix", market: "US", currency: "USD" },
  { ticker: "AMD", name: "AMD", market: "US", currency: "USD" },
  { ticker: "INTC", name: "Intel", market: "US", currency: "USD" },
  { ticker: "PLTR", name: "Palantir", market: "US", currency: "USD" },
  { ticker: "SOFI", name: "SoFi", market: "US", currency: "USD" },
  { ticker: "COIN", name: "Coinbase", market: "US", currency: "USD" },
  { ticker: "UBER", name: "Uber", market: "US", currency: "USD" },
  { ticker: "AAL", name: "American Airlines", market: "US", currency: "USD" },
  { ticker: "DAL", name: "Delta Air Lines", market: "US", currency: "USD" },
  { ticker: "UAL", name: "United Airlines", market: "US", currency: "USD" },
  { ticker: "JPM", name: "JPMorgan Chase", market: "US", currency: "USD" },
  { ticker: "BAC", name: "Bank of America", market: "US", currency: "USD" },
  { ticker: "XOM", name: "Exxon Mobil", market: "US", currency: "USD" },
  { ticker: "CVX", name: "Chevron", market: "US", currency: "USD" },
  { ticker: "LLY", name: "Eli Lilly", market: "US", currency: "USD" },
  { ticker: "UNH", name: "UnitedHealth", market: "US", currency: "USD" },
  { ticker: "WMT", name: "Walmart", market: "US", currency: "USD" },
  { ticker: "COST", name: "Costco", market: "US", currency: "USD" },
  { ticker: "ORCL", name: "Oracle", market: "US", currency: "USD" },
  { ticker: "ADBE", name: "Adobe", market: "US", currency: "USD" },
  { ticker: "CRM", name: "Salesforce", market: "US", currency: "USD" },
  { ticker: "QCOM", name: "Qualcomm", market: "US", currency: "USD" },
  { ticker: "AMAT", name: "Applied Materials", market: "US", currency: "USD" },
  { ticker: "MU", name: "Micron", market: "US", currency: "USD" },
  {
    ticker: "SMCI",
    name: "Super Micro Computer",
    market: "US",
    currency: "USD"
  },
  { ticker: "ARM", name: "Arm Holdings", market: "US", currency: "USD" },
  { ticker: "TSM", name: "TSMC", market: "US", currency: "USD" },
  { ticker: "ASML", name: "ASML", market: "US", currency: "USD" },
  { ticker: "NVO", name: "Novo Nordisk", market: "US", currency: "USD" },
  { ticker: "MRNA", name: "Moderna", market: "US", currency: "USD" },
  { ticker: "PFE", name: "Pfizer", market: "US", currency: "USD" },
  { ticker: "JNJ", name: "Johnson & Johnson", market: "US", currency: "USD" },
  { ticker: "BA", name: "Boeing", market: "US", currency: "USD" },
  { ticker: "DIS", name: "Disney", market: "US", currency: "USD" },
  { ticker: "NKE", name: "Nike", market: "US", currency: "USD" },
  { ticker: "SHOP", name: "Shopify", market: "US", currency: "USD" },
  { ticker: "CRWD", name: "CrowdStrike", market: "US", currency: "USD" },
  { ticker: "SNOW", name: "Snowflake", market: "US", currency: "USD" },
  { ticker: "RGTI", name: "Rigetti Computing", market: "US", currency: "USD" },
  { ticker: "IONQ", name: "IonQ", market: "US", currency: "USD" }
];
function normalizeTicker(value) {
  return String(value ?? "").trim().toUpperCase();
}
function normalizeMarket(value) {
  const raw = String(value ?? "ALL").toUpperCase();
  if (raw === "KR") return "KR";
  if (raw === "US") return "US";
  return "ALL";
}
function uniqueTickers(values) {
  return Array.from(
    new Set(values.map((value) => normalizeTicker(value)).filter(Boolean))
  );
}
function isKrTicker4(ticker) {
  return /^\d{6}$/.test(ticker);
}
function numberFromSeed(ticker, min, max) {
  const seed = [...ticker].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const range = max - min;
  return min + seed % range;
}
function findFallbackStock(ticker) {
  const clean = normalizeTicker(ticker);
  return FALLBACK_UNIVERSE.find((stock) => stock.ticker.toUpperCase() === clean) ?? {
    ticker: clean,
    name: clean,
    market: isKrTicker4(clean) ? "KR" : "US",
    currency: isKrTicker4(clean) ? "KRW" : "USD"
  };
}
function fallbackQuote(stock) {
  const seed = [...stock.ticker].reduce(
    (sum, char) => sum + char.charCodeAt(0),
    0
  );
  const basePrice2 = stock.market === "KR" ? numberFromSeed(stock.ticker, 3500, 3e5) : numberFromSeed(stock.ticker, 20, 900);
  const changePercent = Number(((seed % 1800 - 900) / 100).toFixed(2));
  const price = stock.market === "KR" ? Math.round(basePrice2 / 50) * 50 : Number(basePrice2.toFixed(2));
  const previousClose = price / (1 + changePercent / 100);
  const changeAmount = price - previousClose;
  const volume = numberFromSeed(stock.ticker, 1e5, 9e6);
  const tradingValue = price * volume;
  return {
    ticker: stock.ticker,
    name: stock.name,
    market: stock.market,
    currency: stock.currency,
    assetType: "stock",
    price,
    changeAmount,
    changePercent,
    volume,
    tradingValue,
    open: previousClose,
    high: Math.max(price, previousClose) * 1.02,
    low: Math.min(price, previousClose) * 0.98,
    previousClose,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    rating: {
      score: Math.max(1, Math.min(100, 50 + changePercent * 3)),
      rating: changePercent > 3 ? "BUY" : changePercent < -3 ? "SELL" : "HOLD"
    },
    reason: "\uC784\uC2DC fallback \uC2DC\uC138\uC785\uB2C8\uB2E4."
  };
}
function providerQuoteToRow(providerQuote, stock, provider) {
  const price = Number(
    providerQuote.price ?? providerQuote.currentPrice ?? providerQuote.regularMarketPrice ?? 0
  );
  const previousClose = Number(
    providerQuote.previousClose ?? providerQuote.prevClose ?? price
  );
  const changeAmount = Number(
    providerQuote.changeAmount ?? providerQuote.change ?? price - previousClose
  );
  const changePercent = Number(
    providerQuote.changePercent ?? providerQuote.regularMarketChangePercent ?? (previousClose ? changeAmount / previousClose * 100 : 0)
  );
  const volume = Number(providerQuote.volume ?? 0);
  const tradingValue = Number(providerQuote.tradingValue ?? price * volume);
  return {
    ticker: stock.ticker,
    name: String(providerQuote.name ?? stock.name),
    market: stock.market,
    currency: stock.currency,
    assetType: "stock",
    price,
    changeAmount,
    changePercent,
    volume,
    tradingValue,
    open: Number(providerQuote.open ?? 0),
    high: Number(providerQuote.high ?? 0),
    low: Number(providerQuote.low ?? 0),
    previousClose,
    updatedAt: String(providerQuote.updatedAt ?? (/* @__PURE__ */ new Date()).toISOString()),
    rating: {
      score: Math.max(1, Math.min(100, 50 + changePercent * 3)),
      rating: changePercent > 3 ? "BUY" : changePercent < -3 ? "SELL" : "HOLD"
    },
    reason: provider === "naver" ? "\uB124\uC774\uBC84 \uC2E4\uC2DC\uAC04 \uC2DC\uC138\uC785\uB2C8\uB2E4." : "Yahoo \uC2E4\uC2DC\uAC04 \uC2DC\uC138\uC785\uB2C8\uB2E4."
  };
}
async function getProviderQuote(ticker) {
  const stock = findFallbackStock(ticker);
  try {
    if (stock.market === "KR") {
      const q2 = await getQuote3(stock.ticker);
      if (q2 && Number(q2.price ?? 0) > 0) {
        return providerQuoteToRow(q2, stock, "naver");
      }
    }
    const q = await getQuote2(stock.ticker);
    if (q && Number(q.price ?? 0) > 0) {
      return providerQuoteToRow(q, stock, "yahoo");
    }
  } catch {
  }
  return null;
}
function filterUniverseByMarket(market) {
  if (market === "ALL") return FALLBACK_UNIVERSE;
  return FALLBACK_UNIVERSE.filter((stock) => stock.market === market);
}
function sortByTradingValue(rows) {
  return [...rows].sort(
    (a, b) => (b.tradingValue ?? 0) - (a.tradingValue ?? 0)
  );
}
function sortByVolume(rows) {
  return [...rows].sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));
}
function sortByGainers(rows) {
  return [...rows].sort(
    (a, b) => (b.changePercent ?? 0) - (a.changePercent ?? 0)
  );
}
function sortByLosers(rows) {
  return [...rows].sort(
    (a, b) => (a.changePercent ?? 0) - (b.changePercent ?? 0)
  );
}
function sortByRecommended(rows) {
  return [...rows].sort((a, b) => {
    const bScore = b.rating?.score ?? Math.abs(b.changePercent ?? 0);
    const aScore = a.rating?.score ?? Math.abs(a.changePercent ?? 0);
    return bScore - aScore;
  });
}
async function getRowsForTickers(tickers) {
  const cleanTickers = uniqueTickers(tickers);
  if (cleanTickers.length === 0) return [];
  const rows = await Promise.all(
    cleanTickers.map(async (ticker) => {
      const providerRow = await getProviderQuote(ticker);
      if (providerRow) return providerRow;
      try {
        const serviceRow = await MarketDataService.getQuoteRow(ticker);
        if (serviceRow && Number(serviceRow.price ?? 0) > 0) {
          const suspiciousFallback = serviceRow.price === 3800 || serviceRow.reason?.includes("fallback") || serviceRow.name === serviceRow.ticker;
          if (!suspiciousFallback) return serviceRow;
        }
      } catch {
      }
      return fallbackQuote(findFallbackStock(ticker));
    })
  );
  return rows;
}
async function searchNaverStocks(query) {
  const q = query.trim();
  if (!q) return [];
  try {
    const response = await fetch(
      "https://ac.stock.naver.com/ac?q=" + encodeURIComponent(q) + "&target=stock",
      {
        headers: {
          "User-Agent": "Mozilla/5.0 seungjae-stock-app/1.0",
          Accept: "application/json,text/plain,*/*",
          Referer: "https://finance.naver.com/"
        }
      }
    );
    if (!response.ok) return [];
    const data = await response.json();
    const candidates = Array.isArray(data?.items) ? data.items : Array.isArray(data?.result?.items) ? data.result.items : Array.isArray(data?.stocks) ? data.stocks : [];
    return candidates.map((item) => {
      const ticker = String(
        item.code ?? item.stockCode ?? item.localCode ?? item.symbol ?? ""
      ).replace(/\D/g, "").slice(-6);
      const name = String(
        item.name ?? item.stockName ?? item.koreanName ?? item.label ?? ""
      ).trim();
      const marketText = String(
        item.typeCode ?? item.typeName ?? item.market ?? item.exchange ?? ""
      ).toUpperCase();
      if (!/^\d{6}$/.test(ticker) || !name) return null;
      return {
        ticker,
        name,
        market: "KR",
        currency: "KRW",
        assetType: /ETF/.test(marketText) ? "ETF" : /ETN/.test(marketText) ? "ETN" : "stock",
        exchange: marketText.includes("KOSDAQ") ? "KOSDAQ" : marketText.includes("KONEX") ? "KONEX" : "KOSPI",
        aliases: []
      };
    }).filter(Boolean).slice(0, 80);
  } catch {
    return [];
  }
}
router2.get("/config", (_req, res) => {
  res.json({
    ok: true,
    service: "seungjae-stock-api",
    time: (/* @__PURE__ */ new Date()).toISOString(),
    providers: {
      naver: true,
      yahoo: true,
      quotes: true,
      search: true,
      movers: true
    }
  });
});
router2.get("/search", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  try {
    const results2 = await MarketDataService.search(q, 80);
    if (results2.length > 0) {
      res.json({ q, results: results2 });
      return;
    }
  } catch {
  }
  try {
    const naverResults = await searchNaverStocks(q);
    if (naverResults.length > 0) {
      res.json({ q, results: naverResults });
      return;
    }
  } catch {
  }
  const needle = q.replace(/\s+/g, "").toLowerCase();
  const results = FALLBACK_UNIVERSE.filter((stock) => {
    const target = `${stock.ticker}${stock.name}`.replace(/\s+/g, "").toLowerCase();
    return !needle || target.includes(needle);
  }).map((stock) => ({
    ticker: stock.ticker,
    name: stock.name,
    market: stock.market,
    currency: stock.currency,
    assetType: "stock",
    aliases: []
  }));
  res.json({ q, results });
});
router2.get("/quotes", async (req, res) => {
  const raw = req.query.tickers ?? req.query.symbols ?? req.query.symbol ?? req.query.ticker ?? "";
  const tickers = uniqueTickers(String(raw).split(","));
  const quotes = await getRowsForTickers(tickers);
  res.json({ quotes });
});
router2.get("/market/movers", async (req, res) => {
  const scope = normalizeMarket(req.query.market);
  const universe = filterUniverseByMarket(scope);
  const tickers = universe.map((stock) => stock.ticker);
  const rows = await getRowsForTickers(tickers);
  const popular = sortByTradingValue(rows).slice(0, 30).map((row, index) => ({
    ...row,
    rank: index + 1,
    reason: row.reason ?? "\uAC70\uB798\uB300\uAE08 \uAE30\uC900 \uC0C1\uC704 \uC885\uBAA9\uC785\uB2C8\uB2E4."
  }));
  const volume = sortByVolume(rows).slice(0, 30).map((row, index) => ({
    ...row,
    rank: index + 1,
    reason: row.reason ?? "\uAC70\uB798\uB7C9 \uAE30\uC900 \uC0C1\uC704 \uC885\uBAA9\uC785\uB2C8\uB2E4."
  }));
  const recommended = sortByRecommended(rows).slice(0, 30).map((row, index) => ({
    ...row,
    rank: index + 1,
    reason: row.reason ?? "AI \uC810\uC218 \uAE30\uC900 \uCD94\uCC9C \uC885\uBAA9\uC785\uB2C8\uB2E4."
  }));
  const gainers = sortByGainers(rows).slice(0, 30).map((row, index) => ({
    ...row,
    rank: index + 1,
    reason: row.reason ?? "\uB4F1\uB77D\uB960 \uAE30\uC900 \uAE09\uC0C1\uC2B9 \uC885\uBAA9\uC785\uB2C8\uB2E4."
  }));
  const losers = sortByLosers(rows).slice(0, 30).map((row, index) => ({
    ...row,
    rank: index + 1,
    reason: row.reason ?? "\uB4F1\uB77D\uB960 \uAE30\uC900 \uAE09\uD558\uB77D \uC885\uBAA9\uC785\uB2C8\uB2E4."
  }));
  res.json({
    market: scope,
    popular,
    volume,
    recommended,
    gainers,
    losers,
    risky: losers,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  });
});
router2.get("/market/summary", (_req, res) => {
  res.json({
    ok: true,
    summary: "\uC2DC\uC7A5 \uC694\uC57D \uB370\uC774\uD130\uB294 \uC900\uBE44 \uC911\uC785\uB2C8\uB2E4.",
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  });
});
router2.get("/market/briefing", (_req, res) => {
  res.json({
    ok: true,
    items: [
      {
        sector: "\uBC18\uB3C4\uCCB4",
        title: "\uBC18\uB3C4\uCCB4",
        summary: "AI \uBC18\uB3C4\uCCB4\uC640 \uACE0\uC131\uB2A5 \uBA54\uBAA8\uB9AC \uC218\uC694 \uD750\uB984\uC744 \uD655\uC778\uD569\uB2C8\uB2E4."
      },
      {
        sector: "\uBC14\uC774\uC624",
        title: "\uBC14\uC774\uC624",
        summary: "\uC784\uC0C1\xB7\uC2B9\uC778\xB7\uACC4\uC57D \uB274\uC2A4\uC5D0 \uB530\uB978 \uC885\uBAA9\uBCC4 \uBCC0\uB3D9\uC131\uC744 \uD655\uC778\uD569\uB2C8\uB2E4."
      },
      {
        sector: "\uC790\uB3D9\uCC28",
        title: "\uC790\uB3D9\uCC28",
        summary: "\uC644\uC131\uCC28 \uD310\uB9E4\uC640 \uC804\uAE30\uCC28 \uC804\uD658 \uD750\uB984\uC744 \uD655\uC778\uD569\uB2C8\uB2E4."
      },
      {
        sector: "\uD56D\uACF5",
        title: "\uD56D\uACF5",
        summary: "\uC5EC\uD589 \uC218\uC694\uC640 \uC720\uAC00, \uD658\uC728\uC5D0 \uB530\uB978 \uD56D\uACF5\uC8FC \uD750\uB984\uC744 \uD655\uC778\uD569\uB2C8\uB2E4."
      },
      {
        sector: "\uAC74\uC124",
        title: "\uAC74\uC124",
        summary: "\uBD80\uB3D9\uC0B0 \uC815\uCC45\uACFC \uC218\uC8FC \uD750\uB984\uC744 \uD655\uC778\uD569\uB2C8\uB2E4."
      }
    ],
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  });
});
router2.get("/market/themes", async (req, res) => {
  const market = String(req.query.market ?? "KR").toUpperCase() === "US" ? "US" : "KR";
  try {
    const data = await ThemesService.getThemes(market);
    res.json(data);
  } catch (error) {
    console.error("market themes route error:", error);
    res.status(500).json({
      error: "MARKET_THEMES_ROUTE_ERROR",
      market,
      themes: []
    });
  }
});
router2.get("/market/scan", async (req, res) => {
  const scope = normalizeMarket(req.query.market);
  const rows = await getRowsForTickers(
    filterUniverseByMarket(scope).map((stock) => stock.ticker)
  );
  res.json({
    market: scope,
    results: sortByRecommended(rows).slice(0, 30),
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  });
});
router2.get("/market/alerts", async (req, res) => {
  const scope = normalizeMarket(req.query.market);
  const rows = await getRowsForTickers(
    filterUniverseByMarket(scope).map((stock) => stock.ticker)
  );
  res.json({
    market: scope,
    alerts: sortByGainers(rows).slice(0, 20),
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  });
});
router2.get("/market/undervalued", async (req, res) => {
  const scope = normalizeMarket(req.query.market);
  const rows = await getRowsForTickers(
    filterUniverseByMarket(scope).map((stock) => stock.ticker)
  );
  res.json({
    market: scope,
    results: sortByRecommended(rows).slice(0, 20),
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  });
});
var market_default = router2;

// src/routes/news.route.ts
import { Router as Router3 } from "express";

// src/sample/news.ts
var KR_SOURCES = [
  { name: "\uD55C\uAD6D\uACBD\uC81C", domain: "hankyung.com" },
  { name: "\uB9E4\uC77C\uACBD\uC81C", domain: "mk.co.kr" },
  { name: "\uC5F0\uD569\uC778\uD3EC\uB9E5\uC2A4", domain: "einfomax.co.kr" },
  { name: "\uC11C\uC6B8\uACBD\uC81C", domain: "sedaily.com" },
  { name: "\uC804\uC790\uC2E0\uBB38", domain: "etnews.com" },
  { name: "\uC774\uB370\uC77C\uB9AC", domain: "edaily.co.kr" }
];
var US_SOURCES = [
  { name: "Bloomberg", domain: "bloomberg.com" },
  { name: "Reuters", domain: "reuters.com" },
  { name: "CNBC", domain: "cnbc.com" },
  { name: "MarketWatch", domain: "marketwatch.com" },
  { name: "The Wall Street Journal", domain: "wsj.com" }
];
var POSITIVE = [
  "{n}, \uC2DC\uC7A5 \uC608\uC0C1 \uC0C1\uD68C\uD558\uB294 \uBD84\uAE30 \uC2E4\uC801 \uBC1C\uD45C",
  "{n}, \uC2E0\uC81C\uD488 \uCD9C\uC2DC\uB85C \uB9E4\uCD9C \uC131\uC7A5 \uAE30\uB300\uAC10 \uD655\uB300",
  "\uC99D\uAD8C\uAC00, {n} \uBAA9\uD45C\uC8FC\uAC00 \uC0C1\uD5A5 \uC870\uC815",
  "{n}, \uB300\uADDC\uBAA8 \uC2E0\uADDC \uC218\uC8FC \uACC4\uC57D \uCCB4\uACB0",
  "{n}, \uC790\uC0AC\uC8FC \uB9E4\uC785 \uACB0\uC815\uC73C\uB85C \uC8FC\uC8FC\uAC00\uCE58 \uC81C\uACE0",
  "\uC678\uAD6D\uC778\xB7\uAE30\uAD00, {n} \uB3D9\uBC18 \uC21C\uB9E4\uC218 \uC9C0\uC18D",
  "{n}, \uC2E0\uADDC \uC2DC\uC7A5 \uC9C4\uCD9C\uB85C \uC131\uC7A5 \uB3D9\uB825 \uD655\uBCF4",
  "{n}, \uC601\uC5C5\uC774\uC775\uB960 \uAC1C\uC120\uC138 \uB69C\uB837"
];
var NEGATIVE = [
  "{n}, \uC2DC\uC7A5 \uAE30\uB300 \uBC11\uB3C4\uB294 \uC2E4\uC801\uC5D0 \uD22C\uC790\uC2EC\uB9AC \uC704\uCD95",
  "\uC99D\uAD8C\uAC00, {n} \uD22C\uC790\uC758\uACAC \uD558\uD5A5",
  "{n}, \uACBD\uC7C1 \uC2EC\uD654\uC5D0 \uB530\uB978 \uB9C8\uC9C4 \uC555\uBC15 \uC6B0\uB824",
  "{n}, \uB300\uADDC\uBAA8 \uC720\uC0C1\uC99D\uC790 \uAC80\uD1A0\uC124\uC5D0 \uC8FC\uAC00 \uC57D\uC138",
  "{n}, \uC6D0\uAC00 \uC0C1\uC2B9\uC73C\uB85C \uC218\uC775\uC131 \uBD80\uB2F4 \uD655\uB300",
  "\uC678\uAD6D\uC778, {n} \uB9E4\uB3C4\uC138 \uC9C0\uC18D",
  "{n}, \uADDC\uC81C \uB9AC\uC2A4\uD06C \uBD80\uAC01\uC5D0 \uBCC0\uB3D9\uC131 \uD655\uB300",
  "{n}, \uBD80\uCC44\uBE44\uC728 \uC0C1\uC2B9 \uC6B0\uB824 \uC81C\uAE30"
];
function recentDate(rng, i) {
  const d = new Date(ANCHOR_MS);
  d.setUTCDate(d.getUTCDate() - (i + rangeInt(rng, 0, 2)));
  return d.toISOString().slice(0, 10);
}
function articleUrl(title, market) {
  const q = encodeURIComponent(title);
  return `https://search.naver.com/search.naver?where=news&sm=tab_jum&sort=1&query=${q}`;
}
function getNews(ticker) {
  const entry = getCatalogEntry(ticker);
  if (!entry) return null;
  const rng = seeded(entry.ticker, "news");
  const sources = entry.market === "KR" ? KR_SOURCES : US_SOURCES;
  const q = qualityScore(entry.ticker);
  const posCount = Math.max(2, Math.round(q / 100 * 4) + rangeInt(rng, 1, 2));
  const negCount = Math.max(1, 5 - Math.round(q / 100 * 3));
  const pickUnique = (pool, count, tone) => {
    const items = [];
    const avail = [...pool];
    for (let i = 0; i < count && avail.length > 0; i++) {
      const idx = Math.floor(rng() * avail.length);
      const tpl = avail.splice(idx, 1)[0];
      const title = tpl.replace("{n}", entry.name);
      const src = sources[Math.floor(rng() * sources.length)];
      items.push({
        title,
        source: src.name,
        sourceDomain: src.domain,
        date: recentDate(rng, i),
        url: articleUrl(title, entry.market),
        tone
      });
    }
    return items;
  };
  const positive = pickUnique(POSITIVE, posCount, "positive");
  const negative = pickUnique(NEGATIVE, negCount, "negative");
  const total = positive.length + negative.length;
  const sentimentScore = Math.round((positive.length - negative.length) / total * 100);
  return { positive, negative, sentimentScore };
}

// src/services/news.service.ts
function dateFromUnix(value) {
  if (!value) return (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  return new Date(value * 1e3).toISOString().slice(0, 10);
}
function domainFromUrl(url) {
  if (!url) return "news.google.com";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "news.google.com";
  }
}
var POS_EN = [
  "beat",
  "beats",
  "surge",
  "rise",
  "gain",
  "growth",
  "upgrade",
  "strong",
  "record",
  "profit",
  "buy",
  "jump",
  "soar"
];
var NEG_EN = [
  "miss",
  "fall",
  "drop",
  "loss",
  "lawsuit",
  "probe",
  "downgrade",
  "weak",
  "sell",
  "offering",
  "dilution",
  "plunge",
  "cut"
];
var POS_KO = [
  "\uC0C1\uC2B9",
  "\uAE09\uB4F1",
  "\uD638\uC2E4\uC801",
  "\uCD5C\uB300",
  "\uC218\uC8FC",
  "\uD751\uC790",
  "\uC131\uC7A5",
  "\uB3CC\uD30C",
  "\uC2E0\uACE0\uAC00",
  "\uC0C1\uD5A5",
  "\uB9E4\uC218",
  "\uAC1C\uC120",
  "\uD638\uC7AC",
  "\uAC15\uC138",
  "\uAE30\uB300"
];
var NEG_KO = [
  "\uD558\uB77D",
  "\uAE09\uB77D",
  "\uC801\uC790",
  "\uAC10\uC18C",
  "\uD558\uD5A5",
  "\uC190\uC2E4",
  "\uC6B0\uB824",
  "\uC57D\uC138",
  "\uB9E4\uB3C4",
  "\uC720\uC0C1\uC99D\uC790",
  "\uD6A1\uB839",
  "\uC545\uC7AC",
  "\uBD80\uC9C4",
  "\uB9AC\uC2A4\uD06C",
  "\uACBD\uACE0"
];
function toneFromText(text, kr) {
  const lower = text.toLowerCase();
  const pos = (kr ? POS_KO : POS_EN).filter((w) => lower.includes(w.toLowerCase())).length;
  const neg = (kr ? NEG_KO : NEG_EN).filter((w) => lower.includes(w.toLowerCase())).length;
  return pos >= neg ? "positive" : "negative";
}
function splitNews(items) {
  const positive = items.filter((n) => n.tone === "positive");
  const negative = items.filter((n) => n.tone === "negative");
  const pos = positive.length ? positive : items.slice(0, Math.ceil(items.length / 2));
  const neg = negative.length ? negative : items.slice(Math.ceil(items.length / 2));
  const total = pos.length + neg.length || 1;
  return {
    positive: pos,
    negative: neg,
    sentimentScore: Math.round((pos.length - neg.length) / total * 100)
  };
}
async function usItems(entry) {
  const raw = await getCompanyNews(entry);
  return raw.filter((n) => n.headline && n.url && n.url.startsWith("http")).slice(0, 14).map((n) => {
    const tone = toneFromText(`${n.headline} ${n.summary}`, false);
    return {
      title: n.headline,
      source: n.source || domainFromUrl(n.url),
      sourceDomain: domainFromUrl(n.url),
      date: dateFromUnix(n.datetime),
      url: n.url,
      tone
    };
  });
}
function decodeXml(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, "&").trim();
}
function pick2(block, re) {
  const m = block.match(re);
  return m ? m[1] : "";
}
async function krItems(entry) {
  const query = encodeURIComponent(`${entry.name} \uC8FC\uAC00`);
  const xml = await fetchText2(
    `https://news.google.com/rss/search?q=${query}&hl=ko&gl=KR&ceid=KR:ko`,
    { provider: "google-news", headers: { "User-Agent": "Mozilla/5.0" } }
  );
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null && items.length < 16) {
    const block = m[1];
    const title = decodeXml(pick2(block, /<title>([\s\S]*?)<\/title>/));
    const url = decodeXml(pick2(block, /<link>([\s\S]*?)<\/link>/));
    const pub = pick2(block, /<pubDate>([\s\S]*?)<\/pubDate>/);
    const srcUrl = pick2(block, /<source[^>]*url="([^"]*)"/);
    const srcName = decodeXml(pick2(block, /<source[^>]*>([\s\S]*?)<\/source>/));
    if (!title || !url || !url.startsWith("http")) continue;
    const date = pub ? new Date(pub).toISOString().slice(0, 10) : (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    items.push({
      title,
      source: srcName || domainFromUrl(srcUrl || url),
      sourceDomain: domainFromUrl(srcUrl || url),
      date,
      url,
      tone: toneFromText(title, true)
    });
  }
  return items;
}
async function getNews2(ticker) {
  const entry = getCatalogEntry(ticker);
  if (!entry) return null;
  try {
    const items = entry.market === "KR" ? await krItems(entry) : await usItems(entry);
    const filtered = items.filter((n) => n.url && n.url.startsWith("http"));
    if (filtered.length > 0) {
      return splitNews(filtered);
    }
  } catch (err) {
    console.error(`live news failed for ${ticker}:`, err);
  }
  return getNews(ticker);
}
var NewsService = {
  getNews: getNews2
};

// src/routes/news.route.ts
var router3 = Router3();
router3.get("/news/:ticker", async (req, res) => {
  try {
    const ticker = String(req.params.ticker || "").toUpperCase();
    if (!ticker) {
      return res.status(400).json({ error: "ticker required" });
    }
    const data = await NewsService.getNews(ticker);
    if (!data) {
      return res.status(404).json({ error: "news not found" });
    }
    return res.json(data);
  } catch (error) {
    console.error("news route error:", error);
    return res.status(500).json({ error: "news server error" });
  }
});
var news_route_default = router3;

// src/routes/provider-debug.ts
import fs from "node:fs";
import path from "node:path";
import { Router as Router4 } from "express";
var router4 = Router4();
function normalizeTicker2(value) {
  return String(value ?? "").trim().toUpperCase();
}
function isKrTicker5(ticker) {
  return /^\d{6}$/.test(ticker);
}
function errorToJson(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack?.split("\n").slice(0, 8).join("\n")
    };
  }
  return {
    message: String(error)
  };
}
function safeRead(filePath) {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    return {
      exists: true,
      path: filePath,
      length: text.length,
      hasOldStooqMarker: text.includes("STOOQ_HTTP_"),
      hasNewYahooMarker: text.includes("YAHOO_PROVIDER_MARKER_20260711"),
      hasYahooChartHttpMarker: text.includes("YAHOO_CHART_HTTP_"),
      first300: text.slice(0, 300)
    };
  } catch (error) {
    return {
      exists: false,
      path: filePath,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
async function testOneTicker(ticker) {
  const clean = normalizeTicker2(ticker);
  const result = {
    ticker: clean,
    marketGuess: isKrTicker5(clean) ? "KR" : "US",
    naver: null,
    yahoo: null
  };
  if (isKrTicker5(clean)) {
    try {
      const naverQuote = await getQuote3(clean);
      result.naver = {
        ok: true,
        quote: naverQuote
      };
    } catch (error) {
      result.naver = {
        ok: false,
        error: errorToJson(error)
      };
    }
  } else {
    result.naver = {
      ok: false,
      skipped: "NAVER_ONLY_FOR_KR_TICKER"
    };
  }
  try {
    const yahooQuote = await getQuote2(clean);
    result.yahoo = {
      ok: true,
      quote: yahooQuote
    };
  } catch (error) {
    result.yahoo = {
      ok: false,
      error: errorToJson(error)
    };
  }
  return result;
}
router4.get("/provider", async (req, res) => {
  const raw = String(req.query.tickers ?? req.query.ticker ?? "005930,NVDA");
  const tickers = raw.split(",").map((ticker) => normalizeTicker2(ticker)).filter(Boolean);
  const results = await Promise.all(tickers.map((ticker) => testOneTicker(ticker)));
  res.json({
    ok: true,
    testedAt: (/* @__PURE__ */ new Date()).toISOString(),
    cwd: process.cwd(),
    results
  });
});
router4.get("/source-check", (_req, res) => {
  const cwd = process.cwd();
  const sourceYahooPath = path.resolve(cwd, "src/providers/yahoo.ts");
  const sourceNaverPath = path.resolve(cwd, "src/providers/naver.ts");
  const sourceMarketPath = path.resolve(cwd, "src/routes/market.ts");
  const sourceProviderDebugPath = path.resolve(cwd, "src/routes/provider-debug.ts");
  const sourceIndexPath = path.resolve(cwd, "src/routes/index.ts");
  const distPath = path.resolve(cwd, "dist/index.mjs");
  const packagePath = path.resolve(cwd, "package.json");
  res.json({
    ok: true,
    checkedAt: (/* @__PURE__ */ new Date()).toISOString(),
    cwd,
    files: {
      packageJson: safeRead(packagePath),
      sourceYahoo: safeRead(sourceYahooPath),
      sourceNaver: safeRead(sourceNaverPath),
      sourceMarket: safeRead(sourceMarketPath),
      sourceProviderDebug: safeRead(sourceProviderDebugPath),
      sourceIndex: safeRead(sourceIndexPath),
      distIndex: safeRead(distPath)
    }
  });
});
var provider_debug_default = router4;

// src/routes/push.ts
import { Router as Router5 } from "express";
import webPush from "web-push";
var router5 = Router5();
var subscriptions = /* @__PURE__ */ new Map();
function vapidReady() {
  return Boolean(
    process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT
  );
}
function setupVapid() {
  if (!vapidReady()) return;
  webPush.setVapidDetails(
    process.env.VAPID_SUBJECT,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}
setupVapid();
function getEndpoint(body) {
  if (!body || typeof body !== "object") return null;
  const endpoint = body.endpoint;
  return typeof endpoint === "string" && endpoint.length > 0 ? endpoint : null;
}
router5.post("/push/subscribe", (req, res) => {
  const endpoint = getEndpoint(req.body);
  if (!endpoint) {
    res.status(400).json({ error: "INVALID_SUBSCRIPTION" });
    return;
  }
  subscriptions.set(endpoint, req.body);
  res.json({
    ok: true,
    count: subscriptions.size,
    vapidReady: vapidReady()
  });
});
router5.post("/push/unsubscribe", (req, res) => {
  const endpoint = getEndpoint(req.body);
  if (!endpoint) {
    res.status(400).json({ error: "INVALID_ENDPOINT" });
    return;
  }
  subscriptions.delete(endpoint);
  res.json({
    ok: true,
    count: subscriptions.size
  });
});
router5.post("/push/test", async (req, res) => {
  if (!vapidReady()) {
    res.json({
      ok: false,
      reason: "VAPID \uD0A4 \uBBF8\uC124\uC815"
    });
    return;
  }
  const payload = JSON.stringify({
    title: "\uC2B9\uC7AC\uC8FC\uC2DD \uD14C\uC2A4\uD2B8 \uC54C\uB9BC",
    body: "\uAD00\uC2EC\uC885\uBAA9 \uB274\uC2A4\xB7\uACF5\uC2DC\xB7\uB4F1\uB77D\uB960 \uC54C\uB9BC \uC5F0\uACB0 \uD14C\uC2A4\uD2B8\uC785\uB2C8\uB2E4.",
    url: "/",
    ...typeof req.body === "object" && req.body ? req.body : {}
  });
  const failed = [];
  await Promise.all(
    Array.from(subscriptions.entries()).map(async ([endpoint, sub]) => {
      try {
        await webPush.sendNotification(sub, payload);
      } catch {
        failed.push(endpoint);
      }
    })
  );
  failed.forEach((endpoint) => subscriptions.delete(endpoint));
  res.json({
    ok: true,
    sent: subscriptions.size,
    removed: failed.length
  });
});
var push_default = router5;

// src/routes/stocks.ts
import { Router as Router6 } from "express";
var router6 = Router6();
function normalizeTicker3(value) {
  return String(value ?? "").trim().toUpperCase();
}
function normalizeTimeframe(value) {
  const raw = String(value ?? "1D").trim();
  if (!raw) return "1D";
  return raw;
}
function decodeXml2(value) {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}
function xmlTag(block, tag) {
  const match = block.match(
    new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)<\\/" + tag + ">", "i")
  );
  return match ? decodeXml2(match[1]) : "";
}
function companyNameFromProfile(profile, ticker) {
  return String(
    profile?.name ?? profile?.companyName ?? profile?.corp_name ?? profile?.company?.name ?? ticker
  ).trim();
}
var dartCorpMapCache = null;
async function getDartCorpCode(ticker, apiKey) {
  if (!dartCorpMapCache) {
    const response = await fetch(
      "https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=" + encodeURIComponent(apiKey)
    );
    if (!response.ok) throw new Error("DART_CORP_CODE_HTTP_" + response.status);
    const xml = await response.text();
    const map = /* @__PURE__ */ new Map();
    for (const block of xml.match(/<list>[\s\S]*?<\/list>/g) ?? []) {
      const stockCode = xmlTag(block, "stock_code");
      const corpCode = xmlTag(block, "corp_code");
      if (stockCode && corpCode) map.set(stockCode, corpCode);
    }
    dartCorpMapCache = map;
  }
  return dartCorpMapCache.get(ticker) ?? "";
}
async function fetchDartFilings(ticker) {
  const apiKey = String(process.env.DART_API_KEY ?? "").trim();
  const fallback = {
    title: "DART\uC5D0\uC11C " + ticker + " \uACF5\uC2DC \uC804\uCCB4\uBCF4\uAE30",
    report_nm: "\uACF5\uC2DD \uC804\uC790\uACF5\uC2DC \uAC80\uC0C9",
    date: "\uC2E4\uC2DC\uAC04",
    rcept_dt: "",
    url: "https://dart.fss.or.kr/dsab001/main.do",
    source: "DART"
  };
  if (!apiKey || !/^\d{6}$/.test(ticker)) return [fallback];
  const corpCode = await getDartCorpCode(ticker, apiKey);
  if (!corpCode) return [fallback];
  const from = /* @__PURE__ */ new Date();
  from.setFullYear(from.getFullYear() - 1);
  const bgnDe = from.toISOString().slice(0, 10).replace(/-/g, "");
  const url = "https://opendart.fss.or.kr/api/list.json?crtfc_key=" + encodeURIComponent(apiKey) + "&corp_code=" + encodeURIComponent(corpCode) + "&bgn_de=" + bgnDe + "&last_reprt_at=Y&page_count=100&sort=date&sort_mth=desc";
  const response = await fetch(url);
  if (!response.ok) throw new Error("DART_LIST_HTTP_" + response.status);
  const data = await response.json();
  if (!Array.isArray(data?.list)) return [fallback];
  return data.list.map((item) => ({
    ...item,
    title: item.report_nm,
    date: item.rcept_dt,
    url: item.rcept_no ? "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=" + item.rcept_no : fallback.url,
    source: "DART"
  }));
}
function simpleDartSummary(item) {
  const title = String(item?.title ?? item?.report_nm ?? "").trim();
  if (!title || title.includes("\uACF5\uC2DC \uC804\uCCB4\uBCF4\uAE30") || title.includes("\uACF5\uC2DD \uC804\uC790\uACF5\uC2DC \uAC80\uC0C9")) {
    return "DART\uC5D0\uC11C \uC774 \uC885\uBAA9\uC758 \uC804\uCCB4 \uACF5\uC2DC \uC6D0\uBB38\uC744 \uD655\uC778\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.";
  }
  if (/주주총회|주총/.test(title))
    return "\uC8FC\uC8FC\uCD1D\uD68C \uAC1C\uCD5C \uB610\uB294 \uAD00\uB828 \uC77C\uC815\uC774 \uACF5\uC2DC\uB418\uC5C8\uC2B5\uB2C8\uB2E4.";
  if (/현금.*배당|배당.*결정|배당금/.test(title))
    return "\uC8FC\uC8FC \uBC30\uB2F9\uACFC \uAD00\uB828\uB41C \uB0B4\uC6A9\uC774 \uACF5\uC2DC\uB418\uC5C8\uC2B5\uB2C8\uB2E4.";
  if (/유상증자/.test(title))
    return "\uC720\uC0C1\uC99D\uC790 \uACC4\uD68D \uB610\uB294 \uC9C4\uD589 \uB0B4\uC6A9\uC774 \uACF5\uC2DC\uB418\uC5C8\uC2B5\uB2C8\uB2E4.";
  if (/무상증자/.test(title))
    return "\uBB34\uC0C1\uC99D\uC790 \uACC4\uD68D \uB610\uB294 \uC9C4\uD589 \uB0B4\uC6A9\uC774 \uACF5\uC2DC\uB418\uC5C8\uC2B5\uB2C8\uB2E4.";
  if (/자기주식|자사주/.test(title))
    return "\uC790\uC0AC\uC8FC \uCDE8\uB4DD\xB7\uCC98\uBD84\uACFC \uAD00\uB828\uB41C \uB0B4\uC6A9\uC774 \uACF5\uC2DC\uB418\uC5C8\uC2B5\uB2C8\uB2E4.";
  if (/단일판매|공급계약|수주/.test(title))
    return "\uC2E0\uADDC \uACC4\uC57D \uB610\uB294 \uC218\uC8FC \uAD00\uB828 \uB0B4\uC6A9\uC774 \uACF5\uC2DC\uB418\uC5C8\uC2B5\uB2C8\uB2E4.";
  if (/잠정.*실적|영업.*실적|매출액.*손익/.test(title))
    return "\uCD5C\uADFC \uACBD\uC601\uC2E4\uC801\uACFC \uAD00\uB828\uB41C \uB0B4\uC6A9\uC774 \uACF5\uC2DC\uB418\uC5C8\uC2B5\uB2C8\uB2E4.";
  if (/사업보고서/.test(title))
    return "\uC0AC\uC5C5\uBCF4\uACE0\uC11C\uAC00 \uC81C\uCD9C\uB418\uC5B4 \uD68C\uC0AC\uC758 \uC8FC\uC694 \uC2E4\uC801\uACFC \uD604\uD669\uC744 \uD655\uC778\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.";
  if (/분기보고서/.test(title))
    return "\uBD84\uAE30\uBCF4\uACE0\uC11C\uAC00 \uC81C\uCD9C\uB418\uC5B4 \uCD5C\uADFC \uBD84\uAE30 \uC2E4\uC801\uC744 \uD655\uC778\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.";
  if (/반기보고서/.test(title))
    return "\uBC18\uAE30\uBCF4\uACE0\uC11C\uAC00 \uC81C\uCD9C\uB418\uC5B4 \uC0C1\uBC18\uAE30 \uC2E4\uC801\uC744 \uD655\uC778\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.";
  if (/최대주주/.test(title))
    return "\uCD5C\uB300\uC8FC\uC8FC \uB610\uB294 \uC8FC\uC694 \uC9C0\uBD84 \uBCC0\uB3D9 \uB0B4\uC6A9\uC774 \uACF5\uC2DC\uB418\uC5C8\uC2B5\uB2C8\uB2E4.";
  const shortTitle = title.length > 58 ? title.slice(0, 58) + "\u2026" : title;
  return shortTitle + " \uAD00\uB828 \uACF5\uC2DC\uAC00 \uB4F1\uB85D\uB418\uC5C8\uC2B5\uB2C8\uB2E4.";
}
function simpleNewsSummary(item) {
  const source = String(item?.source ?? "").trim();
  let title = String(item?.title ?? "").replace(/\s+/g, " ").trim();
  const suffix = source ? " - " + source : "";
  if (suffix && title.endsWith(suffix))
    title = title.slice(0, -suffix.length).trim();
  const shortTitle = title.length > 70 ? title.slice(0, 70) + "\u2026" : title;
  return shortTitle ? shortTitle + " \uAD00\uB828 \uC18C\uC2DD\uC785\uB2C8\uB2E4." : "\uCD5C\uADFC \uAD00\uB828 \uB274\uC2A4\uB97C \uD655\uC778\uD588\uC2B5\uB2C8\uB2E4.";
}
async function fetchGoogleNews(ticker) {
  let profile = null;
  try {
    profile = await MarketDataService.getCompanyProfile(ticker);
  } catch {
    profile = null;
  }
  const companyName = companyNameFromProfile(profile, ticker);
  const isKorean = /^\d{6}$/.test(ticker);
  const query = isKorean ? '"' + companyName + '" \uC8FC\uC2DD' : '"' + companyName + '" stock';
  const feedUrl = "https://news.google.com/rss/search?q=" + encodeURIComponent(query) + "&hl=" + (isKorean ? "ko" : "en-US") + "&gl=" + (isKorean ? "KR" : "US") + "&ceid=" + (isKorean ? "KR:ko" : "US:en");
  const response = await fetch(feedUrl, {
    headers: { "User-Agent": "seungjae-stock-app/1.0" }
  });
  if (!response.ok) throw new Error("NEWS_RSS_HTTP_" + response.status);
  const xml = await response.text();
  return (xml.match(/<item>[\s\S]*?<\/item>/g) ?? []).slice(0, 30).map((block) => ({
    title: xmlTag(block, "title"),
    url: xmlTag(block, "link"),
    link: xmlTag(block, "link"),
    publishedAt: xmlTag(block, "pubDate"),
    date: xmlTag(block, "pubDate"),
    source: xmlTag(block, "source") || "Google News"
  })).filter((item) => item.title && item.url);
}
router6.get("/:ticker/quote", async (req, res) => {
  const ticker = normalizeTicker3(req.params.ticker);
  if (!ticker) {
    res.status(400).json({
      error: "MISSING_TICKER"
    });
    return;
  }
  try {
    const quote5 = await MarketDataService.getQuoteRow(ticker);
    if (!quote5) {
      res.status(404).json({
        error: "QUOTE_NOT_FOUND",
        ticker
      });
      return;
    }
    res.json(quote5);
  } catch (error) {
    console.error("stock quote route error:", error);
    res.status(500).json({
      error: "STOCK_QUOTE_ROUTE_ERROR",
      ticker
    });
  }
});
router6.get("/:ticker/profile", async (req, res) => {
  const ticker = normalizeTicker3(req.params.ticker);
  if (!ticker) {
    res.status(400).json({
      error: "MISSING_TICKER"
    });
    return;
  }
  try {
    const profile = await MarketDataService.getCompanyProfile(ticker);
    res.json(profile);
  } catch (error) {
    console.error("stock profile route error:", error);
    res.status(500).json({
      error: "STOCK_PROFILE_ROUTE_ERROR",
      ticker
    });
  }
});
router6.get("/:ticker/company", async (req, res) => {
  const ticker = normalizeTicker3(req.params.ticker);
  if (!ticker) {
    res.status(400).json({
      error: "MISSING_TICKER"
    });
    return;
  }
  try {
    const profile = await MarketDataService.getCompanyProfile(ticker);
    res.json(profile);
  } catch (error) {
    console.error("stock company route error:", error);
    res.status(500).json({
      error: "STOCK_COMPANY_ROUTE_ERROR",
      ticker
    });
  }
});
router6.get("/:ticker/candles", async (req, res) => {
  const ticker = normalizeTicker3(req.params.ticker);
  const timeframe = normalizeTimeframe(req.query.tf ?? req.query.timeframe);
  if (!ticker) {
    res.status(400).json({
      error: "MISSING_TICKER"
    });
    return;
  }
  try {
    const candles5 = await MarketDataService.getCandles(
      ticker,
      timeframe
    );
    res.json({
      ticker,
      timeframe,
      candles: candles5
    });
  } catch (error) {
    console.error("stock candles route error:", error);
    res.status(500).json({
      error: "STOCK_CANDLES_ROUTE_ERROR",
      ticker,
      timeframe
    });
  }
});
router6.get("/:ticker/rating", async (req, res) => {
  const ticker = normalizeTicker3(req.params.ticker);
  if (!ticker) {
    res.status(400).json({
      error: "MISSING_TICKER"
    });
    return;
  }
  try {
    const rating = await MarketDataService.getRating(ticker);
    res.json({
      ticker,
      rating
    });
  } catch (error) {
    console.error("stock rating route error:", error);
    res.status(500).json({
      error: "STOCK_RATING_ROUTE_ERROR",
      ticker
    });
  }
});
router6.get("/:ticker/financials", async (req, res) => {
  const ticker = normalizeTicker3(req.params.ticker);
  res.json({
    ticker,
    items: [],
    summary: "\uC7AC\uBB34\uC81C\uD45C \uB370\uC774\uD130\uB294 \uC5F0\uACB0 \uC900\uBE44 \uC911\uC785\uB2C8\uB2E4."
  });
});
router6.get("/:ticker/risk", async (req, res) => {
  const ticker = normalizeTicker3(req.params.ticker);
  res.json({
    ticker,
    delistingRisk: false,
    riskLevel: "normal",
    summary: "\uD604\uC7AC \uD655\uC778\uB41C \uC0C1\uC7A5\uD3D0\uC9C0 \uACE0\uC704\uD5D8 \uC2E0\uD638\uB294 \uC5C6\uC2B5\uB2C8\uB2E4."
  });
});
router6.get("/:ticker/filings", async (req, res) => {
  const ticker = normalizeTicker3(req.params.ticker);
  try {
    const items = await fetchDartFilings(ticker);
    res.json({
      ticker,
      filings: items,
      items,
      summary: simpleDartSummary(items[0]) + (items.length > 1 ? " \uCD5C\uADFC 1\uB144 \uACF5\uC2DC " + items.length + "\uAC74\uC744 \uBD88\uB7EC\uC654\uC2B5\uB2C8\uB2E4." : "")
    });
  } catch (error) {
    console.error("stock filings route error:", error);
    const items = await fetchDartFilings("").catch(() => []);
    res.json({
      ticker,
      filings: items,
      items,
      summary: "DART \uC5F0\uACB0\uC744 \uD655\uC778\uD574 \uC8FC\uC138\uC694."
    });
  }
});
router6.get("/:ticker/disclosures", async (req, res) => {
  const ticker = normalizeTicker3(req.params.ticker);
  try {
    const items = await fetchDartFilings(ticker);
    res.json({
      ticker,
      disclosures: items,
      items,
      summary: simpleDartSummary(items[0])
    });
  } catch (error) {
    console.error("stock disclosures route error:", error);
    res.json({
      ticker,
      disclosures: [],
      items: [],
      summary: "DART \uC5F0\uACB0\uC744 \uD655\uC778\uD574 \uC8FC\uC138\uC694."
    });
  }
});
router6.get("/:ticker/news", async (req, res) => {
  const ticker = normalizeTicker3(req.params.ticker);
  try {
    const items = await fetchGoogleNews(ticker);
    res.json({
      ticker,
      news: items,
      items,
      summary: items.length ? simpleNewsSummary(items[0]) : "\uCD5C\uADFC \uAD00\uB828 \uB274\uC2A4\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4."
    });
  } catch (error) {
    console.error("stock news route error:", error);
    res.status(502).json({
      ticker,
      news: [],
      items: [],
      summary: "\uB274\uC2A4 \uC81C\uACF5\uCC98 \uC5F0\uACB0\uC774 \uC7A0\uC2DC \uC9C0\uC5F0\uB418\uACE0 \uC788\uC2B5\uB2C8\uB2E4."
    });
  }
});
function cleanFinanceCell(value) {
  return value.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}
function financeNumber(value) {
  if (!value) return 0;
  const normalized = value.replace(/,/g, "").replace(/%/g, "").replace(/[^0-9+\-.]/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}
function financeTableRows(html) {
  return [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(
    (row) => [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(
      (cell) => cleanFinanceCell(cell[1])
    )
  ).filter((cells) => cells.length > 0);
}
function groupInvestorRows(rows, period) {
  const size = period === "weekly" ? 5 : period === "monthly" ? 20 : period === "yearly" ? 240 : 1;
  if (size === 1) return rows.slice(0, 30);
  const grouped = [];
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    if (!chunk.length) continue;
    grouped.push({
      date: chunk[0].date,
      individual: chunk.reduce((sum, row) => sum + row.individual, 0),
      institution: chunk.reduce((sum, row) => sum + row.institution, 0),
      foreign: chunk.reduce((sum, row) => sum + row.foreign, 0)
    });
  }
  return grouped.slice(0, 30);
}
router6.get("/:ticker/market-flow", async (req, res) => {
  const ticker = normalizeTicker3(req.params.ticker);
  const period = String(req.query.period ?? "daily");
  if (!/^\d{6}$/.test(ticker)) {
    return res.json({
      ticker,
      period,
      available: false,
      rows: [],
      totals: { individual: 0, institution: 0, foreign: 0 },
      message: "\uD574\uC678 \uC885\uBAA9\uC758 \uD22C\uC790\uC790\uBCC4 \uC218\uAE09\uC740 \uD604\uC7AC \uC81C\uACF5\uCC98\uC5D0\uC11C \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4."
    });
  }
  try {
    const response = await fetch(
      `https://finance.naver.com/item/frgn.naver?code=${ticker}&page=1`,
      {
        headers: {
          "User-Agent": "Mozilla/5.0",
          Referer: "https://finance.naver.com/"
        }
      }
    );
    const html = await response.text();
    const dailyRows = financeTableRows(html).filter(
      (cells) => /^\d{4}\.\d{2}\.\d{2}$/.test(cells[0] ?? "") && cells.length >= 7
    ).map((cells) => {
      const institution = financeNumber(cells[5]);
      const foreign = financeNumber(cells[6]);
      return {
        date: cells[0],
        individual: -(institution + foreign),
        institution,
        foreign
      };
    });
    const rows = groupInvestorRows(dailyRows, period);
    const totals = rows.reduce(
      (acc, row) => ({
        individual: acc.individual + row.individual,
        institution: acc.institution + row.institution,
        foreign: acc.foreign + row.foreign
      }),
      { individual: 0, institution: 0, foreign: 0 }
    );
    res.json({
      ticker,
      period,
      available: rows.length > 0,
      rows,
      totals,
      note: "\uAC1C\uC778\uC740 \uAE30\uAD00\xB7\uC678\uAD6D\uC778 \uC21C\uB9E4\uB9E4\uC758 \uBC18\uB300\uAC12\uC73C\uB85C \uCD94\uC815\uD55C \uCC38\uACE0\uCE58\uC785\uB2C8\uB2E4."
    });
  } catch (error) {
    console.error("investor flow route error:", error);
    res.json({
      ticker,
      period,
      available: false,
      rows: [],
      totals: { individual: 0, institution: 0, foreign: 0 },
      message: "\uD22C\uC790\uC790\uBCC4 \uC218\uAE09 \uB370\uC774\uD130\uB97C \uBD88\uB7EC\uC624\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4."
    });
  }
});
router6.get("/:ticker/short-selling", async (req, res) => {
  const ticker = normalizeTicker3(req.params.ticker);
  if (!/^\d{6}$/.test(ticker)) {
    return res.json({
      ticker,
      available: false,
      rows: [],
      latest: null,
      message: "\uD574\uC678 \uACF5\uB9E4\uB3C4 \uB370\uC774\uD130\uB294 \uBCC4\uB3C4 \uC81C\uACF5\uCC98 \uC5F0\uB3D9\uC774 \uD544\uC694\uD569\uB2C8\uB2E4."
    });
  }
  try {
    const headers = {
      "User-Agent": "Mozilla/5.0",
      Referer: "https://finance.naver.com/"
    };
    const [tradeResponse, balanceResponse] = await Promise.all([
      fetch(`https://finance.naver.com/item/short_trade.naver?code=${ticker}`, {
        headers
      }),
      fetch(
        `https://finance.naver.com/item/short_balance.naver?code=${ticker}`,
        { headers }
      )
    ]);
    const [tradeHtml, balanceHtml] = await Promise.all([
      tradeResponse.text(),
      balanceResponse.text()
    ]);
    const tradeRows = financeTableRows(tradeHtml).filter(
      (cells) => /^\d{4}\.\d{2}\.\d{2}$/.test(cells[0] ?? "") && cells.length >= 6
    ).map((cells) => ({
      date: cells[0],
      shortVolume: financeNumber(cells[cells.length - 2]),
      ratio: financeNumber(cells[cells.length - 1])
    }));
    const balanceMap = new Map(
      financeTableRows(balanceHtml).filter(
        (cells) => /^\d{4}\.\d{2}\.\d{2}$/.test(cells[0] ?? "") && cells.length >= 6
      ).map((cells) => [
        cells[0],
        {
          balance: financeNumber(cells[cells.length - 4]),
          balanceAmount: financeNumber(cells[cells.length - 3]),
          balanceRatio: financeNumber(cells[cells.length - 1])
        }
      ])
    );
    const rows = tradeRows.slice(0, 30).map((row) => ({ ...row, ...balanceMap.get(row.date) ?? {} }));
    const latestBalance = [...balanceMap.values()][0] ?? {};
    const latest = rows.length ? { ...rows[0], ...latestBalance, borrowRate: null } : null;
    res.json({
      ticker,
      available: rows.length > 0,
      rows,
      latest,
      note: "\uB300\uCC28 \uC774\uC790\uC728\uC740 \uD604\uC7AC \uC81C\uACF5\uCC98\uAC00 \uACF5\uAC1C\uD558\uC9C0 \uC54A\uC544 \uBBF8\uC81C\uACF5\uC73C\uB85C \uD45C\uC2DC\uB429\uB2C8\uB2E4."
    });
  } catch (error) {
    console.error("short selling route error:", error);
    res.json({
      ticker,
      available: false,
      rows: [],
      latest: null,
      message: "\uACF5\uB9E4\uB3C4 \uB370\uC774\uD130\uB97C \uBD88\uB7EC\uC624\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4."
    });
  }
});
var stocks_default = router6;

// src/routes/watchlist.ts
import { Router as Router7 } from "express";

// src/services/watchlist.service.ts
var TABLE = "watchlist_items";
function toRecord(row) {
  const target = row.target_price === null || row.target_price === void 0 ? null : Number(row.target_price);
  return {
    ticker: row.ticker,
    name: row.name ?? row.ticker,
    market: row.market,
    currency: row.currency,
    targetPrice: Number.isFinite(target) ? target : null,
    updatedAt: row.updated_at
  };
}
function normalize(deviceId, item) {
  return {
    device_id: deviceId,
    ticker: item.ticker.toUpperCase(),
    name: item.name ?? item.ticker.toUpperCase(),
    market: item.market ?? null,
    currency: item.currency ?? null,
    target_price: typeof item.targetPrice === "number" && Number.isFinite(item.targetPrice) ? item.targetPrice : null,
    updated_at: (/* @__PURE__ */ new Date()).toISOString()
  };
}
var WatchlistService = {
  isAvailable() {
    return hasSupabaseServerKey();
  },
  async list(deviceId) {
    const { data, error } = await getSupabase().from(TABLE).select("ticker,name,market,currency,target_price,updated_at").eq("device_id", deviceId).order("created_at", { ascending: true });
    if (error) throw new Error(`supabase list failed: ${error.message}`);
    return data.map(toRecord);
  },
  async upsert(deviceId, item) {
    const { error } = await getSupabase().from(TABLE).upsert(normalize(deviceId, item), { onConflict: "device_id,ticker" });
    if (error) throw new Error(`supabase upsert failed: ${error.message}`);
  },
  async remove(deviceId, ticker) {
    const { error } = await getSupabase().from(TABLE).delete().eq("device_id", deviceId).eq("ticker", ticker.toUpperCase());
    if (error) throw new Error(`supabase delete failed: ${error.message}`);
  },
  // Replace the device's whole set: upsert everything in `items`, delete rows
  // that are no longer present. Returns the canonical server list.
  async syncReplace(deviceId, items) {
    const supabase = getSupabase();
    const keep = items.map((item) => item.ticker.toUpperCase());
    if (items.length > 0) {
      const { error } = await supabase.from(TABLE).upsert(items.map((item) => normalize(deviceId, item)), {
        onConflict: "device_id,ticker"
      });
      if (error) throw new Error(`supabase sync upsert failed: ${error.message}`);
    }
    const del = supabase.from(TABLE).delete().eq("device_id", deviceId);
    const { error: delError } = keep.length > 0 ? await del.not("ticker", "in", `(${keep.map((t) => `"${t}"`).join(",")})`) : await del;
    if (delError) throw new Error(`supabase sync delete failed: ${delError.message}`);
    return this.list(deviceId);
  }
};

// src/routes/watchlist.ts
var router7 = Router7();
function deviceIdOf(value) {
  const id = typeof value === "string" ? value.trim() : "";
  return id.length > 0 && id.length <= 128 ? id : "default";
}
function guard(res) {
  if (WatchlistService.isAvailable()) return true;
  res.status(503).json({ error: "SUPABASE_NOT_CONFIGURED" });
  return false;
}
function parseItem(body) {
  if (!body || typeof body !== "object") return null;
  const raw = body;
  if (typeof raw.ticker !== "string" || raw.ticker.trim() === "") return null;
  const targetPrice = typeof raw.targetPrice === "number" && Number.isFinite(raw.targetPrice) && raw.targetPrice > 0 ? raw.targetPrice : null;
  return {
    ticker: raw.ticker.trim(),
    name: typeof raw.name === "string" ? raw.name : void 0,
    market: typeof raw.market === "string" ? raw.market : null,
    currency: typeof raw.currency === "string" ? raw.currency : null,
    targetPrice
  };
}
router7.get("/watchlist", async (req, res) => {
  if (!guard(res)) return;
  try {
    const items = await WatchlistService.list(deviceIdOf(req.query.deviceId));
    return res.json({ items });
  } catch (error) {
    console.error("[watchlist] list error:", error);
    return res.status(502).json({ error: "WATCHLIST_STORE_ERROR" });
  }
});
router7.post("/watchlist/sync", async (req, res) => {
  if (!guard(res)) return;
  const body = req.body ?? {};
  const rawItems = Array.isArray(body.items) ? body.items : null;
  if (!rawItems) return res.status(400).json({ error: "INVALID_ITEMS" });
  const items = rawItems.map((item) => parseItem(item)).filter((item) => item !== null);
  try {
    const saved = await WatchlistService.syncReplace(
      deviceIdOf(body.deviceId),
      items
    );
    return res.json({ items: saved });
  } catch (error) {
    console.error("[watchlist] sync error:", error);
    return res.status(502).json({ error: "WATCHLIST_STORE_ERROR" });
  }
});
router7.put("/watchlist/:ticker", async (req, res) => {
  if (!guard(res)) return;
  const body = req.body ?? {};
  const item = parseItem({ ...body, ticker: req.params.ticker });
  if (!item) return res.status(400).json({ error: "INVALID_ITEM" });
  try {
    await WatchlistService.upsert(deviceIdOf(body.deviceId), item);
    return res.json({ ok: true });
  } catch (error) {
    console.error("[watchlist] upsert error:", error);
    return res.status(502).json({ error: "WATCHLIST_STORE_ERROR" });
  }
});
router7.delete("/watchlist/:ticker", async (req, res) => {
  if (!guard(res)) return;
  try {
    await WatchlistService.remove(
      deviceIdOf(req.query.deviceId),
      req.params.ticker
    );
    return res.json({ ok: true });
  } catch (error) {
    console.error("[watchlist] delete error:", error);
    return res.status(502).json({ error: "WATCHLIST_STORE_ERROR" });
  }
});
var watchlist_default = router7;

// src/routes/kiwoom.routes.ts
import {
  Router as Router8
} from "express";

// src/providers/kiwoom.ts
var REAL_BASE_URL = "https://api.kiwoom.com";
var MOCK_BASE_URL = "https://mockapi.kiwoom.com";
var REQUEST_TIMEOUT_MS = 15e3;
var UINT32_MAX = 4294967295;
var INT32_MAX = 2147483647;
var tokenCache = null;
function baseUrl() {
  return process.env.KIWOOM_MODE?.trim().toLowerCase() === "mock" ? MOCK_BASE_URL : REAL_BASE_URL;
}
function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} \uD658\uACBD\uBCC0\uC218\uAC00 \uB4F1\uB85D\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4.`
    );
  }
  return value;
}
function toNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.replace(/[,+%₩$]/g, "").trim();
  if (!normalized) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}
function absoluteNumber(value) {
  const parsed = toNumber(value);
  return parsed == null ? null : Math.abs(parsed);
}
function normalizeVolume(value) {
  const parsed = absoluteNumber(value);
  if (parsed == null) {
    return {
      value: null,
      warning: null
    };
  }
  if (parsed === UINT32_MAX) {
    return {
      value: null,
      warning: "\uD0A4\uC6C0 \uC751\uB2F5 \uAC70\uB798\uB7C9\uC774 UINT32 \uCD5C\uB300\uAC12(4,294,967,295)\uC73C\uB85C \uBC18\uD658\uB418\uC5B4 \uC720\uD6A8\uD558\uC9C0 \uC54A\uC740 \uAC12\uC73C\uB85C \uCC98\uB9AC\uD588\uC2B5\uB2C8\uB2E4."
    };
  }
  if (parsed === INT32_MAX) {
    return {
      value: null,
      warning: "\uD0A4\uC6C0 \uC751\uB2F5 \uAC70\uB798\uB7C9\uC774 INT32 \uCD5C\uB300\uAC12(2,147,483,647)\uC73C\uB85C \uBC18\uD658\uB418\uC5B4 \uC720\uD6A8\uD558\uC9C0 \uC54A\uC740 \uAC12\uC73C\uB85C \uCC98\uB9AC\uD588\uC2B5\uB2C8\uB2E4."
    };
  }
  if (!Number.isSafeInteger(parsed)) {
    return {
      value: null,
      warning: "\uAC70\uB798\uB7C9\uC774 JavaScript \uC548\uC804 \uC815\uC218 \uBC94\uC704\uB97C \uBC97\uC5B4\uB098 \uC720\uD6A8\uD558\uC9C0 \uC54A\uC740 \uAC12\uC73C\uB85C \uCC98\uB9AC\uD588\uC2B5\uB2C8\uB2E4."
    };
  }
  return {
    value: parsed,
    warning: null
  };
}
async function readJson(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `\uD0A4\uC6C0 API\uAC00 JSON\uC774 \uC544\uB2CC \uC751\uB2F5\uC744 \uBC18\uD658\uD588\uC2B5\uB2C8\uB2E4. HTTP ${response.status}: ${text.slice(0, 240)}`
    );
  }
}
function returnCode(data) {
  const raw = data.return_code;
  if (raw == null || raw === "") {
    return 0;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : -1;
}
function returnMessage(data) {
  return typeof data.return_msg === "string" && data.return_msg.trim() ? data.return_msg : "\uC54C \uC218 \uC5C6\uB294 \uD0A4\uC6C0 API \uC624\uB958";
}
function clearKiwoomTokenCache() {
  tokenCache = null;
}
function getKiwoomStatus() {
  return {
    provider: "kiwoom",
    mode: process.env.KIWOOM_MODE?.trim().toLowerCase() === "mock" ? "mock" : "real",
    baseUrl: baseUrl(),
    appKeyRegistered: Boolean(
      process.env.KIWOOM_APP_KEY?.trim()
    ),
    appSecretRegistered: Boolean(
      process.env.KIWOOM_APP_SECRET?.trim()
    ),
    tokenCached: Boolean(
      tokenCache && Date.now() < tokenCache.expiresAt - 6e4
    )
  };
}
async function getKiwoomToken() {
  if (tokenCache && Date.now() < tokenCache.expiresAt - 5 * 60 * 1e3) {
    return tokenCache.token;
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );
  try {
    const response = await fetch(
      `${baseUrl()}/oauth2/token`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json;charset=UTF-8"
        },
        body: JSON.stringify({
          grant_type: "client_credentials",
          appkey: requireEnv("KIWOOM_APP_KEY"),
          secretkey: requireEnv(
            "KIWOOM_APP_SECRET"
          )
        }),
        signal: controller.signal
      }
    );
    const result = await readJson(
      response
    );
    if (!response.ok || returnCode(result) !== 0 || !result.token) {
      throw new Error(
        `\uD0A4\uC6C0 \uD1A0\uD070 \uBC1C\uAE09 \uC2E4\uD328: ${returnMessage(result)} (HTTP ${response.status})`
      );
    }
    tokenCache = {
      token: result.token,
      expiresAt: Date.now() + 23 * 60 * 60 * 1e3
    };
    return result.token;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        "\uD0A4\uC6C0 \uD1A0\uD070 \uC694\uCCAD \uC2DC\uAC04\uC774 \uCD08\uACFC\uB418\uC5C8\uC2B5\uB2C8\uB2E4."
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
async function kiwoomRequest({
  apiId,
  path: path3,
  body,
  contYn,
  nextKey
}) {
  const token = await getKiwoomToken();
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json;charset=UTF-8",
    authorization: `Bearer ${token}`,
    "api-id": apiId
  };
  if (contYn) {
    headers["cont-yn"] = contYn;
  }
  if (nextKey) {
    headers["next-key"] = nextKey;
  }
  try {
    const response = await fetch(
      `${baseUrl()}${path3}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      }
    );
    const result = await readJson(response);
    if (!response.ok || returnCode(result) !== 0) {
      if (response.status === 401 || response.status === 403) {
        clearKiwoomTokenCache();
      }
      throw new Error(
        `\uD0A4\uC6C0 ${apiId} \uC694\uCCAD \uC2E4\uD328: ${returnMessage(result)} (HTTP ${response.status})`
      );
    }
    return {
      data: result,
      contYn: response.headers.get("cont-yn"),
      nextKey: response.headers.get("next-key")
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        `\uD0A4\uC6C0 ${apiId} \uC694\uCCAD \uC2DC\uAC04\uC774 \uCD08\uACFC\uB418\uC5C8\uC2B5\uB2C8\uB2E4.`
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
async function getKiwoomDomesticOrderbook(ticker) {
  const normalizedTicker = ticker.trim().toUpperCase();
  if (!/^[0-9A-Z]{6}(?:_(?:NX|AL))?$/.test(
    normalizedTicker
  )) {
    throw new Error(
      `\uC798\uBABB\uB41C \uAD6D\uB0B4 \uC885\uBAA9\uCF54\uB4DC\uC785\uB2C8\uB2E4: ${normalizedTicker}`
    );
  }
  const result = await kiwoomRequest({
    apiId: "ka10004",
    path: "/api/dostk/mrkcond",
    body: {
      stk_cd: normalizedTicker
    }
  });
  return result.data;
}
function domesticRankingRequest(type) {
  const common = {
    mrkt_tp: "000",
    mang_stk_incls: "0",
    stex_tp: "1"
  };
  if (type === "volume") {
    return {
      apiId: "ka10030",
      path: "/api/dostk/rkinfo",
      body: {
        ...common,
        sort_tp: "1",
        crd_tp: "0",
        trde_qty_tp: "0",
        pric_tp: "0",
        trde_prica_tp: "0",
        mrkt_open_tp: "0"
      }
    };
  }
  if (type === "tradingValue") {
    return {
      apiId: "ka10032",
      path: "/api/dostk/rkinfo",
      body: common
    };
  }
  return {
    apiId: "ka10027",
    path: "/api/dostk/rkinfo",
    body: {
      ...common,
      sort_tp: type === "losers" ? "3" : "1",
      trde_qty_cnd: "0000",
      stk_cnd: "0",
      crd_cnd: "0",
      updown_incls: "1",
      pric_cnd: "0",
      trde_prica_cnd: "0"
    }
  };
}
function usRankingRequests(type) {
  if (type === "volume") {
    return [
      {
        apiId: "usa20530",
        path: "/api/us/rkinfo",
        body: {
          excd: "000",
          item_tp: "1",
          sort_tp: "1"
        }
      }
    ];
  }
  if (type === "tradingValue") {
    return [
      {
        apiId: "usa20540",
        path: "/api/us/rkinfo",
        body: {
          excd: "000",
          item_tp: "1",
          sort_tp: "1"
        }
      }
    ];
  }
  if (type === "gainers") {
    return [
      {
        apiId: "usa20910",
        path: "/api/us/rkinfo",
        body: {
          excd: "000",
          item_tp: "1",
          sort_tp: "1"
        }
      }
    ];
  }
  return [
    {
      apiId: "usa20910",
      path: "/api/us/rkinfo",
      body: {
        excd: "000",
        item_tp: "1",
        sort_tp: "4"
      }
    },
    {
      apiId: "usa20910",
      path: "/api/us/rkinfo",
      body: {
        excd: "000",
        item_tp: "1",
        sort_tp: "5"
      }
    },
    {
      apiId: "usa20910",
      path: "/api/us/rkinfo",
      body: {
        excd: "000",
        item_tp: "1",
        sort_tp: "2"
      }
    }
  ];
}
function objectRows(value, depth = 0) {
  if (depth > 4) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.filter(
      (item) => Boolean(item) && typeof item === "object" && !Array.isArray(item)
    );
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  const entries = Object.entries(
    value
  );
  const directArrays = entries.filter(
    ([, nested]) => Array.isArray(nested)
  ).sort(
    (a, b) => b[1].length - a[1].length
  );
  for (const [, nested] of directArrays) {
    const rows = objectRows(
      nested,
      depth + 1
    );
    if (rows.length > 0) {
      return rows;
    }
  }
  for (const [, nested] of entries) {
    const rows = objectRows(
      nested,
      depth + 1
    );
    if (rows.length > 0) {
      return rows;
    }
  }
  return [];
}
function rankingRows(data) {
  const resultList = data.result_list;
  if (Array.isArray(resultList)) {
    const rows = objectRows(resultList);
    if (rows.length > 0) {
      return rows;
    }
  }
  return objectRows(data);
}
function pick3(row, keys) {
  for (const key of keys) {
    if (row[key] != null && row[key] !== "") {
      return row[key];
    }
  }
  return void 0;
}
function pickEntry(row, keys) {
  for (const key of keys) {
    if (row[key] != null && row[key] !== "") {
      return {
        key,
        value: row[key]
      };
    }
  }
  return null;
}
function normalizeTradingValue(row, market) {
  const entry = pickEntry(row, [
    "trde_amt",
    "trde_prica",
    "trading_value",
    "acml_tr_pbmn",
    "acml_trading_value",
    "acc_trde_prica",
    "amount",
    "trade_amount",
    "trd_amt",
    "turnover"
  ]);
  if (!entry) {
    return null;
  }
  const parsed = absoluteNumber(entry.value);
  if (parsed == null) {
    return null;
  }
  if (market === "KR" && (entry.key === "trde_amt" || entry.key === "trde_prica")) {
    return parsed * 1e6;
  }
  if (market === "US" && (entry.key === "trde_prica" || entry.key === "acc_trde_prica")) {
    return parsed * 1e3;
  }
  return parsed;
}
function containsAny(text, keywords) {
  return keywords.some(
    (keyword) => text.includes(keyword)
  );
}
function classifyKiwoomInstrument(name, market) {
  const normalizedName = name.replace(/\s+/g, " ").trim();
  const upperName = normalizedName.toUpperCase();
  const compactName = upperName.replace(/\s+/g, "");
  const isEtn2 = /\bETN\b/i.test(upperName) || containsAny(compactName, [
    "\uC0C1\uC7A5\uC9C0\uC218\uC99D\uAD8C",
    "\uB808\uBC84\uB9AC\uC9C0ETN",
    "\uC778\uBC84\uC2A4ETN"
  ]);
  const koreanEtfBrand = /^(KODEX|TIGER|RISE|ACE|SOL|PLUS|HANARO|KOSEF|ARIRANG|TIMEFOLIO|WOORI|FOCUS|KIWOOM|KBSTAR|1Q|BNK|히어로즈|마이티)(\s|$)/i.test(
    normalizedName
  );
  const overseasEtfName = /\bETF\b/i.test(upperName) || /\bEXCHANGE TRADED FUND\b/i.test(
    upperName
  );
  const isEtf = !isEtn2 && (koreanEtfBrand || overseasEtfName || containsAny(compactName, [
    "\uC0C1\uC7A5\uC9C0\uC218\uD380\uB4DC",
    "\uB2E8\uC77C\uC885\uBAA9\uB808\uBC84\uB9AC\uC9C0",
    "\uC120\uBB3C\uC778\uBC84\uC2A4",
    "\uCF54\uC2A4\uB2E5150\uB808\uBC84\uB9AC\uC9C0",
    "\uCF54\uC2A4\uB2E5150\uC120\uBB3C\uC778\uBC84\uC2A4"
  ]));
  const isWarrant = containsAny(compactName, [
    "WARRANT",
    "WARRANTS",
    "C/WTS",
    "WTS",
    "\uC6CC\uB7F0\uD2B8",
    "\uC2E0\uC8FC\uC778\uC218\uAD8C"
  ]);
  const isReit = containsAny(compactName, [
    "\uB9AC\uCE20",
    "REIT"
  ]) && !isEtf && !isEtn2 && !isWarrant;
  const isSpac = containsAny(compactName, [
    "\uC2A4\uD329",
    "SPAC"
  ]) && !isEtf && !isEtn2 && !isWarrant;
  const isLeveraged2 = containsAny(compactName, [
    "\uB808\uBC84\uB9AC\uC9C0",
    "2X",
    "3X",
    "BULL2X",
    "BULL3X"
  ]);
  const isInverse2 = containsAny(compactName, [
    "\uC778\uBC84\uC2A4",
    "INVERSE",
    "BEAR",
    "SHORT",
    "SHORT2X",
    "SHORT3X",
    "-1X",
    "-2X",
    "-3X"
  ]);
  const derivativeKeyword = containsAny(compactName, [
    "\uC120\uBB3C",
    "FUTURES",
    "\uC635\uC158",
    "OPTION"
  ]);
  const isDerivative = isLeveraged2 || isInverse2 || derivativeKeyword || isWarrant;
  let assetType = "UNKNOWN";
  if (isEtn2) {
    assetType = "ETN";
  } else if (isEtf) {
    assetType = "ETF";
  } else if (isWarrant) {
    assetType = "UNKNOWN";
  } else if (isReit) {
    assetType = "REIT";
  } else if (isSpac) {
    assetType = "SPAC";
  } else if (market === "KR") {
    assetType = "STOCK";
  } else if (!/\bFUND\b/i.test(upperName) && !/\bTRUST\b/i.test(upperName) && !/\bUNIT\b/i.test(upperName)) {
    assetType = "STOCK";
  }
  const isEtp2 = assetType === "ETF" || assetType === "ETN";
  let riskLevel = "NORMAL";
  if (assetType === "ETN" || isLeveraged2 || isInverse2 || isDerivative) {
    riskLevel = "HIGH";
  } else if (assetType === "ETF" || assetType === "REIT" || assetType === "SPAC" || assetType === "UNKNOWN") {
    riskLevel = "CAUTION";
  }
  const recommendationEligible = assetType === "STOCK" && riskLevel === "NORMAL" && !isLeveraged2 && !isInverse2 && !isDerivative;
  return {
    assetType,
    isEtp: isEtp2,
    isLeveraged: isLeveraged2,
    isInverse: isInverse2,
    isDerivative,
    riskLevel,
    recommendationEligible
  };
}
function rankingReason(type) {
  if (type === "volume") {
    return "\uD0A4\uC6C0\uC99D\uAD8C \uAC70\uB798\uB7C9 \uC0C1\uC704 \uC885\uBAA9\uC785\uB2C8\uB2E4.";
  }
  if (type === "tradingValue") {
    return "\uD0A4\uC6C0\uC99D\uAD8C \uAC70\uB798\uB300\uAE08 \uC0C1\uC704 \uC885\uBAA9\uC785\uB2C8\uB2E4.";
  }
  if (type === "gainers") {
    return "\uD0A4\uC6C0\uC99D\uAD8C \uB4F1\uB77D\uB960 \uAE30\uC900 \uAE09\uC0C1\uC2B9 \uC885\uBAA9\uC785\uB2C8\uB2E4.";
  }
  return "\uD0A4\uC6C0\uC99D\uAD8C \uB4F1\uB77D\uB960 \uAE30\uC900 \uAE09\uD558\uB77D \uC885\uBAA9\uC785\uB2C8\uB2E4.";
}
function normalizeRankingRows(data, market, type) {
  const rows = rankingRows(data);
  const result = [];
  for (const row of rows) {
    const tickerRaw = pick3(row, [
      "stk_cd",
      "stk_code",
      "symbol",
      "symb",
      "ticker",
      "ovrs_pdno",
      "eng_stk_cd",
      "code",
      "item_cd",
      "item_code"
    ]);
    const ticker = String(
      tickerRaw ?? ""
    ).trim().toUpperCase();
    if (!ticker) {
      continue;
    }
    const name = String(
      pick3(row, [
        "stk_nm",
        "stk_name",
        "name",
        "kor_nm",
        "ovrs_item_name",
        "item_nm",
        "item_name"
      ]) ?? ticker
    ).trim();
    const englishName = String(
      pick3(row, [
        "stk_enm",
        "eng_nm",
        "eng_item_nm"
      ]) ?? ""
    ).trim();
    const price = absoluteNumber(
      pick3(row, [
        "cur_prc",
        "now_pric",
        "curr_pric",
        "last",
        "price",
        "ovrs_nmix_prpr",
        "last_pric",
        "close",
        "prpr"
      ])
    );
    const changePercent = toNumber(
      pick3(row, [
        "flu_rt",
        "chg_rt",
        "change_rate",
        "changePercent",
        "prdy_ctrt",
        "rate",
        "diff_rate",
        "fluctuation_rate",
        "diff_rate_for_gjga"
      ])
    );
    const normalizedVolume = normalizeVolume(
      pick3(row, [
        "acc_trde_qty",
        "acc_trd_qty",
        "acml_trde_qty",
        "acml_trd_qty",
        "trde_qty",
        "now_trde_qty",
        "volume",
        "acml_vol",
        "acml_volum",
        "tvol",
        "tot_qty",
        "trade_volume"
      ])
    );
    const tradingValue = normalizeTradingValue(
      row,
      market
    );
    const classification = classifyKiwoomInstrument(
      `${name} ${englishName}`.trim(),
      market
    );
    const dataQualityWarnings = [];
    if (normalizedVolume.warning) {
      dataQualityWarnings.push(
        normalizedVolume.warning
      );
    }
    const sourceRankValue = toNumber(
      pick3(row, [
        "rank",
        "sourceRank",
        "kw_high_rank",
        "rnk"
      ])
    );
    const sourceRank = sourceRankValue == null ? result.length + 1 : Math.max(
      1,
      Math.trunc(
        Math.abs(sourceRankValue)
      )
    );
    result.push({
      ticker,
      name,
      market,
      currency: market === "KR" ? "KRW" : "USD",
      price,
      changePercent,
      volume: normalizedVolume.value,
      tradingValue,
      rank: sourceRank,
      sourceRank,
      assetType: classification.assetType,
      isEtp: classification.isEtp,
      isLeveraged: classification.isLeveraged,
      isInverse: classification.isInverse,
      isDerivative: classification.isDerivative,
      riskLevel: classification.riskLevel,
      recommendationEligible: classification.recommendationEligible,
      dataQualityWarnings,
      reason: rankingReason(type),
      provider: "kiwoom",
      raw: row
    });
  }
  return result;
}
function sortRankingRows(rows, type) {
  return [...rows].sort(
    (a, b) => {
      if (type === "volume") {
        if (a.volume == null && b.volume == null) {
          return a.sourceRank - b.sourceRank;
        }
        if (a.volume == null) {
          return 1;
        }
        if (b.volume == null) {
          return -1;
        }
        return b.volume - a.volume;
      }
      if (type === "tradingValue") {
        if (a.tradingValue == null && b.tradingValue == null) {
          return a.sourceRank - b.sourceRank;
        }
        if (a.tradingValue == null) {
          return 1;
        }
        if (b.tradingValue == null) {
          return -1;
        }
        return b.tradingValue - a.tradingValue;
      }
      if (type === "gainers") {
        return (b.changePercent ?? Number.NEGATIVE_INFINITY) - (a.changePercent ?? Number.NEGATIVE_INFINITY);
      }
      if (type === "losers") {
        return (a.changePercent ?? Number.POSITIVE_INFINITY) - (b.changePercent ?? Number.POSITIVE_INFINITY);
      }
      return a.sourceRank - b.sourceRank;
    }
  );
}
function applyRankingOptions(rows, options, limit) {
  const assetFilter = options.assetFilter ?? "all";
  const filtered = rows.filter(
    (row) => {
      if (assetFilter === "stocks" && (row.assetType !== "STOCK" || row.isEtp || row.isLeveraged || row.isInverse || row.isDerivative || row.riskLevel === "HIGH")) {
        return false;
      }
      if (assetFilter === "etp" && row.assetType !== "ETF" && row.assetType !== "ETN") {
        return false;
      }
      if (options.excludeHighRisk && row.riskLevel === "HIGH") {
        return false;
      }
      if (options.recommendationEligibleOnly && !row.recommendationEligible) {
        return false;
      }
      return true;
    }
  );
  return filtered.slice(0, limit).map((row, index) => ({
    ...row,
    rank: index + 1
  }));
}
function filterByDirection(rows, type) {
  return rows.filter(
    (row) => {
      if (type === "gainers") {
        return row.changePercent != null && row.changePercent > 0;
      }
      if (type === "losers") {
        return row.changePercent != null && row.changePercent < 0;
      }
      return true;
    }
  );
}
function finalizeRankingRows(data, market, type, options, limit) {
  const normalizedRows = normalizeRankingRows(
    data,
    market,
    type
  );
  const directionFilteredRows = filterByDirection(
    normalizedRows,
    type
  );
  const sortedRows = sortRankingRows(
    directionFilteredRows,
    type
  );
  return applyRankingOptions(
    sortedRows,
    options,
    limit
  );
}
async function getKiwoomRankings(market, type, limit = 30, options = {}) {
  const safeLimit = Math.max(
    1,
    Math.min(
      100,
      Math.trunc(limit || 30)
    )
  );
  if (market === "KR") {
    const request = domesticRankingRequest(type);
    const response = await kiwoomRequest(request);
    const rows = finalizeRankingRows(
      response.data,
      market,
      type,
      options,
      safeLimit
    );
    if (rows.length === 0) {
      throw new Error(
        `\uC870\uAC74\uC5D0 \uB9DE\uB294 \uD0A4\uC6C0 \uB7AD\uD0B9 \uC885\uBAA9\uC774 \uC5C6\uC2B5\uB2C8\uB2E4. API=${request.apiId}, market=${market}, type=${type}.`
      );
    }
    return rows;
  }
  const requests = usRankingRequests(type);
  const attemptMessages = [];
  for (const request of requests) {
    try {
      const response = await kiwoomRequest(request);
      const rows = finalizeRankingRows(
        response.data,
        market,
        type,
        options,
        safeLimit
      );
      if (rows.length > 0) {
        return rows;
      }
      attemptMessages.push(
        `${request.apiId}/sort_tp=${String(request.body.sort_tp)}: \uC870\uAC74\uC5D0 \uB9DE\uB294 \uC77C\uBC18\uC8FC\uC2DD 0\uAC1C`
      );
    } catch (error) {
      attemptMessages.push(
        `${request.apiId}/sort_tp=${String(request.body.sort_tp)}: ${error instanceof Error ? error.message : "\uC54C \uC218 \uC5C6\uB294 \uC624\uB958"}`
      );
    }
  }
  throw new Error(
    `\uBBF8\uAD6D \uD0A4\uC6C0 \uB7AD\uD0B9 \uC870\uD68C\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4. market=${market}, type=${type}. \uC2DC\uB3C4 \uACB0\uACFC: ${attemptMessages.join(" | ")}`
  );
}

// src/routes/kiwoom.routes.ts
var router8 = Router8();
function marketParam(value) {
  return String(value ?? "").toUpperCase() === "US" ? "US" : "KR";
}
function rankingTypeParam(value) {
  const normalized = String(
    value ?? "volume"
  );
  if (normalized === "tradingValue") {
    return "tradingValue";
  }
  if (normalized === "gainers") {
    return "gainers";
  }
  if (normalized === "losers") {
    return "losers";
  }
  return "volume";
}
function rankingAssetFilterParam(value) {
  const normalized = String(
    value ?? "all"
  ).trim().toLowerCase();
  if (normalized === "stocks") {
    return "stocks";
  }
  if (normalized === "etp") {
    return "etp";
  }
  return "all";
}
function booleanParam(value, defaultValue = false) {
  if (value == null || value === "") {
    return defaultValue;
  }
  const normalized = String(
    value
  ).trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
    return false;
  }
  return defaultValue;
}
function limitParam(value) {
  const requestedLimit = Number(value ?? 30);
  if (!Number.isFinite(
    requestedLimit
  )) {
    return 30;
  }
  return Math.min(
    Math.max(
      Math.trunc(
        requestedLimit
      ),
      1
    ),
    100
  );
}
async function requestPublicIp() {
  const providers = [
    {
      url: "https://api.ipify.org?format=json",
      parse: async (response) => {
        const result = await response.json();
        return result.ip?.trim() ?? "";
      }
    },
    {
      url: "https://checkip.amazonaws.com/",
      parse: async (response) => {
        return (await response.text()).trim();
      }
    }
  ];
  let lastError = null;
  for (const provider of providers) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      1e4
    );
    try {
      const response = await fetch(
        provider.url,
        {
          method: "GET",
          headers: {
            Accept: "application/json,text/plain",
            "Cache-Control": "no-cache"
          },
          signal: controller.signal
        }
      );
      if (!response.ok) {
        throw new Error(
          `\uC678\uBD80 IP \uD655\uC778 \uC2E4\uD328: HTTP ${response.status}`
        );
      }
      const ip = await provider.parse(
        response
      );
      if (!ip) {
        throw new Error(
          "\uC678\uBD80 IP \uD655\uC778 \uACB0\uACFC\uAC00 \uBE44\uC5B4 \uC788\uC2B5\uB2C8\uB2E4."
        );
      }
      return ip;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(
        "\uC678\uBD80 IP \uD655\uC778 \uC2E4\uD328"
      );
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError ?? new Error(
    "Replit \uC678\uBD80 IP\uB97C \uD655\uC778\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4."
  );
}
router8.get(
  "/egress-ip",
  async (_req, res) => {
    try {
      const egressIp = await requestPublicIp();
      return res.json({
        ok: true,
        provider: "server-egress-check",
        egressIp,
        message: "\uC774 IP\uB97C \uD0A4\uC6C0 REST API \uACC4\uC88C App Key \uAD00\uB9AC \uD654\uBA74\uC5D0 \uB4F1\uB85D\uD558\uC138\uC694.",
        warning: "Replit \uC7AC\uC2DC\uC791 \uB610\uB294 \uC11C\uBC84 \uD658\uACBD \uBCC0\uACBD \uD6C4 IP\uAC00 \uBC14\uB014 \uC218 \uC788\uC2B5\uB2C8\uB2E4.",
        checkedAt: (/* @__PURE__ */ new Date()).toISOString()
      });
    } catch (error) {
      return res.status(502).json({
        ok: false,
        error: error instanceof Error ? error.message : "Replit \uC678\uBD80 IP \uD655\uC778 \uC2E4\uD328"
      });
    }
  }
);
router8.get(
  "/status",
  (_req, res) => {
    return res.json({
      ok: true,
      ...getKiwoomStatus()
    });
  }
);
router8.get(
  "/token-test",
  async (_req, res) => {
    try {
      const token = await getKiwoomToken();
      return res.json({
        ok: true,
        provider: "kiwoom",
        message: "\uD0A4\uC6C0 \uC811\uADFC\uD1A0\uD070 \uBC1C\uAE09 \uC131\uACF5",
        tokenReceived: Boolean(token),
        tokenLength: token.length
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        provider: "kiwoom",
        error: error instanceof Error ? error.message : "\uD0A4\uC6C0 \uD1A0\uD070 \uBC1C\uAE09 \uC2E4\uD328"
      });
    }
  }
);
router8.get(
  "/test",
  async (_req, res) => {
    try {
      const data = await getKiwoomDomesticOrderbook(
        "005930"
      );
      return res.json({
        ok: true,
        provider: "kiwoom",
        market: "KR",
        ticker: "005930",
        name: "\uC0BC\uC131\uC804\uC790",
        data
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        provider: "kiwoom",
        error: error instanceof Error ? error.message : "\uD0A4\uC6C0 \uC870\uD68C \uC2E4\uD328"
      });
    }
  }
);
router8.get(
  "/quote/:ticker",
  async (req, res) => {
    try {
      const ticker = String(
        req.params.ticker ?? ""
      ).trim().toUpperCase();
      const data = await getKiwoomDomesticOrderbook(
        ticker
      );
      return res.json({
        ok: true,
        provider: "kiwoom",
        market: "KR",
        ticker,
        data
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        provider: "kiwoom",
        ticker: String(
          req.params.ticker ?? ""
        ),
        error: error instanceof Error ? error.message : "\uD0A4\uC6C0 \uC885\uBAA9 \uC870\uD68C \uC2E4\uD328"
      });
    }
  }
);
router8.get(
  "/rankings",
  async (req, res) => {
    const market = marketParam(
      req.query.market
    );
    const type = rankingTypeParam(
      req.query.type
    );
    const limit = limitParam(
      req.query.limit
    );
    const assetFilter = rankingAssetFilterParam(
      req.query.assetFilter
    );
    const excludeHighRisk = booleanParam(
      req.query.excludeHighRisk
    );
    const recommendationEligibleOnly = booleanParam(
      req.query.recommendationEligibleOnly
    );
    const options = {
      assetFilter,
      excludeHighRisk,
      recommendationEligibleOnly
    };
    try {
      const rows = await getKiwoomRankings(
        market,
        type,
        limit,
        options
      );
      return res.json({
        ok: true,
        provider: "kiwoom",
        market,
        type,
        limit,
        filters: {
          assetFilter,
          excludeHighRisk,
          recommendationEligibleOnly
        },
        count: rows.length,
        rows,
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      });
    } catch (error) {
      return res.status(502).json({
        ok: false,
        provider: "kiwoom",
        market,
        type,
        limit,
        filters: {
          assetFilter,
          excludeHighRisk,
          recommendationEligibleOnly
        },
        count: 0,
        rows: [],
        error: error instanceof Error ? error.message : "\uD0A4\uC6C0 \uB7AD\uD0B9 \uC870\uD68C \uC2E4\uD328"
      });
    }
  }
);
router8.get(
  "/raw-ranking",
  async (req, res) => {
    const market = marketParam(
      req.query.market
    );
    const type = rankingTypeParam(
      req.query.type
    );
    try {
      const request = market === "KR" ? type === "volume" ? {
        apiId: "ka10030",
        path: "/api/dostk/rkinfo",
        body: {
          mrkt_tp: "000",
          sort_tp: "1",
          mang_stk_incls: "0",
          crd_tp: "0",
          trde_qty_tp: "0",
          pric_tp: "0",
          trde_prica_tp: "0",
          mrkt_open_tp: "0",
          stex_tp: "1"
        }
      } : type === "tradingValue" ? {
        apiId: "ka10032",
        path: "/api/dostk/rkinfo",
        body: {
          mrkt_tp: "000",
          mang_stk_incls: "0",
          stex_tp: "1"
        }
      } : {
        apiId: "ka10027",
        path: "/api/dostk/rkinfo",
        body: {
          mrkt_tp: "000",
          sort_tp: type === "losers" ? "3" : "1",
          trde_qty_cnd: "0000",
          stk_cnd: "0",
          crd_cnd: "0",
          updown_incls: "1",
          pric_cnd: "0",
          trde_prica_cnd: "0",
          stex_tp: "1"
        }
      } : {
        apiId: type === "volume" ? "usa20512" : type === "tradingValue" ? "usa20531" : "usa20881",
        path: "/api/us/rkinfo",
        body: {
          excd: "000",
          item_tp: "1",
          sort_tp: type === "losers" ? "2" : "1"
        }
      };
      const result = await kiwoomRequest(
        request
      );
      return res.json({
        ok: true,
        market,
        type,
        request,
        continuation: {
          contYn: result.contYn,
          nextKey: result.nextKey
        },
        data: result.data
      });
    } catch (error) {
      return res.status(502).json({
        ok: false,
        market,
        type,
        error: error instanceof Error ? error.message : "\uD0A4\uC6C0 \uC6D0\uBB38 \uC870\uD68C \uC2E4\uD328"
      });
    }
  }
);
router8.post(
  "/token/refresh",
  async (_req, res) => {
    try {
      clearKiwoomTokenCache();
      const token = await getKiwoomToken();
      return res.json({
        ok: true,
        provider: "kiwoom",
        message: "\uD0A4\uC6C0 \uC811\uADFC\uD1A0\uD070 \uAC31\uC2E0 \uC131\uACF5",
        tokenReceived: Boolean(token)
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        provider: "kiwoom",
        error: error instanceof Error ? error.message : "\uD0A4\uC6C0 \uD1A0\uD070 \uAC31\uC2E0 \uC2E4\uD328"
      });
    }
  }
);
var kiwoom_routes_default = router8;

// src/routes/index.ts
var router9 = Router9();
router9.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "seungjae-stock-api",
    status: "running",
    recommendationCount: { KR: 30, US: 30 },
    routes: {
      health: "/api/healthz",
      config: "/api/config",
      search: "/api/search?q=\uC0BC\uC131\uC804\uC790",
      quotes: "/api/quotes?tickers=005930,NVDA,AAPL",
      movers: "/api/market/movers?market=KR",
      kiwoomStatus: "/api/kiwoom/status",
      kiwoomRankings: "/api/kiwoom/rankings?market=KR&type=volume&limit=30",
      stockQuote: "/api/stocks/005930/quote",
      watchlist: "/api/watchlist",
      alerts: "/api/market/alerts?market=ALL"
    }
  });
});
router9.use("/", health_default);
router9.use("/", market_default);
router9.use("/", news_route_default);
router9.use("/debug", provider_debug_default);
router9.use("/", push_default);
router9.use("/stocks", stocks_default);
router9.use("/", watchlist_default);
router9.use("/kiwoom", kiwoom_routes_default);
var routes_default = router9;

// src/index.ts
var __filename = fileURLToPath(import.meta.url);
var __dirname = path2.dirname(__filename);
var app = express();
var port = Number(
  process.env.PORT ?? process.env.API_PORT ?? 8080
);
app.disable("x-powered-by");
app.use(
  cors({
    origin: true,
    credentials: true
  })
);
app.use(
  express.json({
    limit: "5mb"
  })
);
app.use(
  express.urlencoded({
    extended: true
  })
);
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "api-server",
    route: "/health",
    time: (/* @__PURE__ */ new Date()).toISOString()
  });
});
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "api-server",
    route: "/api/health",
    time: (/* @__PURE__ */ new Date()).toISOString()
  });
});
app.use("/api", routes_default);
var frontendDistCandidates = [
  path2.resolve(
    __dirname,
    "../../stock-analyzer/dist/public"
  ),
  path2.resolve(
    __dirname,
    "../../stock-analyzer/dist"
  ),
  path2.resolve(
    __dirname,
    "../../../stock-analyzer/dist/public"
  ),
  path2.resolve(
    __dirname,
    "../../../stock-analyzer/dist"
  ),
  path2.resolve(
    process.cwd(),
    "../stock-analyzer/dist/public"
  ),
  path2.resolve(
    process.cwd(),
    "../stock-analyzer/dist"
  ),
  path2.resolve(
    process.cwd(),
    "artifacts/stock-analyzer/dist/public"
  ),
  path2.resolve(
    process.cwd(),
    "artifacts/stock-analyzer/dist"
  ),
  path2.resolve(
    process.cwd(),
    "stock-analyzer/dist/public"
  ),
  path2.resolve(
    process.cwd(),
    "stock-analyzer/dist"
  )
];
var frontendDist = frontendDistCandidates.find(
  (candidate) => fs2.existsSync(
    path2.join(
      candidate,
      "index.html"
    )
  )
);
if (frontendDist) {
  app.use(
    express.static(
      frontendDist
    )
  );
}
var availableRoutes = [
  "/api",
  "/api/health",
  "/api/config",
  "/api/search?q=\uC0BC\uC131\uC804\uC790",
  "/api/quotes?tickers=005930,NVDA,AAPL",
  "/api/market/movers?market=KR",
  "/api/market/movers?market=US",
  "/api/kiwoom/status",
  "/api/kiwoom/token-test",
  "/api/kiwoom/test",
  "/api/kiwoom/rankings?market=KR&type=volume&limit=30",
  "/api/kiwoom/rankings?market=US&type=tradingValue&limit=30",
  "/api/stocks/005930/quote",
  "/api/watchlist"
];
app.use((req, res) => {
  if (req.path.startsWith(
    "/api"
  )) {
    res.status(404).json({
      ok: false,
      error: "API_ROUTE_NOT_FOUND",
      path: req.path,
      available: availableRoutes
    });
    return;
  }
  if (frontendDist) {
    res.sendFile(
      path2.join(
        frontendDist,
        "index.html"
      )
    );
    return;
  }
  res.status(200).json({
    ok: true,
    service: "api-server",
    message: "API server is running, but frontend dist was not found.",
    available: [
      "/health",
      ...availableRoutes
    ]
  });
});
app.listen(
  port,
  "0.0.0.0",
  () => {
    console.log(
      `[api-server] listening on 0.0.0.0:${port}`
    );
    console.log(
      "[api-server] Kiwoom routes enabled at /api/kiwoom"
    );
    if (frontendDist) {
      console.log(
        `[api-server] serving frontend from ${frontendDist}`
      );
    } else {
      console.log(
        "[api-server] frontend dist not found, api only mode"
      );
    }
  }
);
//# sourceMappingURL=index.mjs.map
