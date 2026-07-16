
import { createRequire as __createRequire } from 'node:module';
const require = __createRequire(import.meta.url);


// src/index.ts
import express from "express";
import cors from "cors";
import path5 from "node:path";
import fs3 from "node:fs";
import { fileURLToPath } from "node:url";

// src/routes/index.ts
import { Router as Router12 } from "express";

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

// src/services/market-data.service.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

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
  const isEtf2 = t === "etp" || t.includes("etf") || /상장지수펀드|\betf\b/i.test(n) || brandFund || // Leverage/inverse naming (Bull/Bear/3X/UltraPro/...) is a reliable ETP
  // signal even when the provider type is missing (e.g. Finnhub tags SOXL as
  // a common stock).
  (lev || inv) && !isEtn2;
  if (isReit) return "REIT";
  if (isEtn2) {
    if (inv) return "INVERSE_ETN";
    if (lev) return "LEVERAGED_ETN";
    return "ETN";
  }
  if (isEtf2) {
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
function computeIndicators(candles) {
  const closes = candles.map((c) => c.close);
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
function detectSignals(candles, ind) {
  const signals = [];
  const n = candles.length;
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
    const avg = candles.slice(n - 21, n - 1).reduce((s, c) => s + c.volume, 0) / 20;
    ratio = avg > 0 ? candles[n - 1].volume / avg : 0;
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
function technicalScore(candles, ind, signals) {
  let score = 50;
  const map = new Map(signals.map((s) => [s.key, s]));
  if (map.get("golden_cross")?.active) score += 12;
  if (map.get("dead_cross")?.active) score -= 12;
  if (map.get("volume_surge")?.active) score += 5;
  if (map.get("macd_buy")?.active) score += 10;
  if (map.get("macd_sell")?.active) score -= 10;
  const n = candles.length;
  const price = candles[n - 1]?.close ?? 0;
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
  const quote = getQuote(ticker);
  if (!quote) return null;
  const q = qualityScore(entry.ticker);
  const rng = seeded(entry.ticker, "fin");
  const marketCap = quote.marketCap;
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
  const per = eps > 0 ? Math.round(quote.price / eps * 10) / 10 : 0;
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
  const candles = getCandles(ticker, "1D");
  const ind = computeIndicators(candles);
  const signals = detectSignals(candles, ind);
  const technical = technicalScore(candles, ind, signals);
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
  const quote = result.indicators?.quote?.[0];
  if (!quote?.close?.length) {
    throw new Error(`YAHOO_PROVIDER_MARKER_20260711_NO_CLOSE:${symbol}`);
  }
  const index = lastValidIndex(quote.close);
  if (index < 0) {
    throw new Error(`YAHOO_PROVIDER_MARKER_20260711_NO_VALID_PRICE:${symbol}`);
  }
  const price = safeNumber(result.meta?.regularMarketPrice) || safeNumber(quote.close[index]);
  if (!price) {
    throw new Error(`YAHOO_PROVIDER_MARKER_20260711_ZERO_PRICE:${symbol}`);
  }
  let previousClose = safeNumber(result.meta?.previousClose) || safeNumber(result.meta?.chartPreviousClose);
  if (!previousClose) {
    for (let i = index - 1; i >= 0; i -= 1) {
      const candidate = safeNumber(quote.close[i]);
      if (candidate > 0) {
        previousClose = candidate;
        break;
      }
    }
  }
  if (!previousClose) previousClose = price;
  const changeAmount = price - previousClose;
  const changePercent = previousClose ? changeAmount / previousClose * 100 : 0;
  const volume = safeNumber(quote.volume?.[index]);
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
    open: safeNumber(quote.open?.[index]),
    high: safeNumber(quote.high?.[index]),
    low: safeNumber(quote.low?.[index]),
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
async function getCandles2(entryOrTicker) {
  const ticker = getTickerFromEntry(entryOrTicker);
  const symbol = yahooSymbol(ticker);
  const result = await fetchYahooChart(symbol);
  const quote = result.indicators?.quote?.[0];
  if (!result.timestamp?.length || !quote) return [];
  return result.timestamp.map((timestamp, index) => {
    const close = safeNumber(quote.close?.[index]);
    return {
      time: new Date(timestamp * 1e3).toISOString(),
      open: safeNumber(quote.open?.[index]),
      high: safeNumber(quote.high?.[index]),
      low: safeNumber(quote.low?.[index]),
      close,
      volume: safeNumber(quote.volume?.[index])
    };
  }).filter((candle) => candle.close > 0);
}
async function getIndexQuote(symbol) {
  const clean = cleanTicker(symbol);
  const result = await fetchYahooChart(clean);
  const quote = result.indicators?.quote?.[0];
  if (!quote?.close?.length) {
    throw new Error(`YAHOO_INDEX_NO_CLOSE:${clean}`);
  }
  const index = lastValidIndex(quote.close);
  if (index < 0) {
    throw new Error(`YAHOO_INDEX_NO_VALID_PRICE:${clean}`);
  }
  const price = safeNumber(result.meta?.regularMarketPrice) || safeNumber(quote.close[index]);
  let previousClose = safeNumber(result.meta?.previousClose) || safeNumber(result.meta?.chartPreviousClose);
  if (!previousClose) {
    for (let i = index - 1; i >= 0; i -= 1) {
      const candidate = safeNumber(quote.close[i]);
      if (candidate > 0) {
        previousClose = candidate;
        break;
      }
    }
  }
  if (!price || !previousClose) {
    throw new Error(`YAHOO_INDEX_INCOMPLETE:${clean}`);
  }
  const changeAmount = price - previousClose;
  return {
    price,
    changeAmount,
    changePercent: changeAmount / previousClose * 100,
    spark: quote.close.map((value) => safeNumber(value)).filter((value) => value > 0),
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
async function getCompanyProfile(entryOrTicker) {
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
async function getCompanyProfile2(entryOrTicker) {
  const ticker = getTickerFromEntry2(entryOrTicker);
  const code = onlyDigits(ticker);
  const name = getNameFromEntry2(entryOrTicker, code);
  return {
    ticker: code,
    name,
    market: "KR",
    currency: "KRW",
    description: `${name} \uAE30\uC5C5 \uC815\uBCF4\uC785\uB2C8\uB2E4.`,
    sector: "",
    industry: "",
    website: ""
  };
}
async function getRatios(entryOrTicker) {
  const ticker = getTickerFromEntry2(entryOrTicker);
  const code = onlyDigits(ticker);
  if (!isKrTicker2(code)) {
    throw new Error(`NAVER_ONLY_SUPPORTS_KR_TICKER:${ticker}`);
  }
  const html = await fetchText(`https://finance.naver.com/item/main.naver?code=${code}`);
  const eps = parseNumberNear("EPS", html);
  const per = parseNumberNear("PER", html);
  const pbr = parseNumberNear("PBR", html);
  const bps = parseNumberNear("BPS", html);
  if (![eps, per, pbr, bps].some((value) => Number.isFinite(value) && value !== 0)) {
    throw new Error(`NAVER_RATIO_PARSE_FAILED:${code}`);
  }
  return { eps, per, pbr, bps };
}

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
function getDartKey() {
  const key = process.env["DART_API_KEY"];
  if (!key) throw new ProviderError("NOT_CONFIGURED", "dart");
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
async function fetchBuffer(url, opts) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 2e4);
  try {
    const res = await fetch(url, {
      headers: opts.headers,
      signal: controller.signal
    });
    if (!res.ok) {
      throw new ProviderError(
        "UPSTREAM_ERROR",
        opts.provider,
        `HTTP ${res.status}`
      );
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    if (err instanceof ProviderError) throw err;
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
function isSupabaseConfigured() {
  return Boolean(process.env.SUPABASE_URL) && Boolean(serverKey() ?? process.env.SUPABASE_ANON_KEY);
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
function getUserSupabase(accessToken) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY ?? serverKey();
  if (!url || !key || !accessToken) {
    throw new Error("User-scoped Supabase is not configured.");
  }
  return createClient(url, key, {
    global: {
      headers: { Authorization: `Bearer ${accessToken}` }
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
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
async function getProfile(entry) {
  const key = getFinnhubKey();
  const symbol = toFinnhubSymbol(entry);
  return cached(`finnhub:profile:${symbol}`, TTL.profile, async () => {
    const data = await fetchJson3(
      `${BASE}/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${key}`,
      { provider: "finnhub" }
    );
    return {
      name: data.name ?? entry.name,
      marketCap: typeof data.marketCapitalization === "number" ? data.marketCapitalization * 1e6 : null,
      exchange: data.exchange ?? null,
      industry: data.finnhubIndustry ?? null
    };
  });
}
function round2(n) {
  return Math.round(n * 100) / 100;
}
async function getRatios2(entry) {
  const key = getFinnhubKey();
  const symbol = toFinnhubSymbol(entry);
  return cached(`finnhub:metric:${symbol}`, TTL.financials, async () => {
    const data = await fetchJson3(
      `${BASE}/stock/metric?symbol=${encodeURIComponent(symbol)}&metric=all&token=${key}`,
      { provider: "finnhub" }
    );
    const m = data.metric ?? {};
    const num2 = (k) => {
      const v = m[k];
      return typeof v === "number" && Number.isFinite(v) ? v : 0;
    };
    const de = num2("totalDebt/totalEquityAnnual") || num2("totalDebt/totalEquityQuarterly");
    return {
      eps: round2(
        num2("epsBasicExclExtraItemsTTM") || num2("epsInclExtraItemsTTM")
      ),
      per: round2(num2("peBasicExclExtraTTM") || num2("peInclExtraTTM")),
      pbr: round2(num2("pbAnnual") || num2("pbQuarterly")),
      roe: round2(num2("roeTTM") || num2("roeRfy")),
      debtRatio: round2(de * 100)
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

// src/providers/kiwoom.ts
var REAL_BASE_URL = process.env.KIWOOM_BASE_URL?.trim() || "http://158.247.235.32:3000/kiwoom";
var MOCK_BASE_URL = "https://mockapi.kiwoom.com";
var REQUEST_TIMEOUT_MS = 15e3;
var UINT32_MAX = 4294967295;
var INT32_MAX = 2147483647;
var tokenCache = null;
var requestQueue = Promise.resolve();
var nextRequestAt = 0;
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function waitForRequestSlot() {
  const previous = requestQueue;
  let release = () => void 0;
  requestQueue = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  const minimumInterval = isMockMode() ? 260 : 240;
  const wait = Math.max(0, nextRequestAt - Date.now());
  if (wait > 0) await sleep(wait);
  nextRequestAt = Date.now() + minimumInterval;
  release();
}
function isMockMode() {
  return process.env.KIWOOM_MODE?.trim().toLowerCase() === "mock";
}
function baseUrl() {
  return isMockMode() ? MOCK_BASE_URL : REAL_BASE_URL;
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
function proxyHeaders() {
  if (isMockMode()) {
    return {};
  }
  return {
    "x-proxy-key": requireEnv(
      "KIWOOM_PROXY_KEY"
    )
  };
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
    return JSON.parse(
      text
    );
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
function isKiwoomConfigured() {
  return Boolean(
    process.env.KIWOOM_APP_KEY?.trim() && process.env.KIWOOM_APP_SECRET?.trim() && (isMockMode() || process.env.KIWOOM_PROXY_KEY?.trim())
  );
}
function getKiwoomStatus() {
  return {
    provider: "kiwoom",
    mode: isMockMode() ? "mock" : "real",
    providerEndpointConfigured: Boolean(process.env.KIWOOM_BASE_URL),
    appKeyRegistered: Boolean(
      process.env.KIWOOM_APP_KEY?.trim()
    ),
    appSecretRegistered: Boolean(
      process.env.KIWOOM_APP_SECRET?.trim()
    ),
    proxyKeyRegistered: isMockMode() || Boolean(
      process.env.KIWOOM_PROXY_KEY?.trim()
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
          "Content-Type": "application/json;charset=UTF-8",
          ...proxyHeaders()
        },
        body: JSON.stringify({
          grant_type: "client_credentials",
          appkey: requireEnv(
            "KIWOOM_APP_KEY"
          ),
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
  path: path6,
  body,
  contYn,
  nextKey,
  retryAuth = true,
  retryRateLimit = 0
}) {
  const token = await getKiwoomToken();
  await waitForRequestSlot();
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json;charset=UTF-8",
    authorization: `Bearer ${token}`,
    "api-id": apiId,
    ...proxyHeaders()
  };
  if (contYn) {
    headers["cont-yn"] = contYn;
  }
  if (nextKey) {
    headers["next-key"] = nextKey;
  }
  try {
    const response = await fetch(
      `${baseUrl()}${path6}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      }
    );
    const result = await readJson(response);
    if (!response.ok || returnCode(result) !== 0) {
      const message = returnMessage(result);
      const rateLimited = response.status === 429 || returnCode(result) === 1700 || /요청 개수|too many|rate limit/i.test(message);
      if (rateLimited && retryRateLimit < 4) {
        clearTimeout(timeout);
        await sleep(700 * Math.pow(2, retryRateLimit));
        return kiwoomRequest({
          apiId,
          path: path6,
          body,
          contYn,
          nextKey,
          retryAuth,
          retryRateLimit: retryRateLimit + 1
        });
      }
      const authExpired = response.status === 401 || response.status === 403 || returnCode(result) === 8005 || message.toLowerCase().includes("token");
      if (authExpired) {
        clearKiwoomTokenCache();
        if (retryAuth) {
          return kiwoomRequest({ apiId, path: path6, body, contYn, nextKey, retryAuth: false, retryRateLimit });
        }
      }
      throw new Error(
        `\uD0A4\uC6C0 ${apiId} \uC694\uCCAD \uC2E4\uD328: ${message} (HTTP ${response.status})`
      );
    }
    return {
      data: result,
      contYn: response.headers.get(
        "cont-yn"
      ),
      nextKey: response.headers.get(
        "next-key"
      )
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
function pick(row, keys) {
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
  const entry = pickEntry(
    row,
    [
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
    ]
  );
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
  const isEtn2 = /\bETN\b/i.test(
    upperName
  ) || containsAny(
    compactName,
    [
      "\uC0C1\uC7A5\uC9C0\uC218\uC99D\uAD8C",
      "\uB808\uBC84\uB9AC\uC9C0ETN",
      "\uC778\uBC84\uC2A4ETN"
    ]
  );
  const koreanEtfBrand = /^(KODEX|TIGER|RISE|ACE|SOL|PLUS|HANARO|KOSEF|ARIRANG|TIMEFOLIO|WOORI|FOCUS|KIWOOM|KBSTAR|1Q|BNK|히어로즈|마이티)(\s|$)/i.test(
    normalizedName
  );
  const overseasEtfName = /\bETF\b/i.test(
    upperName
  ) || /\bEXCHANGE TRADED FUND\b/i.test(
    upperName
  );
  const isEtf2 = !isEtn2 && (koreanEtfBrand || overseasEtfName || containsAny(
    compactName,
    [
      "\uC0C1\uC7A5\uC9C0\uC218\uD380\uB4DC",
      "\uB2E8\uC77C\uC885\uBAA9\uB808\uBC84\uB9AC\uC9C0",
      "\uC120\uBB3C\uC778\uBC84\uC2A4",
      "\uCF54\uC2A4\uB2E5150\uB808\uBC84\uB9AC\uC9C0",
      "\uCF54\uC2A4\uB2E5150\uC120\uBB3C\uC778\uBC84\uC2A4"
    ]
  ));
  const isWarrant = containsAny(
    compactName,
    [
      "WARRANT",
      "WARRANTS",
      "C/WTS",
      "WTS",
      "\uC6CC\uB7F0\uD2B8",
      "\uC2E0\uC8FC\uC778\uC218\uAD8C"
    ]
  );
  const isReit = containsAny(
    compactName,
    [
      "\uB9AC\uCE20",
      "REIT"
    ]
  ) && !isEtf2 && !isEtn2 && !isWarrant;
  const isSpac = containsAny(
    compactName,
    [
      "\uC2A4\uD329",
      "SPAC"
    ]
  ) && !isEtf2 && !isEtn2 && !isWarrant;
  const isLeveraged3 = containsAny(
    compactName,
    [
      "\uB808\uBC84\uB9AC\uC9C0",
      "2X",
      "3X",
      "BULL2X",
      "BULL3X"
    ]
  );
  const isInverse3 = containsAny(
    compactName,
    [
      "\uC778\uBC84\uC2A4",
      "INVERSE",
      "BEAR",
      "SHORT",
      "SHORT2X",
      "SHORT3X",
      "-1X",
      "-2X",
      "-3X"
    ]
  );
  const derivativeKeyword = containsAny(
    compactName,
    [
      "\uC120\uBB3C",
      "FUTURES",
      "\uC635\uC158",
      "OPTION"
    ]
  );
  const isDerivative = isLeveraged3 || isInverse3 || derivativeKeyword || isWarrant;
  let assetType = "UNKNOWN";
  if (isEtn2) {
    assetType = "ETN";
  } else if (isEtf2) {
    assetType = "ETF";
  } else if (isWarrant) {
    assetType = "UNKNOWN";
  } else if (isReit) {
    assetType = "REIT";
  } else if (isSpac) {
    assetType = "SPAC";
  } else if (market === "KR") {
    assetType = "STOCK";
  } else if (!/\bFUND\b/i.test(
    upperName
  ) && !/\bTRUST\b/i.test(
    upperName
  ) && !/\bUNIT\b/i.test(
    upperName
  )) {
    assetType = "STOCK";
  }
  const isEtp2 = assetType === "ETF" || assetType === "ETN";
  let riskLevel = "NORMAL";
  if (assetType === "ETN" || isLeveraged3 || isInverse3 || isDerivative) {
    riskLevel = "HIGH";
  } else if (assetType === "ETF" || assetType === "REIT" || assetType === "SPAC" || assetType === "UNKNOWN") {
    riskLevel = "CAUTION";
  }
  const recommendationEligible = assetType === "STOCK" && riskLevel === "NORMAL" && !isLeveraged3 && !isInverse3 && !isDerivative;
  return {
    assetType,
    isEtp: isEtp2,
    isLeveraged: isLeveraged3,
    isInverse: isInverse3,
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
    const tickerRaw = pick(
      row,
      [
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
      ]
    );
    const ticker = String(
      tickerRaw ?? ""
    ).trim().toUpperCase();
    if (!ticker) {
      continue;
    }
    const name = String(
      pick(
        row,
        [
          "stk_nm",
          "stk_name",
          "name",
          "kor_nm",
          "ovrs_item_name",
          "item_nm",
          "item_name"
        ]
      ) ?? ticker
    ).trim();
    const englishName = String(
      pick(
        row,
        [
          "stk_enm",
          "eng_nm",
          "eng_item_nm"
        ]
      ) ?? ""
    ).trim();
    const price = absoluteNumber(
      pick(
        row,
        [
          "cur_prc",
          "now_pric",
          "curr_pric",
          "last",
          "price",
          "ovrs_nmix_prpr",
          "last_pric",
          "close",
          "prpr"
        ]
      )
    );
    const changePercent = toNumber(
      pick(
        row,
        [
          "flu_rt",
          "chg_rt",
          "change_rate",
          "changePercent",
          "prdy_ctrt",
          "rate",
          "diff_rate",
          "fluctuation_rate",
          "diff_rate_for_gjga"
        ]
      )
    );
    const normalizedVolume = normalizeVolume(
      pick(
        row,
        [
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
        ]
      )
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
      pick(
        row,
        [
          "rank",
          "sourceRank",
          "kw_high_rank",
          "rnk"
        ]
      )
    );
    const sourceRank = sourceRankValue == null ? result.length + 1 : Math.max(
      1,
      Math.trunc(
        Math.abs(
          sourceRankValue
        )
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
  return filtered.slice(0, limit).map(
    (row, index) => ({
      ...row,
      rank: index + 1
    })
  );
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
      Math.trunc(
        limit || 30
      )
    )
  );
  if (market === "KR") {
    const request = domesticRankingRequest(
      type
    );
    const response = await kiwoomRequest(
      request
    );
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
      const response = await kiwoomRequest(
        request
      );
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
async function placeKiwoomDomesticOrder(input) {
  const ticker = input.ticker.trim().toUpperCase();
  const quantity = Math.trunc(Number(input.quantity));
  const orderType = input.orderType ?? "market";
  const price = input.price == null ? null : Number(input.price);
  if (!/^\d{6}(?:_(?:NX|AL))?$/.test(ticker)) {
    throw new Error(`\uC798\uBABB\uB41C \uAD6D\uB0B4 \uC885\uBAA9\uCF54\uB4DC\uC785\uB2C8\uB2E4: ${ticker}`);
  }
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new Error("\uC8FC\uBB38 \uC218\uB7C9\uC740 1\uC8FC \uC774\uC0C1 \uC815\uC218\uC5EC\uC57C \uD569\uB2C8\uB2E4.");
  }
  if (orderType === "limit" && (!Number.isFinite(price) || Number(price) <= 0)) {
    throw new Error("\uC9C0\uC815\uAC00 \uC8FC\uBB38 \uAC00\uACA9\uC744 \uD655\uC778\uD574 \uC8FC\uC138\uC694.");
  }
  const apiId = input.side === "buy" ? process.env.KIWOOM_BUY_ORDER_API_ID?.trim() || "kt10000" : process.env.KIWOOM_SELL_ORDER_API_ID?.trim() || "kt10001";
  const path6 = process.env.KIWOOM_ORDER_PATH?.trim() || "/api/dostk/ordr";
  const marketTradeType = process.env.KIWOOM_MARKET_ORDER_TRADE_TYPE?.trim() || "3";
  const limitTradeType = process.env.KIWOOM_LIMIT_ORDER_TRADE_TYPE?.trim() || "0";
  const response = await kiwoomRequest({
    apiId,
    path: path6,
    body: {
      dmst_stex_tp: process.env.KIWOOM_DOMESTIC_EXCHANGE?.trim() || "KRX",
      stk_cd: ticker,
      ord_qty: String(quantity),
      ord_uv: orderType === "limit" ? String(Math.round(Number(price))) : "",
      trde_tp: orderType === "limit" ? limitTradeType : marketTradeType,
      cond_uv: ""
    }
  });
  const raw = response.data;
  const orderNo = String(
    raw.ord_no ?? raw.order_no ?? raw.ordNo ?? raw.orderNo ?? ""
  ).trim() || null;
  return {
    ticker,
    side: input.side,
    quantity,
    orderNo,
    raw
  };
}
async function placeKiwoomUsOrder(input) {
  const ticker = input.ticker.trim().toUpperCase();
  const quantity = Math.trunc(Number(input.quantity));
  const orderType = input.orderType ?? "market";
  const price = input.price == null ? null : Number(input.price);
  if (!/^[A-Z][A-Z0-9.-]{0,11}$/.test(ticker)) {
    throw new Error(`\uC798\uBABB\uB41C \uBBF8\uAD6D \uC885\uBAA9\uCF54\uB4DC\uC785\uB2C8\uB2E4: ${ticker}`);
  }
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new Error("\uC8FC\uBB38 \uC218\uB7C9\uC740 1\uC8FC \uC774\uC0C1 \uC815\uC218\uC5EC\uC57C \uD569\uB2C8\uB2E4.");
  }
  if (orderType === "limit" && (!Number.isFinite(price) || Number(price) <= 0)) {
    throw new Error("\uC9C0\uC815\uAC00 \uC8FC\uBB38 \uAC00\uACA9\uC744 \uD655\uC778\uD574 \uC8FC\uC138\uC694.");
  }
  const exchangeCode = {
    NASDAQ: "ND",
    NYSE: "NY",
    AMEX: "NA"
  };
  const apiId = input.side === "buy" ? process.env.KIWOOM_US_BUY_ORDER_API_ID?.trim() || "ust20000" : process.env.KIWOOM_US_SELL_ORDER_API_ID?.trim() || "ust20001";
  const path6 = process.env.KIWOOM_US_ORDER_PATH?.trim() || "/api/us/ordr";
  const marketTradeType = process.env.KIWOOM_US_MARKET_ORDER_TRADE_TYPE?.trim() || "03";
  const limitTradeType = process.env.KIWOOM_US_LIMIT_ORDER_TRADE_TYPE?.trim() || "00";
  const limitPrice = Number(price ?? 0).toFixed(4).replace(/\.?0+$/, "");
  const response = await kiwoomRequest({
    apiId,
    path: path6,
    body: {
      stex_tp: exchangeCode[input.exchange],
      stk_cd: ticker,
      ord_qty: String(quantity),
      ord_uv: orderType === "limit" ? limitPrice : "",
      trde_tp: orderType === "limit" ? limitTradeType : marketTradeType
    }
  });
  const raw = response.data;
  const orderNo = String(
    raw.ord_no ?? raw.order_no ?? raw.ordNo ?? raw.orderNo ?? ""
  ).trim() || null;
  return {
    ticker,
    exchange: input.exchange,
    side: input.side,
    quantity,
    orderNo,
    raw
  };
}
async function getKiwoomShortSellingRaw(tickerInput) {
  const ticker = tickerInput.trim().toUpperCase();
  if (!/^\d{6}(?:_(?:NX|AL))?$/.test(ticker)) {
    throw new Error(`\uC798\uBABB\uB41C \uAD6D\uB0B4 \uC885\uBAA9\uCF54\uB4DC\uC785\uB2C8\uB2E4: ${ticker}`);
  }
  const formatDate = (date) => `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
  const endDate = /* @__PURE__ */ new Date();
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - 31);
  const response = await kiwoomRequest({
    apiId: process.env.KIWOOM_SHORT_SELLING_API_ID?.trim() || "ka10014",
    path: process.env.KIWOOM_SHORT_SELLING_PATH?.trim() || "/api/dostk/shsa",
    body: {
      stk_cd: ticker,
      tm_tp: "1",
      strt_dt: formatDate(startDate),
      end_dt: formatDate(endDate)
    }
  });
  return response.data;
}

// src/kiwoom-chart.ts
var CHART_PATH = "/api/dostk/chart";
var CONTINUATION_DELAY_MS = 80;
function sleep2(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
function normalizeTicker(value) {
  return String(value ?? "").trim().toUpperCase();
}
function normalizeTimeframe(value) {
  const raw = String(value ?? "1D").trim();
  return raw || "1D";
}
function koreaToday() {
  const now = /* @__PURE__ */ new Date();
  const koreaTime = new Date(
    now.getTime() + 9 * 60 * 60 * 1e3
  );
  return koreaTime.toISOString().slice(0, 10).replace(/-/g, "");
}
function toFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.replace(/,/g, "").replace(/[+%₩$원]/g, "").trim();
  if (!normalized) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}
function absoluteFiniteNumber(value) {
  const parsed = toFiniteNumber(value);
  return parsed == null ? null : Math.abs(parsed);
}
function pick2(row, keys) {
  for (const key of keys) {
    const value = row[key];
    if (value != null && value !== "") {
      return value;
    }
  }
  return void 0;
}
function rowLooksLikeChart(row) {
  const date = pick2(row, [
    "dt",
    "date",
    "cntr_tm",
    "time",
    "datetime",
    "timestamp",
    "xymd",
    "base_dt",
    "trde_dt"
  ]);
  const close = pick2(row, [
    "cur_prc",
    "close",
    "close_pric",
    "closePrice",
    "last",
    "price"
  ]);
  const open = pick2(row, [
    "open_pric",
    "open",
    "openPrice",
    "open_prc"
  ]);
  const high = pick2(row, [
    "high_pric",
    "high",
    "highPrice",
    "high_prc"
  ]);
  const low = pick2(row, [
    "low_pric",
    "low",
    "lowPrice",
    "low_prc"
  ]);
  return Boolean(
    date && close != null && open != null && high != null && low != null
  );
}
function collectChartArrays(value, depth = 0, results = []) {
  if (depth > 6 || value == null) {
    return results;
  }
  if (Array.isArray(value)) {
    const objectRows2 = value.filter(
      (item) => Boolean(item) && typeof item === "object" && !Array.isArray(item)
    );
    if (objectRows2.length > 0 && objectRows2.some(rowLooksLikeChart)) {
      results.push(objectRows2);
    }
    for (const item of value) {
      collectChartArrays(
        item,
        depth + 1,
        results
      );
    }
    return results;
  }
  if (typeof value === "object") {
    for (const nested of Object.values(
      value
    )) {
      collectChartArrays(
        nested,
        depth + 1,
        results
      );
    }
  }
  return results;
}
function bestChartRows(data) {
  const arrays = collectChartArrays(data);
  if (arrays.length === 0) {
    return [];
  }
  return arrays.sort((a, b) => {
    const scoreA = a.filter(rowLooksLikeChart).length * 1e3 + a.length;
    const scoreB = b.filter(rowLooksLikeChart).length * 1e3 + b.length;
    return scoreB - scoreA;
  })[0];
}
function combineDateAndTime(row) {
  const date = String(
    pick2(row, [
      "dt",
      "date",
      "xymd",
      "trde_dt",
      "base_dt"
    ]) ?? ""
  ).replace(/\D/g, "").trim();
  const time = String(
    pick2(row, [
      "cntr_tm",
      "time",
      "hhmmss",
      "trde_tm"
    ]) ?? ""
  ).replace(/\D/g, "").trim();
  if (time.length >= 12) {
    return time.slice(0, 14);
  }
  if (date.length === 8 && time.length >= 4 && time.length <= 6) {
    return `${date}${time.padEnd(6, "0")}`;
  }
  if (date.length === 8) {
    return date;
  }
  if (time.length >= 8) {
    return time;
  }
  return String(
    pick2(row, [
      "datetime",
      "timestamp",
      "cntr_tm",
      "time",
      "dt",
      "date"
    ]) ?? ""
  ).trim();
}
function normalizeRow(row) {
  const close = absoluteFiniteNumber(
    pick2(row, [
      "cur_prc",
      "close",
      "close_pric",
      "closePrice",
      "last",
      "price"
    ])
  );
  const open = absoluteFiniteNumber(
    pick2(row, [
      "open_pric",
      "open",
      "openPrice",
      "open_prc"
    ])
  );
  const high = absoluteFiniteNumber(
    pick2(row, [
      "high_pric",
      "high",
      "highPrice",
      "high_prc"
    ])
  );
  const low = absoluteFiniteNumber(
    pick2(row, [
      "low_pric",
      "low",
      "lowPrice",
      "low_prc"
    ])
  );
  const volume = absoluteFiniteNumber(
    pick2(row, [
      "trde_qty",
      "acc_trde_qty",
      "volume",
      "tradeVolume",
      "tradingVolume",
      "acml_vol"
    ])
  );
  const time = combineDateAndTime(row);
  if (!time || close == null || open == null || high == null || low == null) {
    return null;
  }
  return {
    time,
    open,
    high: Math.max(
      high,
      open,
      close
    ),
    low: Math.min(
      low,
      open,
      close
    ),
    close,
    volume: Math.max(
      volume ?? 0,
      0
    )
  };
}
function timeSortValue(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  const parsed = Number(digits);
  return Number.isFinite(parsed) ? parsed : 0;
}
function dedupeAndSort(rows) {
  const map = /* @__PURE__ */ new Map();
  for (const row of rows) {
    map.set(row.time, row);
  }
  return [...map.values()].sort(
    (a, b) => timeSortValue(a.time) - timeSortValue(b.time)
  );
}
function aggregateCandles(rows, size) {
  if (size <= 1 || rows.length <= 1) {
    return rows;
  }
  const result = [];
  for (let index = 0; index < rows.length; index += size) {
    const chunk = rows.slice(
      index,
      index + size
    );
    if (chunk.length === 0) {
      continue;
    }
    result.push({
      time: chunk[0].time,
      open: chunk[0].open,
      high: Math.max(
        ...chunk.map(
          (item) => item.high
        )
      ),
      low: Math.min(
        ...chunk.map(
          (item) => item.low
        )
      ),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce(
        (sum, item) => sum + item.volume,
        0
      )
    });
  }
  return result;
}
function requestSpec(ticker, timeframe) {
  const tf = normalizeTimeframe(timeframe);
  const baseBody = {
    stk_cd: ticker,
    /*
     * 수정주가 적용 여부입니다.
     * 1을 사용해 액면분할·병합 등이 반영된
     * 과거 가격을 받습니다.
     */
    upd_stkpc_tp: "1"
  };
  const minuteScope = {
    "1m": "1",
    "3m": "3",
    "5m": "5",
    "15m": "15",
    "30m": "30",
    "1H": "60",
    "4H": "60"
  };
  if (minuteScope[tf]) {
    return {
      apiId: "ka10080",
      path: CHART_PATH,
      body: {
        ...baseBody,
        tic_scope: minuteScope[tf]
      },
      /*
       * 키움 연속조회가 허용하는 범위까지 동일하게 따라갑니다.
       * 중복 next-key 감지와 API의 cont-yn 종료 신호가 무한 호출을 막습니다.
       */
      maxPages: 300,
      /*
       * 키움에서 4시간봉을 직접 제공하지 않으면
       * 60분봉 4개를 합쳐 4시간봉으로 만듭니다.
       */
      aggregateSize: tf === "4H" ? 4 : 1
    };
  }
  if (tf === "1M") {
    return {
      apiId: "ka10083",
      path: CHART_PATH,
      body: {
        ...baseBody,
        base_dt: koreaToday()
      },
      maxPages: 100
    };
  }
  if (tf === "1Y") {
    return {
      apiId: "ka10094",
      path: CHART_PATH,
      body: {
        ...baseBody,
        base_dt: koreaToday()
      },
      maxPages: 60
    };
  }
  const aggregateSize = tf === "3D" ? 3 : tf === "5D" ? 5 : tf === "10D" ? 10 : 1;
  return {
    apiId: "ka10081",
    path: CHART_PATH,
    body: {
      ...baseBody,
      base_dt: koreaToday()
    },
    /*
     * 상장일부터 현재까지 조회하기 위해
     * cont-yn과 next-key로 최대 300페이지를
     * 연속 조회합니다.
     */
    maxPages: 300,
    aggregateSize
  };
}
async function fetchAllPages(spec) {
  const collected = [];
  const seenNextKeys = /* @__PURE__ */ new Set();
  let contYn;
  let nextKey;
  for (let page = 0; page < spec.maxPages; page += 1) {
    const response = await kiwoomRequest({
      apiId: spec.apiId,
      path: spec.path,
      body: spec.body,
      contYn,
      nextKey
    });
    const rows = bestChartRows(
      response.data
    );
    const normalizedRows = rows.map(normalizeRow).filter(
      (item) => item != null
    );
    collected.push(
      ...normalizedRows
    );
    const hasNext = String(
      response.contYn ?? ""
    ).toUpperCase() === "Y";
    const returnedNextKey = String(
      response.nextKey ?? ""
    ).trim();
    if (!hasNext || !returnedNextKey) {
      break;
    }
    if (seenNextKeys.has(
      returnedNextKey
    )) {
      break;
    }
    seenNextKeys.add(
      returnedNextKey
    );
    contYn = response.contYn ?? "Y";
    nextKey = returnedNextKey;
    await sleep2(
      CONTINUATION_DELAY_MS
    );
  }
  return dedupeAndSort(
    collected
  );
}
async function getKiwoomChartCandles(tickerValue, timeframeValue = "1D") {
  if (!isKiwoomConfigured()) {
    throw new Error(
      "\uD0A4\uC6C0 API \uD0A4\uAC00 \uB4F1\uB85D\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4."
    );
  }
  const ticker = normalizeTicker(tickerValue);
  if (!/^[0-9A-Z]{6}(?:_(?:NX|AL))?$/.test(
    ticker
  )) {
    throw new Error(
      `\uC798\uBABB\uB41C \uAD6D\uB0B4 \uC885\uBAA9\uCF54\uB4DC\uC785\uB2C8\uB2E4: ${ticker}`
    );
  }
  const timeframe = normalizeTimeframe(
    timeframeValue
  );
  const spec = requestSpec(
    ticker,
    timeframe
  );
  const rows = await fetchAllPages(spec);
  const aggregated = aggregateCandles(
    rows,
    spec.aggregateSize ?? 1
  );
  if (aggregated.length < 2) {
    throw new Error(
      `\uD0A4\uC6C0 \uCC28\uD2B8 \uB370\uC774\uD130\uAC00 \uBD80\uC871\uD569\uB2C8\uB2E4. ticker=${ticker}, timeframe=${timeframe}, count=${aggregated.length}`
    );
  }
  return aggregated;
}

// src/services/market-data.service.ts
function candleCacheDirectory() {
  const configured = process.env.KIWOOM_CHART_CACHE_DIR?.trim();
  if (configured) return path.resolve(configured);
  const cwd = process.cwd();
  const apiRoot = path.basename(cwd) === "api-server" ? cwd : path.join(cwd, "api-server");
  return path.join(apiRoot, "data", "chart-cache");
}
function candleCachePath(ticker, timeframe) {
  const safeTicker = cleanTicker3(ticker).replace(/[^0-9A-Z_-]/g, "");
  const safeTimeframe = String(timeframe).replace(/[^0-9A-Z]/gi, "");
  return path.join(candleCacheDirectory(), `${safeTicker}-${safeTimeframe}.json`);
}
function candleCacheTtl(timeframe) {
  return /m|H/.test(timeframe) ? 2 * 60 * 1e3 : 12 * 60 * 60 * 1e3;
}
async function readCandleDiskCache(ticker, timeframe) {
  try {
    const raw = await readFile(candleCachePath(ticker, timeframe), "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.candles) || parsed.candles.length < 2) return null;
    return {
      candles: parsed.candles,
      fresh: Date.now() - Number(parsed.savedAt ?? 0) <= candleCacheTtl(timeframe)
    };
  } catch {
    return null;
  }
}
async function writeCandleDiskCache(ticker, timeframe, candles) {
  if (candles.length < 2) return;
  try {
    await mkdir(candleCacheDirectory(), { recursive: true });
    const payload = {
      savedAt: Date.now(),
      ticker: cleanTicker3(ticker),
      timeframe,
      candles
    };
    await writeFile(
      candleCachePath(ticker, timeframe),
      JSON.stringify(payload),
      "utf8"
    );
  } catch (error) {
    console.warn("chart disk cache write failed:", error);
  }
}
function aggregateCachedCandles(rows, size) {
  if (size <= 1 || rows.length <= 1) return rows;
  const result = [];
  for (let index = 0; index < rows.length; index += size) {
    const chunk = rows.slice(index, index + size);
    if (chunk.length === 0) continue;
    result.push({
      time: chunk[0].time,
      open: chunk[0].open,
      high: Math.max(...chunk.map((item) => item.high)),
      low: Math.min(...chunk.map((item) => item.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((sum, item) => sum + item.volume, 0)
    });
  }
  return result;
}
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
    assetType: classifyAssetType(String(entry.name ?? ticker), marketValue, String(entry.assetType ?? "")),
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
function ratingFromQuote(quote, entry) {
  try {
    const scores = computeScores({
      quote,
      entry
    });
    if (typeof scores === "number") {
      return scoreToRating(scores);
    }
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
function toQuoteRow(entry, quote) {
  const ticker = cleanTicker3(entry.ticker);
  const marketValue = normalizeMarketValue(
    entry.market,
    ticker
  );
  const currency = normalizeCurrencyValue(
    entry.currency,
    marketValue
  );
  const price = quotePrice(quote);
  const previousClose = quotePreviousClose(quote, price);
  const changeAmount = quoteChangeAmount(
    quote,
    price,
    previousClose
  );
  const changePercent = quoteChangePercent(
    quote,
    price,
    previousClose,
    changeAmount
  );
  const volume = safeNumber3(quote.volume, 0);
  const tradingValue = safeNumber3(quote.tradingValue, 0) || Math.max(price * volume, 0);
  return {
    ticker,
    name: String(
      entry.name ?? quote.name ?? ticker
    ),
    market: String(marketValue),
    currency: String(currency),
    assetType: classifyAssetType(String(entry.name ?? ticker), marketValue, String(entry.assetType ?? "")),
    price,
    changeAmount,
    changePercent,
    volume,
    tradingValue,
    high: safeNumber3(quote.high, 0),
    low: safeNumber3(quote.low, 0),
    open: safeNumber3(quote.open, 0),
    previousClose,
    updatedAt: String(
      quote.updatedAt ?? (/* @__PURE__ */ new Date()).toISOString()
    ),
    rating: ratingFromQuote(quote, entry)
  };
}
async function tryQuoteProvider(entry) {
  const providers = providerStatus();
  const marketValue = normalizeMarketValue(
    entry.market,
    entry.ticker
  );
  const attempts = [];
  if (marketValue === "KR") {
    attempts.push(() => getQuote3(entry));
    attempts.push(() => getQuote2(entry));
  } else {
    attempts.push(() => getQuote2(entry));
    if (providers.finnhub) attempts.push(() => getQuote4(entry));
  }
  for (const attempt of attempts) {
    try {
      const result = await attempt();
      if (!result || typeof result !== "object") continue;
      const quote = result;
      const price = quotePrice(quote);
      if (price > 0 || quote.changePercent != null || quote.volume != null) {
        return quote;
      }
    } catch {
    }
  }
  return null;
}
async function tryCandlesProvider(entry, timeframe) {
  const ticker = cleanTicker3(
    entry.ticker
  );
  const marketValue = normalizeMarketValue(
    entry.market,
    ticker
  );
  const timeframeText = String(
    timeframe ?? "1D"
  );
  const minimumUsefulCandles = ["1D", "3D", "5D", "10D", "ALL"].includes(timeframeText) ? 30 : 2;
  if (marketValue === "KR") {
    try {
      const kiwoomRows = await getKiwoomChartCandles(
        ticker,
        timeframeText
      );
      if (kiwoomRows.length >= minimumUsefulCandles) {
        return kiwoomRows;
      }
    } catch (error) {
      console.error(
        `kiwoom chart provider failed: ticker=${ticker}, timeframe=${timeframeText}`,
        error
      );
    }
  }
  const attempts = marketValue === "KR" ? [
    () => getCandles3(entry),
    () => getCandles2(entry)
  ] : [() => getCandles2(entry)];
  for (const attempt of attempts) {
    try {
      const result = await attempt();
      if (Array.isArray(result) && result.length >= minimumUsefulCandles) {
        return result;
      }
    } catch {
    }
  }
  return [];
}
async function tryProfileProvider(entry) {
  const attempts = [
    () => getProfile(entry),
    () => getCompanyProfile(entry),
    () => getCompanyProfile2(entry)
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
    ticker: cleanTicker3(
      entry.ticker
    ),
    name: String(
      entry.name ?? entry.ticker
    ),
    market: String(
      entry.market ?? ""
    ),
    currency: String(
      entry.currency ?? ""
    ),
    description: "\uAE30\uC5C5 \uC815\uBCF4\uB97C \uD655\uC778 \uC911\uC785\uB2C8\uB2E4.",
    sector: "",
    industry: "",
    country: String(entry.market === "KR" ? "\uB300\uD55C\uBBFC\uAD6D" : "\uBBF8\uAD6D"),
    mainBusiness: "",
    competitors: []
  };
}
async function buildKrUniverseEntries() {
  try {
    const rows = await getKrUniverse();
    if (!Array.isArray(rows)) {
      return [];
    }
    return rows.map((row) => {
      const ticker = cleanTicker3(
        row.ticker ?? row.code ?? row.symbol
      );
      const name = String(
        row.name ?? row.companyName ?? ticker
      );
      if (!ticker) {
        return null;
      }
      return createEntry(
        ticker,
        name,
        "KR",
        "KRW",
        [name]
      );
    }).filter(
      (entry) => Boolean(entry)
    );
  } catch {
    return [];
  }
}
var MarketDataService = class {
  static async search(q, limit = 80) {
    const query = String(
      q ?? ""
    ).trim();
    const aliasEntries = Object.entries(
      EXTRA_ALIASES
    ).map(
      ([
        ,
        value
      ]) => createEntry(
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
        registerDynamicEntry(
          entry
        );
      } catch {
      }
    }
    const scored = entries.map((entry) => ({
      entry,
      score: searchScore(
        entry,
        query
      )
    })).filter(
      (item) => query ? item.score > 0 : true
    ).sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return String(
        a.entry.ticker
      ).localeCompare(
        String(
          b.entry.ticker
        )
      );
    }).slice(
      0,
      limit
    ).map(
      (item) => toSearchResult(
        item.entry
      )
    );
    return scored;
  }
  static async getQuote(ticker) {
    const entry = resolveEntry(
      ticker
    );
    return cached(
      `quote:${cleanTicker3(ticker)}`,
      TTL.quote,
      async () => {
        const providerQuote = await tryQuoteProvider(
          entry
        );
        if (!providerQuote) {
          throw new Error(`QUOTE_UNAVAILABLE:${cleanTicker3(ticker)}`);
        }
        const quote = providerQuote;
        return {
          ...quote,
          ticker: cleanTicker3(
            entry.ticker
          ),
          name: String(
            entry.name ?? entry.ticker
          )
        };
      }
    );
  }
  static async getQuoteRow(ticker) {
    const entry = resolveEntry(
      ticker
    );
    try {
      const quote = await this.getQuote(
        ticker
      );
      return toQuoteRow(
        entry,
        quote
      );
    } catch {
      return null;
    }
  }
  static async getQuotes(tickers) {
    const rows = await Promise.all(
      tickers.map(
        (ticker) => this.getQuoteRow(
          ticker
        )
      )
    );
    return rows.filter(
      (row) => Boolean(row)
    );
  }
  static async getCandles(ticker, timeframe = "1D") {
    const entry = resolveEntry(
      ticker
    );
    const timeframeText = String(timeframe);
    const cacheKey = `candles:${cleanTicker3(ticker)}:${timeframeText}`;
    const disk = await readCandleDiskCache(ticker, timeframeText);
    if (disk?.fresh) return disk.candles;
    const aggregateDays = {
      "3D": 3,
      "5D": 5,
      "10D": 10
    }[timeframeText];
    if (!disk && aggregateDays) {
      const dailyDisk = await readCandleDiskCache(ticker, "1D");
      if (dailyDisk?.candles.length) {
        const aggregated = aggregateCachedCandles(dailyDisk.candles, aggregateDays);
        await writeCandleDiskCache(ticker, timeframeText, aggregated);
        return aggregated;
      }
    }
    const load = async () => {
      const rows = await tryCandlesProvider(entry, timeframe);
      await writeCandleDiskCache(ticker, timeframeText, rows);
      return rows;
    };
    if (disk?.candles.length) {
      void cached(cacheKey, candleCacheTtl(timeframeText), load).catch((error) => {
        console.error("chart background refresh failed:", error);
      });
      return disk.candles;
    }
    return cached(cacheKey, candleCacheTtl(timeframeText), load);
  }
  static async getCompanyProfile(ticker) {
    const entry = resolveEntry(
      ticker
    );
    return cached(
      `company:${cleanTicker3(ticker)}`,
      TTL.profile ?? TTL.quote,
      async () => tryProfileProvider(
        entry
      )
    );
  }
  static async getProfile(ticker) {
    return this.getCompanyProfile(
      ticker
    );
  }
  static async getRating(ticker) {
    const quote = await this.getQuoteRow(
      ticker
    );
    return quote?.rating ?? defaultRating();
  }
  static async getCatalogEntry(ticker) {
    return resolveEntry(
      ticker
    );
  }
  static async getUniverse(marketValue) {
    const entries = dedupeEntries([
      ...catalogArray(),
      ...await buildKrUniverseEntries()
    ]);
    const filtered = entries.filter(
      (entry) => {
        if (!marketValue || marketValue === "ALL") {
          return true;
        }
        const ticker = cleanTicker3(
          entry.ticker
        );
        const entryMarket = normalizeMarketValue(
          entry.market,
          ticker
        );
        return String(
          entryMarket
        ) === marketValue;
      }
    );
    return filtered.map(
      toSearchResult
    );
  }
};

// src/providers/us-universe.ts
var BASE2 = "https://finnhub.io/api/v1";
var CACHE_MS = 12 * 60 * 60 * 1e3;
var cache = null;
function finnhubKey() {
  return process.env.FINNHUB_API_KEY ?? process.env.VITE_FINNHUB_API_KEY ?? process.env.FINNHUB_KEY ?? "";
}
function normalizeExchange(mic) {
  const v = (mic ?? "").toUpperCase();
  if (v === "XNAS" || v === "XNMS" || v === "XNCM" || v === "XNGS") {
    return "NASDAQ";
  }
  if (v === "XNYS") {
    return "NYSE";
  }
  if (v === "XASE" || v === "ARCX" || v === "BATS" || v === "AMEX") {
    return "AMEX";
  }
  return "US";
}
function cleanTicker4(symbol) {
  return (symbol ?? "").trim().toUpperCase();
}
function cleanName(row) {
  return row.description?.trim() || row.displaySymbol?.trim() || row.symbol?.trim() || "";
}
function isProbablyTradableSymbol(ticker) {
  if (!ticker) return false;
  if (ticker.length > 8) return false;
  if (ticker.includes(".")) return false;
  if (ticker.includes("/")) return false;
  if (ticker.includes(" ")) return false;
  return /^[A-Z]+$/.test(ticker);
}
function detectAssetType(row) {
  const name = cleanName(row);
  const rawType = (row.type ?? "").toLowerCase();
  const merged = `${name} ${rawType}`.toLowerCase();
  if (merged.includes("etn")) {
    if (isLeveragedName(merged)) return "LEVERAGED_ETN";
    if (isInverseName(merged)) return "INVERSE_ETN";
    return "ETN";
  }
  if (merged.includes("etf") || merged.includes("etp") || merged.includes("fund")) {
    if (isLeveragedName(merged)) return "LEVERAGED_ETF";
    if (isInverseName(merged)) return "INVERSE_ETF";
    return "ETF";
  }
  if (merged.includes("adr")) return "ADR";
  if (merged.includes("reit")) return "REIT";
  return classifyAssetType(name, "US");
}
function isLeveragedName(v) {
  return v.includes("2x") || v.includes("3x") || v.includes("bull") || v.includes("ultra") || v.includes("leveraged");
}
function isInverseName(v) {
  return v.includes("inverse") || v.includes("short") || v.includes("bear");
}
function allowedAssetType(assetType) {
  return assetType === "STOCK" || assetType === "ADR" || assetType === "REIT" || assetType === "ETF" || assetType === "ETN" || assetType === "LEVERAGED_ETF" || assetType === "INVERSE_ETF" || assetType === "LEVERAGED_ETN" || assetType === "INVERSE_ETN";
}
async function getUsUniverse() {
  if (cache && Date.now() - cache.at < CACHE_MS) {
    return cache.rows;
  }
  const token = finnhubKey();
  if (!token) {
    console.error("[us-universe] Missing FINNHUB_API_KEY");
    return [];
  }
  const url = `${BASE2}/stock/symbol?exchange=US&token=${encodeURIComponent(
    token
  )}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error("[us-universe] Finnhub failed:", res.status, res.statusText);
    return [];
  }
  const json = await res.json();
  if (!Array.isArray(json)) {
    return [];
  }
  const seen = /* @__PURE__ */ new Set();
  const rows = [];
  for (const row of json) {
    const ticker = cleanTicker4(row.symbol);
    if (!isProbablyTradableSymbol(ticker)) continue;
    if (seen.has(ticker)) continue;
    const name = cleanName(row);
    if (!name) continue;
    const assetType = detectAssetType(row);
    if (!allowedAssetType(assetType)) continue;
    seen.add(ticker);
    rows.push({
      ticker,
      name,
      market: "US",
      currency: "USD",
      assetType,
      exchange: normalizeExchange(row.mic),
      rawType: row.type ?? ""
    });
  }
  rows.sort((a, b) => {
    const ex = a.exchange.localeCompare(b.exchange);
    if (ex !== 0) return ex;
    return a.ticker.localeCompare(b.ticker);
  });
  cache = {
    at: Date.now(),
    rows
  };
  console.log("[us-universe] loaded:", rows.length);
  return rows;
}

// src/providers/sec-edgar.ts
var HEADERS = {
  "User-Agent": SEC_USER_AGENT,
  Accept: "application/json",
  "Accept-Encoding": "gzip, deflate"
};
async function getCikByTicker(ticker) {
  const map = await cached("sec:tickermap", TTL.mapping, async () => {
    const data = await fetchJson3(
      "https://www.sec.gov/files/company_tickers.json",
      { provider: "sec-edgar", headers: HEADERS }
    );
    const byTicker = /* @__PURE__ */ new Map();
    for (const key of Object.keys(data)) {
      const entry = data[key];
      byTicker.set(
        entry.ticker.toUpperCase(),
        String(entry.cik_str).padStart(10, "0")
      );
    }
    return byTicker;
  });
  const cik = map.get(ticker.toUpperCase());
  if (!cik) {
    throw new ProviderError("UNAVAILABLE", "sec-edgar", `no CIK for ${ticker}`);
  }
  return cik;
}
function edgarDocUrl(cik, accession, primaryDoc) {
  if (!accession) return "";
  const cikNum = String(Number(cik));
  const acc = accession.replace(/-/g, "");
  if (primaryDoc) {
    return `https://www.sec.gov/Archives/edgar/data/${cikNum}/${acc}/${primaryDoc}`;
  }
  return `https://www.sec.gov/Archives/edgar/data/${cikNum}/${acc}/`;
}
async function getFilings(ticker, limit = 20) {
  const cik = await getCikByTicker(ticker);
  return cached(`sec:filinglist:${cik}`, TTL.risk, async () => {
    const data = await fetchJson3(
      `https://data.sec.gov/submissions/CIK${cik}.json`,
      { provider: "sec-edgar", headers: HEADERS }
    );
    const recent = data.filings?.recent;
    const forms = recent?.form ?? [];
    const dates = recent?.filingDate ?? [];
    const accessions = recent?.accessionNumber ?? [];
    const docs = recent?.primaryDocument ?? [];
    const descs = recent?.primaryDocDescription ?? [];
    const out = [];
    for (let i = 0; i < forms.length && out.length < limit; i++) {
      const form = forms[i] ?? "";
      if (!form) continue;
      out.push({
        form,
        date: dates[i] ?? "",
        description: descs[i] ?? "",
        url: edgarDocUrl(cik, accessions[i] ?? "", docs[i] ?? "")
      });
    }
    return out;
  });
}
var CAPITAL_TAGS = [
  "CommonStockValue",
  "CommonStocksIncludingAdditionalPaidInCapital"
];
function daysBetween(a, b) {
  return Math.abs(
    (new Date(b).getTime() - new Date(a).getTime()) / 864e5
  );
}
async function concept(cik, tag) {
  try {
    const data = await fetchJson3(
      `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/${tag}.json`,
      { provider: "sec-edgar", headers: HEADERS }
    );
    const units = data.units ?? {};
    const key = Object.keys(units)[0];
    return key ? units[key] : [];
  } catch {
    return [];
  }
}
async function firstConcept(cik, tags) {
  for (const t of tags) {
    const pts = await concept(cik, t);
    if (pts.length) return pts;
  }
  return [];
}
function annualFlow(pts) {
  const byYear = /* @__PURE__ */ new Map();
  for (const p of pts) {
    if (p.form !== "10-K" || !p.start) continue;
    const dur = daysBetween(p.start, p.end);
    if (dur < 300 || dur > 400) continue;
    byYear.set(p.end.slice(0, 4), p.val);
  }
  return byYear;
}
function instantByYear(pts) {
  const byYear = /* @__PURE__ */ new Map();
  for (const p of [...pts].sort((a, b) => a.end.localeCompare(b.end))) {
    if (p.start) continue;
    if (p.form !== "10-K" && p.form !== "10-Q") continue;
    byYear.set(p.end.slice(0, 4), p.val);
  }
  return byYear;
}
function quarterlyFlow(pts) {
  const m = /* @__PURE__ */ new Map();
  for (const p of pts) {
    if (!p.start) continue;
    if (p.form !== "10-Q" && p.form !== "10-K") continue;
    const dur = daysBetween(p.start, p.end);
    if (dur < 80 || dur > 100) continue;
    m.set(p.end, p.val);
  }
  return [...m.entries()].map(([end, val]) => ({ end, val })).sort((a, b) => a.end.localeCompare(b.end));
}
function instantAt(pts, end) {
  const exact = pts.find((p) => !p.start && p.end === end);
  return exact ? exact.val : 0;
}
var REVENUE_TAGS = [
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "Revenues",
  "SalesRevenueNet"
];
async function getFinancials2(ticker) {
  const cik = await getCikByTicker(ticker);
  return cached(`sec:financials:${cik}`, TTL.financials, async () => {
    const [rev, op, net, cash, liab, equity, capital] = await Promise.all([
      firstConcept(cik, REVENUE_TAGS),
      concept(cik, "OperatingIncomeLoss"),
      concept(cik, "NetIncomeLoss"),
      firstConcept(cik, [
        "CashAndCashEquivalentsAtCarryingValue",
        "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"
      ]),
      concept(cik, "Liabilities"),
      concept(cik, "StockholdersEquity"),
      firstConcept(cik, CAPITAL_TAGS)
    ]);
    const revA = annualFlow(rev);
    const opA = annualFlow(op);
    const netA = annualFlow(net);
    const cashA = instantByYear(cash);
    const liabA = instantByYear(liab);
    const equityA = instantByYear(equity);
    const capitalA = instantByYear(capital);
    const years = [.../* @__PURE__ */ new Set([...revA.keys(), ...netA.keys()])].sort().slice(-5);
    const annual = years.map((y) => {
      const row = {
        period: y,
        revenue: revA.get(y) ?? 0,
        operatingIncome: opA.get(y) ?? 0,
        netIncome: netA.get(y) ?? 0,
        cash: cashA.get(y) ?? 0,
        debt: liabA.get(y) ?? 0
      };
      const eq = equityA.get(y);
      if (eq != null) row.equity = eq;
      const cap = capitalA.get(y);
      if (cap != null) row.capital = cap;
      return row;
    });
    if (annual.length < 2) {
      throw new ProviderError("UNAVAILABLE", "sec-edgar", `sparse XBRL for ${ticker}`);
    }
    const revQarr = quarterlyFlow(rev);
    const netQarr = quarterlyFlow(net);
    const anchor = revQarr.length ? revQarr : netQarr;
    const revQ = new Map(revQarr.map((q) => [q.end, q.val]));
    const opQ = new Map(quarterlyFlow(op).map((q) => [q.end, q.val]));
    const netQ = new Map(netQarr.map((q) => [q.end, q.val]));
    const quarterly = anchor.slice(-4).map((q) => ({
      period: q.end.slice(0, 7),
      revenue: revQ.get(q.end) ?? 0,
      operatingIncome: opQ.get(q.end) ?? 0,
      netIncome: netQ.get(q.end) ?? 0,
      cash: instantAt(cash, q.end),
      debt: instantAt(liab, q.end)
    }));
    const latestYear = years[years.length - 1];
    return {
      annual,
      quarterly,
      latest: {
        equity: latestYear ? equityA.get(latestYear) ?? 0 : 0,
        liabilities: latestYear ? liabA.get(latestYear) ?? 0 : 0,
        netIncome: latestYear ? netA.get(latestYear) ?? 0 : 0,
        cash: latestYear ? cashA.get(latestYear) ?? 0 : 0
      }
    };
  });
}

// src/providers/dart.ts
import { promises as fs } from "node:fs";
import path2 from "node:path";
import os from "node:os";
import AdmZip from "adm-zip";
var BASE3 = "https://opendart.fss.or.kr/api";
var CORPMAP_DISK = path2.join(os.tmpdir(), "dart-corpmap.json");
var CORPMAP_DISK_TTL = 7 * 24 * 60 * 60 * 1e3;
var CORPMAP_DOWNLOAD_TIMEOUT = 6e4;
var corpMapMem = null;
var corpMapInflight = null;
async function loadCorpMapFromDisk() {
  try {
    const stat = await fs.stat(CORPMAP_DISK);
    const raw = await fs.readFile(CORPMAP_DISK, "utf-8");
    const obj = JSON.parse(raw);
    const map = new Map(Object.entries(obj));
    if (map.size === 0) return null;
    return { map, mtime: stat.mtimeMs };
  } catch {
    return null;
  }
}
async function downloadCorpMap() {
  const key = getDartKey();
  const buf = await fetchBuffer(`${BASE3}/corpCode.xml?crtfc_key=${key}`, {
    provider: "dart",
    timeoutMs: CORPMAP_DOWNLOAD_TIMEOUT
  });
  let xml;
  try {
    const zip = new AdmZip(buf);
    const entry = zip.getEntries().find((e) => e.entryName.endsWith(".xml"));
    if (!entry) throw new Error("no xml in zip");
    xml = entry.getData().toString("utf-8");
  } catch {
    throw new ProviderError("UPSTREAM_ERROR", "dart", "corpCode parse failed");
  }
  const byStock = /* @__PURE__ */ new Map();
  const re = /<list>[\s\S]*?<corp_code>(\d+)<\/corp_code>[\s\S]*?<stock_code>\s*(\d{6})\s*<\/stock_code>[\s\S]*?<\/list>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    byStock.set(m[2], m[1]);
  }
  if (byStock.size === 0) {
    throw new ProviderError("UPSTREAM_ERROR", "dart", "empty corp map");
  }
  try {
    const tmp = `${CORPMAP_DISK}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(Object.fromEntries(byStock)), "utf-8");
    await fs.rename(tmp, CORPMAP_DISK);
  } catch {
  }
  return byStock;
}
async function getCorpMap() {
  const now = Date.now();
  if (corpMapMem && corpMapMem.expires > now) return corpMapMem.map;
  if (corpMapInflight) return corpMapInflight;
  corpMapInflight = (async () => {
    const disk = await loadCorpMapFromDisk();
    if (disk && now - disk.mtime < CORPMAP_DISK_TTL) {
      corpMapMem = { map: disk.map, expires: now + TTL.mapping };
      return disk.map;
    }
    try {
      const map = await downloadCorpMap();
      corpMapMem = { map, expires: now + TTL.mapping };
      return map;
    } catch (err) {
      if (disk) {
        corpMapMem = { map: disk.map, expires: now + 60 * 60 * 1e3 };
        return disk.map;
      }
      throw err;
    }
  })().finally(() => {
    corpMapInflight = null;
  });
  return corpMapInflight;
}
async function getCorpCode(stockCode) {
  const map = await getCorpMap();
  const corp = map.get(stockCode);
  if (!corp) {
    throw new ProviderError("UNAVAILABLE", "dart", `no corp_code for ${stockCode}`);
  }
  return corp;
}
function ymd2(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}
function dartDocUrl(rceptNo) {
  return `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${rceptNo}`;
}
async function getDisclosures(stockCode) {
  const key = getDartKey();
  const corp = await getCorpCode(stockCode);
  return cached(`dart:list:${corp}`, TTL.risk, async () => {
    const end = /* @__PURE__ */ new Date();
    const begin = new Date(end.getTime() - 365 * 24 * 60 * 60 * 1e3);
    const data = await fetchJson3(
      `${BASE3}/list.json?crtfc_key=${key}&corp_code=${corp}&bgn_de=${ymd2(
        begin
      )}&end_de=${ymd2(end)}&page_count=100`,
      { provider: "dart" }
    );
    if (data.status === "013") return [];
    if (data.status !== "000") {
      if (data.status === "020") throw new ProviderError("RATE_LIMITED", "dart");
      throw new ProviderError("UPSTREAM_ERROR", "dart", data.message);
    }
    return (data.list ?? []).map((d) => ({
      reportName: d.report_nm,
      filer: d.flr_nm,
      date: d.rcept_dt,
      rceptNo: d.rcept_no,
      url: dartDocUrl(d.rcept_no)
    }));
  });
}
function parseAmt(v) {
  if (!v) return 0;
  const neg = /[-△()]/.test(v);
  const n = Number(v.replace(/[^\d]/g, ""));
  if (!Number.isFinite(n)) return 0;
  return neg ? -n : n;
}
function selectRows(list) {
  const useCfs = list.some((r) => r.fs_div === "CFS");
  return list.filter((r) => useCfs ? r.fs_div === "CFS" : r.fs_div === "OFS");
}
function pickAmt(rows, names, field) {
  const r = rows.find(
    (x) => names.includes((x.account_nm ?? "").replace(/\s/g, ""))
  );
  return parseAmt(r?.[field]);
}
var ACC = {
  revenue: ["\uB9E4\uCD9C\uC561", "\uC218\uC775(\uB9E4\uCD9C\uC561)", "\uC601\uC5C5\uC218\uC775", "\uB9E4\uCD9C"],
  operating: ["\uC601\uC5C5\uC774\uC775", "\uC601\uC5C5\uC774\uC775(\uC190\uC2E4)"],
  net: ["\uB2F9\uAE30\uC21C\uC774\uC775", "\uB2F9\uAE30\uC21C\uC774\uC775(\uC190\uC2E4)"],
  cash: ["\uD604\uAE08\uBC0F\uD604\uAE08\uC131\uC790\uC0B0"],
  liabilities: ["\uBD80\uCC44\uCD1D\uACC4"],
  equity: ["\uC790\uBCF8\uCD1D\uACC4"],
  capital: ["\uC790\uBCF8\uAE08"]
};
async function fetchAcnt(key, corp, year, reprt) {
  const data = await fetchJson3(
    `${BASE3}/fnlttSinglAcnt.json?crtfc_key=${key}&corp_code=${corp}&bsns_year=${year}&reprt_code=${reprt}`,
    { provider: "dart" }
  );
  if (data.status === "000" && data.list && data.list.length) return data.list;
  if (data.status === "020") throw new ProviderError("RATE_LIMITED", "dart");
  return null;
}
async function getFinancials3(stockCode) {
  const key = getDartKey();
  const corp = await getCorpCode(stockCode);
  return cached(`dart:fin:${corp}`, TTL.financials, async () => {
    const now = /* @__PURE__ */ new Date();
    let annualList = null;
    let baseYear = 0;
    for (const y of [now.getFullYear() - 1, now.getFullYear() - 2]) {
      annualList = await fetchAcnt(key, corp, y, "11011");
      if (annualList) {
        baseYear = y;
        break;
      }
    }
    if (!annualList) {
      throw new ProviderError("UNAVAILABLE", "dart", `no financials for ${stockCode}`);
    }
    const annualRows = selectRows(annualList);
    const fields = [
      ["bfefrmtrm_amount", baseYear - 2],
      ["frmtrm_amount", baseYear - 1],
      ["thstrm_amount", baseYear]
    ];
    const annual = fields.map(([field, year]) => {
      const row = {
        period: String(year),
        revenue: pickAmt(annualRows, ACC.revenue, field),
        operatingIncome: pickAmt(annualRows, ACC.operating, field),
        netIncome: pickAmt(annualRows, ACC.net, field),
        cash: pickAmt(annualRows, ACC.cash, field),
        debt: pickAmt(annualRows, ACC.liabilities, field)
      };
      const eq = pickAmt(annualRows, ACC.equity, field);
      if (eq !== 0) row.equity = eq;
      const cap = pickAmt(annualRows, ACC.capital, field);
      if (cap !== 0) row.capital = cap;
      return row;
    }).filter((r, i) => i === fields.length - 1 || r.revenue !== 0 || r.netIncome !== 0);
    if (annual.length < 2) {
      throw new ProviderError("UNAVAILABLE", "dart", `sparse financials for ${stockCode}`);
    }
    let quarterly = [];
    try {
      const [q1l, q2l, q3l] = await Promise.all([
        fetchAcnt(key, corp, baseYear, "11013"),
        fetchAcnt(key, corp, baseYear, "11012"),
        fetchAcnt(key, corp, baseYear, "11014")
      ]);
      const quarterRow = (list, period) => {
        if (!list) return null;
        const rows = selectRows(list);
        return {
          period,
          revenue: pickAmt(rows, ACC.revenue, "thstrm_amount"),
          operatingIncome: pickAmt(rows, ACC.operating, "thstrm_amount"),
          netIncome: pickAmt(rows, ACC.net, "thstrm_amount"),
          cash: pickAmt(rows, ACC.cash, "thstrm_amount"),
          debt: pickAmt(rows, ACC.liabilities, "thstrm_amount")
        };
      };
      const built = [
        quarterRow(q1l, `${baseYear}Q1`),
        quarterRow(q2l, `${baseYear}Q2`),
        quarterRow(q3l, `${baseYear}Q3`)
      ];
      if (q3l) {
        const q3rows = selectRows(q3l);
        const cum9Rev = pickAmt(q3rows, ACC.revenue, "thstrm_add_amount");
        if (cum9Rev > 0) {
          built.push({
            period: `${baseYear}Q4`,
            revenue: pickAmt(annualRows, ACC.revenue, "thstrm_amount") - cum9Rev,
            operatingIncome: pickAmt(annualRows, ACC.operating, "thstrm_amount") - pickAmt(q3rows, ACC.operating, "thstrm_add_amount"),
            netIncome: pickAmt(annualRows, ACC.net, "thstrm_amount") - pickAmt(q3rows, ACC.net, "thstrm_add_amount"),
            cash: pickAmt(annualRows, ACC.cash, "thstrm_amount"),
            debt: pickAmt(annualRows, ACC.liabilities, "thstrm_amount")
          });
        }
      }
      quarterly = built.filter((r) => r !== null);
      if (quarterly.some((q) => q.revenue < 0)) quarterly = [];
    } catch (err) {
      if (err instanceof ProviderError && err.code === "RATE_LIMITED") throw err;
      quarterly = [];
    }
    return {
      annual,
      quarterly,
      latest: {
        equity: pickAmt(annualRows, ACC.equity, "thstrm_amount"),
        liabilities: pickAmt(annualRows, ACC.liabilities, "thstrm_amount"),
        netIncome: pickAmt(annualRows, ACC.net, "thstrm_amount"),
        cash: pickAmt(annualRows, ACC.cash, "thstrm_amount")
      }
    };
  });
}

// src/services/financial.service.ts
function yoy(rows, key) {
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1][key];
    const cur = rows[i][key];
    out.push(prev ? Math.round((cur - prev) / Math.abs(prev) * 1e3) / 10 : 0);
  }
  return out;
}
function buildCashBurn(raw) {
  const cashBalance = raw.latest.cash;
  const q = raw.quarterly;
  const quarterlyBurn = q.length ? q[q.length - 1].netIncome : Math.round(raw.latest.netIncome / 4);
  const survivalQuarters = quarterlyBurn >= 0 ? null : Math.max(0, Math.round(cashBalance / Math.abs(quarterlyBurn)));
  return { cashBalance, quarterlyBurn, survivalQuarters };
}
function buildHealth(r) {
  let score = 50;
  if (r.roe >= 15) score += 20;
  else if (r.roe >= 5) score += 8;
  else if (r.roe < 0) score -= 20;
  if (r.debtRatio <= 80) score += 15;
  else if (r.debtRatio > 200) score -= 15;
  if (r.per > 0 && r.per < 30) score += 5;
  const confidence = Math.max(10, Math.min(95, score));
  const level = confidence >= 66 ? "STRONG" : confidence >= 40 ? "AVERAGE" : "WEAK";
  return { level, confidence };
}
function assemble(raw, ratios) {
  return {
    quarterly: raw.quarterly,
    annual: raw.annual,
    ratios,
    growth: {
      revenue: yoy(raw.annual, "revenue"),
      profit: yoy(raw.annual, "netIncome")
    },
    cashBurn: buildCashBurn(raw),
    health: buildHealth(ratios)
  };
}
async function getLive(entry) {
  if (entry.market === "KR") {
    const [raw2, kr] = await Promise.all([
      getFinancials3(entry.ticker),
      getRatios(entry).catch(() => ({ eps: 0, per: 0, pbr: 0, bps: 0 }))
    ]);
    if (raw2.quarterly.length === 0) {
      throw new Error("no live KR quarterly statements");
    }
    const equity2 = raw2.latest.equity;
    const ratios2 = {
      eps: kr.eps,
      per: kr.per,
      pbr: kr.pbr,
      roe: equity2 ? Math.round(raw2.latest.netIncome / equity2 * 1e3) / 10 : 0,
      debtRatio: equity2 ? Math.round(raw2.latest.liabilities / equity2 * 1e3) / 10 : 0
    };
    return assemble(raw2, ratios2);
  }
  const [raw, us] = await Promise.all([
    getFinancials2(entry.ticker),
    getRatios2(entry).catch(() => ({ eps: 0, per: 0, pbr: 0, roe: 0, debtRatio: 0 }))
  ]);
  const equity = raw.latest.equity;
  const ratios = {
    ...us,
    roe: us.roe || !equity ? us.roe : Math.round(raw.latest.netIncome / equity * 1e3) / 10,
    debtRatio: us.debtRatio || !equity ? us.debtRatio : Math.round(raw.latest.liabilities / equity * 1e3) / 10
  };
  return assemble(raw, ratios);
}
async function getFinancials4(ticker) {
  const entry = getCatalogEntry(ticker);
  if (!entry) return null;
  try {
    return await getLive(entry);
  } catch (err) {
    console.error(`live financials failed for ${ticker}:`, err);
    return getFinancials(ticker);
  }
}
var FinancialService = {
  getFinancials: getFinancials4
};

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
function pick3(block, re) {
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
    const title = decodeXml(pick3(block, /<title>([\s\S]*?)<\/title>/));
    const url = decodeXml(pick3(block, /<link>([\s\S]*?)<\/link>/));
    const pub = pick3(block, /<pubDate>([\s\S]*?)<\/pubDate>/);
    const srcUrl = pick3(block, /<source[^>]*url="([^"]*)"/);
    const srcName = decodeXml(pick3(block, /<source[^>]*>([\s\S]*?)<\/source>/));
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

// src/lib/filing-classify.ts
var EVENT_LABEL_KO = {
  ATM: "\uD76C\uC11D \uB9AC\uC2A4\uD06C",
  OFFERING: "\uD76C\uC11D",
  REVERSE_SPLIT: "\uAC10\uC790/\uBCD1\uD569",
  CB: "\uC804\uD658\uC0AC\uCC44(CB) \uD76C\uC11D",
  BW: "\uC2E0\uC8FC\uC778\uC218\uAD8C\uBD80\uC0AC\uCC44(BW) \uD76C\uC11D",
  RIGHTS_OFFERING: "\uC720\uC0C1\uC99D\uC790 \uD76C\uC11D",
  DELISTING: "\uC0C1\uC7A5\uD3D0\uC9C0 \uC8FC\uC758",
  DIVIDEND: "\uBC30\uB2F9",
  SUPPLY_CONTRACT: "\uACF5\uAE09\uACC4\uC57D"
};
var NEGATIVE_EVENTS = [
  "ATM",
  "OFFERING",
  "REVERSE_SPLIT",
  "CB",
  "BW",
  "RIGHTS_OFFERING",
  "DELISTING"
];
var POSITIVE_EVENTS = ["DIVIDEND", "SUPPLY_CONTRACT"];
function sentimentFor(events) {
  if (events.some((e) => NEGATIVE_EVENTS.includes(e))) return "negative";
  if (events.some((e) => POSITIVE_EVENTS.includes(e))) return "positive";
  return "neutral";
}
function finalize(events) {
  const unique = [...new Set(events)];
  return {
    sentiment: sentimentFor(unique),
    events: unique,
    eventLabels: unique.map((e) => EVENT_LABEL_KO[e])
  };
}
var RISK_EVENT_LABEL_KO = {
  DELISTING: "\uC0C1\uC7A5\uD3D0\uC9C0 \uC704\uD5D8",
  TRADING_SUSPENSION: "\uAC70\uB798\uC815\uC9C0",
  DILUTION: "\uC9C0\uBD84 \uD76C\uC11D",
  CONVERTIBLE_BOND: "\uC804\uD658\uC0AC\uCC44(CB) \uD76C\uC11D",
  CAPITAL_IMPAIRMENT: "\uC790\uBCF8\uC7A0\uC2DD",
  GOING_CONCERN: "\uC874\uC18D\uB2A5\uB825 \uBD88\uD655\uC2E4\uC131",
  OTHER: "\uC8FC\uC694 \uC774\uBCA4\uD2B8"
};
function classifyRiskEvent(text) {
  const t = text.toLowerCase();
  const has = (...ws) => ws.some((w) => t.includes(w.toLowerCase()));
  if (has("\uC0C1\uC7A5\uD3D0\uC9C0", "\uAD00\uB9AC\uC885\uBAA9", "\uC0C1\uC7A5\uC801\uACA9\uC131", "delist")) return "DELISTING";
  if (has("\uAC70\uB798\uC815\uC9C0", "trading suspension", "trading halt", "halt of trading"))
    return "TRADING_SUSPENSION";
  if (has(
    "going concern",
    "\uACC4\uC18D\uAE30\uC5C5",
    "\uAC10\uC0AC\uC758\uACAC\uAC70\uC808",
    "\uAC10\uC0AC\uC758\uACAC \uAC70\uC808",
    "\uC758\uACAC\uAC70\uC808",
    "qualified opinion",
    "adverse opinion"
  ))
    return "GOING_CONCERN";
  if (has("\uC790\uBCF8\uC7A0\uC2DD", "capital impairment")) return "CAPITAL_IMPAIRMENT";
  if (has("\uC804\uD658\uC0AC\uCC44", "\uC2E0\uC8FC\uC778\uC218\uAD8C\uBD80\uC0AC\uCC44", "convertible", "warrant bond"))
    return "CONVERTIBLE_BOND";
  if (has(
    "\uC720\uC0C1\uC99D\uC790",
    "\uC8FC\uC8FC\uBC30\uC815",
    "\uC81C3\uC790\uBC30\uC815",
    "\uBB34\uC0C1\uC99D\uC790",
    "\uAC10\uC790",
    "rights offering",
    "at-the-market",
    "offering",
    "prospectus",
    "reverse stock split",
    "reverse split"
  ))
    return "DILUTION";
  return null;
}
function classifyKr(reportName) {
  const t = reportName;
  const events = [];
  if (t.includes("\uC720\uC0C1\uC99D\uC790")) events.push("RIGHTS_OFFERING");
  if (t.includes("\uC804\uD658\uC0AC\uCC44")) events.push("CB");
  if (t.includes("\uC2E0\uC8FC\uC778\uC218\uAD8C\uBD80\uC0AC\uCC44")) events.push("BW");
  if (t.includes("\uAC10\uC790") || t.includes("\uC8FC\uC2DD\uBCD1\uD569") || t.includes("\uC561\uBA74\uBCD1\uD569"))
    events.push("REVERSE_SPLIT");
  if (t.includes("\uBC30\uB2F9")) events.push("DIVIDEND");
  if (t.includes("\uACF5\uAE09\uACC4\uC57D") || t.includes("\uB2E8\uC77C\uD310\uB9E4") || t.includes("\uC218\uC8FC"))
    events.push("SUPPLY_CONTRACT");
  if (t.includes("\uACF5\uBAA8") || t.includes("\uBAA8\uC9D1")) events.push("OFFERING");
  if (/ATM/i.test(t)) events.push("ATM");
  if (t.includes("\uC0C1\uC7A5\uD3D0\uC9C0") || t.includes("\uAD00\uB9AC\uC885\uBAA9") || t.includes("\uC0C1\uC7A5\uC801\uACA9\uC131"))
    events.push("DELISTING");
  return finalize(events);
}
function classifyUs(form, description) {
  const f = form.toUpperCase();
  const d = description.toLowerCase();
  const events = [];
  const offeringForm = /^(S-1|S-3|F-1|F-3|424B)/.test(f);
  if (/at-the-market|\batm\b/.test(d) || f === "424B5") events.push("ATM");
  if (/reverse (stock )?split/.test(d)) events.push("REVERSE_SPLIT");
  if (/rights offering/.test(d)) events.push("RIGHTS_OFFERING");
  if (/convertible/.test(d)) events.push("CB");
  if (/warrant/.test(d)) events.push("BW");
  if (/dividend/.test(d)) events.push("DIVIDEND");
  if (/supply (agreement|contract)/.test(d)) events.push("SUPPLY_CONTRACT");
  if (offeringForm || /\boffering\b|prospectus/.test(d))
    events.push("OFFERING");
  if (/^25(-NSE)?$/.test(f) || /delist/.test(d)) events.push("DELISTING");
  return finalize(events);
}

// src/services/filing.service.ts
var US_FORM_DESC = {
  "10-K": "\uC5F0\uAC04 \uC0AC\uC5C5\uBCF4\uACE0\uC11C",
  "10-Q": "\uBD84\uAE30 \uBCF4\uACE0\uC11C",
  "8-K": "\uC8FC\uC694 \uACBD\uC601\uC0AC\uD56D \uACF5\uC2DC",
  "S-1": "\uC99D\uAD8C\uC2E0\uACE0\uC11C(\uACF5\uBAA8)",
  "S-3": "\uC120\uBC18\uB4F1\uB85D \uC2E0\uACE0\uC11C",
  "F-1": "\uC678\uAD6D\uAE30\uC5C5 \uC99D\uAD8C\uC2E0\uACE0\uC11C",
  "F-3": "\uC678\uAD6D\uAE30\uC5C5 \uC120\uBC18\uB4F1\uB85D",
  "424B5": "\uC99D\uAD8C\uC124\uBA85\uC11C",
  "424B3": "\uC99D\uAD8C\uC124\uBA85\uC11C",
  "424B4": "\uC99D\uAD8C\uC124\uBA85\uC11C",
  DEF14A: "\uC8FC\uC8FC\uCD1D\uD68C \uC18C\uC9D1\uACF5\uACE0",
  SC13D: "\uC9C0\uBD84 5% \uC774\uC0C1 \uBCF4\uC720 \uACF5\uC2DC",
  SC13G: "\uC9C0\uBD84 \uBCF4\uC720 \uACF5\uC2DC",
  "4": "\uC784\uC6D0 \uC9C0\uBD84\uBCC0\uB3D9",
  "3": "\uC784\uC6D0 \uC9C0\uBD84 \uCD5C\uCD08\uBCF4\uACE0",
  "13F-HR": "\uAE30\uAD00 \uBCF4\uC720\uB0B4\uC5ED"
};
function normalizeTitle(value) {
  return value.toLowerCase().replace(/\[[^\]]*\]|\([^)]*\)|[^0-9a-z가-힣]/g, "").replace(/정정|첨부정정|기재정정/g, "");
}
function dedupe(items, titleOf, limit) {
  const merged = /* @__PURE__ */ new Map();
  for (const item of [...items].sort((a, b) => b.date.localeCompare(a.date))) {
    const key = normalizeTitle(titleOf(item));
    const current = merged.get(key);
    if (current) current.relatedCount = (current.relatedCount ?? 1) + 1;
    else merged.set(key, { ...item, relatedCount: 1 });
  }
  const rows = [...merged.values()];
  return limit == null ? rows : rows.slice(0, limit);
}
function krDate(value) {
  return /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : value;
}
var FilingService = {
  async getFilings(ticker, options = {}) {
    const entry = getCatalogEntry(ticker);
    if (!entry) return null;
    if (entry.market === "US") {
      const raw2 = await getFilings(entry.ticker);
      const filings = raw2.map((row) => {
        const classification = classifyUs(row.form, row.description);
        return { form: row.form, date: row.date, description: US_FORM_DESC[row.form.toUpperCase()] ?? row.description ?? row.form, url: row.url, sentiment: classification.sentiment, events: classification.events, eventLabels: classification.eventLabels };
      });
      return { market: "US", filings: dedupe(filings, (row) => `${row.form}${row.description}`, options.allHistory ? null : 5), disclosures: [] };
    }
    const raw = await getDisclosures(entry.ticker);
    const disclosures = raw.map((row) => {
      const classification = classifyKr(row.reportName);
      return { report: row.reportName, date: krDate(row.date), description: `\uC81C\uCD9C\uC778: ${row.filer}`, url: row.url, sentiment: classification.sentiment, events: classification.events, eventLabels: classification.eventLabels };
    });
    return { market: "KR", filings: [], disclosures: dedupe(disclosures, (row) => row.report, options.allHistory ? null : 5) };
  }
};

// src/services/risk-analysis.service.ts
var DELISTING_KEYWORDS = [
  "\uC0C1\uC7A5\uD3D0\uC9C0",
  "\uAD00\uB9AC\uC885\uBAA9",
  "\uAC70\uB798\uC815\uC9C0",
  "\uAC10\uC0AC\uC758\uACAC\uAC70\uC808",
  "\uAC10\uC0AC\uC758\uACAC \uAC70\uC808",
  "\uC790\uBCF8\uC7A0\uC2DD",
  "\uD6A1\uB839",
  "\uBC30\uC784",
  "delisting",
  "going concern"
];
var DILUTION_EVENTS = /* @__PURE__ */ new Set([
  "OFFERING",
  "ATM",
  "RIGHTS_OFFERING",
  "CB",
  "BW"
]);
function clamp(n) {
  return Math.max(5, Math.min(90, Math.round(n)));
}
function levelFor(score) {
  if (score >= 67) return "HIGH";
  if (score >= 34) return "MEDIUM";
  return "LOW";
}
function mk(label, score, explanation) {
  return { label, score, level: levelFor(score), explanation };
}
function hasKeyword(text, words) {
  const l = text.toLowerCase();
  return words.some((w) => l.includes(w.toLowerCase()));
}
function buildKrItems(ds) {
  const dilution = ds.filter(
    (d) => d.events.some((e) => DILUTION_EVENTS.has(e))
  ).length;
  const delisting = ds.filter(
    (d) => hasKeyword(`${d.report} ${d.description}`, DELISTING_KEYWORDS)
  ).length;
  return [
    mk(
      "\uC790\uBCF8 \uD76C\uC11D (\uC99D\uC790\xB7CB\xB7BW)",
      dilution ? clamp(30 + dilution * 15) : 8,
      dilution ? `\uCD5C\uADFC 1\uB144 \uD76C\uC11D\uC131 \uC790\uBCF8\uC870\uB2EC(\uC720\uC0C1\uC99D\uC790\xB7\uC804\uD658\uC0AC\uCC44 \uB4F1) \uACF5\uC2DC ${dilution}\uAC74\uC774 \uAC10\uC9C0\uB418\uC5C8\uC2B5\uB2C8\uB2E4.` : "\uCD5C\uADFC 1\uB144 \uD76C\uC11D\uC131 \uC790\uBCF8\uC870\uB2EC \uAD00\uB828 \uACF5\uC2DC\uAC00 \uD655\uC778\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4."
    ),
    mk(
      "\uC0C1\uC7A5\uD3D0\uC9C0\xB7\uAD00\uB9AC\uC885\uBAA9",
      delisting ? clamp(60 + delisting * 15) : 5,
      delisting ? `\uC0C1\uC7A5\uD3D0\uC9C0\xB7\uAD00\uB9AC\uC885\uBAA9\xB7\uAC70\uB798\uC815\uC9C0 \uAD00\uB828 \uACF5\uC2DC ${delisting}\uAC74\uC774 \uAC10\uC9C0\uB418\uC5C8\uC2B5\uB2C8\uB2E4.` : "\uCD5C\uADFC \uACF5\uC2DC\uC5D0\uC11C \uC0C1\uC7A5\uD3D0\uC9C0\xB7\uAD00\uB9AC\uC885\uBAA9\xB7\uAC70\uB798\uC815\uC9C0\xB7\uAC10\uC0AC\uC758\uACAC \uAC70\uC808 \uC2E0\uD638\uAC00 \uD655\uC778\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4."
    ),
    mk(
      // Informational only: disclosure VOLUME is not itself a risk event, so it
      // is capped in the LOW band and never drives a blue-chip to HIGH.
      "\uACF5\uC2DC\xB7\uC774\uBCA4\uD2B8 \uD65C\uB3D9\uC131",
      Math.min(20, 5 + Math.floor(ds.length / 25)),
      `\uCD5C\uADFC 1\uB144 DART \uACF5\uC2DC ${ds.length}\uAC74\uC744 \uBD84\uC11D\uD588\uC2B5\uB2C8\uB2E4.`
    )
  ];
}
function buildUsItems(fs4) {
  const offering = fs4.filter(
    (f) => /S-1|S-3|424B|F-1|F-3/i.test(f.form) || f.events.some((e) => DILUTION_EVENTS.has(e))
  ).length;
  const delisting = fs4.filter(
    (f) => /^25(-NSE)?$/i.test(f.form) || hasKeyword(f.description, DELISTING_KEYWORDS)
  ).length;
  const eightK = fs4.filter((f) => /^8-K/i.test(f.form)).length;
  return [
    mk(
      "\uD76C\uC11D\uC131 \uC790\uBCF8\uC870\uB2EC (S-1/S-3/424B)",
      offering ? clamp(28 + offering * 12) : 8,
      offering ? `\uCD5C\uADFC \uACF5\uBAA8\xB7\uC77C\uAD04\uC2E0\uACE0(S-1/S-3/424B) \uAD00\uB828 \uACF5\uC2DC ${offering}\uAC74\uC774 \uAC10\uC9C0\uB418\uC5C8\uC2B5\uB2C8\uB2E4.` : "\uCD5C\uADFC \uACF5\uBAA8 \uAD00\uB828 \uC99D\uAD8C\uC2E0\uACE0\uC11C\uAC00 \uD655\uC778\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4."
    ),
    mk(
      "\uC0C1\uC7A5\uD3D0\uC9C0 (Form 25)",
      delisting ? clamp(60 + delisting * 20) : 5,
      delisting ? `\uC0C1\uC7A5\uD3D0\uC9C0(Form 25) \uAD00\uB828 \uACF5\uC2DC ${delisting}\uAC74\uC774 \uAC10\uC9C0\uB418\uC5C8\uC2B5\uB2C8\uB2E4.` : "\uCD5C\uADFC \uC0C1\uC7A5\uD3D0\uC9C0(Form 25) \uACF5\uC2DC\uAC00 \uD655\uC778\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4."
    ),
    mk(
      // Informational only: 8-K frequency alone is not a risk event and is
      // capped in the LOW band so a blue-chip is never HIGH without a real event.
      "\uC911\uB300 \uACBD\uC601\uC0AC\uD56D (8-K \uBE48\uB3C4)",
      Math.min(20, 5 + Math.max(0, eightK - 6) * 2),
      `\uCD5C\uADFC 1\uB144 8-K(\uC8FC\uC694 \uACBD\uC601\uC0AC\uD56D) \uACF5\uC2DC ${eightK}\uAC74\uC744 \uBD84\uC11D\uD588\uC2B5\uB2C8\uB2E4.`
    )
  ];
}
function overallExplanation(market, items, count, feedOk) {
  const src = market === "US" ? "SEC EDGAR" : "DART";
  if (!feedOk) {
    return "\uC2E4\uC2DC\uAC04 \uACF5\uC2DC \uD53C\uB4DC\uB97C \uBD88\uB7EC\uC624\uC9C0 \uBABB\uD574 \uAE30\uBCF8(\uB0AE\uC74C) \uC704\uD5D8\uB3C4\uB85C \uD45C\uC2DC\uD569\uB2C8\uB2E4. \uC7A0\uC2DC \uD6C4 \uB2E4\uC2DC \uC2DC\uB3C4\uD574 \uC8FC\uC138\uC694.";
  }
  const top = [...items].sort((a, b) => b.score - a.score)[0];
  if (!top || top.level === "LOW") {
    return `\uC2E4\uC2DC\uAC04 ${src} \uACF5\uC2DC ${count}\uAC74\uC744 \uBD84\uC11D\uD55C \uACB0\uACFC, \uD2B9\uBCC4\uD55C \uC704\uD5D8 \uC2E0\uD638\uAC00 \uAC10\uC9C0\uB418\uC9C0 \uC54A\uC544 \uC704\uD5D8\uB3C4\uB294 '\uB0AE\uC74C'\uC785\uB2C8\uB2E4.`;
  }
  return `\uC2E4\uC2DC\uAC04 ${src} \uACF5\uC2DC ${count}\uAC74 \uBD84\uC11D \uACB0\uACFC, '${top.label}' \uD56D\uBAA9\uC758 \uC704\uD5D8\uB3C4\uAC00 \uAC00\uC7A5 \uB192\uC2B5\uB2C8\uB2E4.`;
}
function levelForKind(kind) {
  switch (kind) {
    case "DELISTING":
    case "TRADING_SUSPENSION":
    case "GOING_CONCERN":
    case "CAPITAL_IMPAIRMENT":
      return "HIGH";
    case "DILUTION":
    case "CONVERTIBLE_BOND":
      return "MEDIUM";
    default:
      return "LOW";
  }
}
function eventTypeFor(kind) {
  return kind;
}
var DAY_MS = 24 * 60 * 60 * 1e3;
function statusForDate(date, now) {
  if (!date || Number.isNaN(date.getTime())) return "HISTORICAL";
  const ageDays = Math.floor((now.getTime() - date.getTime()) / DAY_MS);
  if (ageDays < 0) return "CURRENT";
  if (ageDays <= 90) return "CURRENT";
  if (ageDays <= 365) return "WATCH";
  return "HISTORICAL";
}
function parseDate(raw) {
  if (!raw) return null;
  const iso = /^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : raw;
  const d = /* @__PURE__ */ new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}
var RESOLVED_KEYWORDS = ["\uC815\uC815", "\uCCA0\uD68C", "\uCDE8\uC18C", "\uC911\uB2E8", "withdrawn", "terminated", "cancel"];
function isResolvedText(text) {
  const l = text.toLowerCase();
  return RESOLVED_KEYWORDS.some((w) => l.includes(w.toLowerCase()));
}
function buildRiskEvents(sources, now) {
  const events = [];
  const latestByKind = /* @__PURE__ */ new Map();
  sources.forEach((s, index) => {
    const kind = classifyRiskEvent(s.text);
    if (!kind) return;
    const date = parseDate(s.date);
    const resolved = isResolvedText(s.text);
    const status = resolved ? "IGNORED" : statusForDate(date, now);
    const seen = latestByKind.get(kind);
    if (!resolved && seen !== void 0 && date && status !== "HISTORICAL") {
      const prior = events[seen];
      const priorDate = parseDate(prior.date);
      if (priorDate && date.getTime() > priorDate.getTime()) {
        prior.status = "IGNORED";
        prior.level = "LOW";
        prior.isResolved = true;
        prior.isRecent = false;
      }
    }
    if (!resolved && (status === "CURRENT" || status === "WATCH")) {
      latestByKind.set(kind, events.length);
    }
    events.push({
      id: `${s.source}-${s.date || "nodate"}-${index}`,
      type: eventTypeFor(kind),
      label: RISK_EVENT_LABEL_KO[kind],
      status,
      level: status === "IGNORED" || status === "HISTORICAL" ? "LOW" : levelForKind(kind),
      date: date ? s.date : null,
      title: s.title,
      summary: s.summary,
      source: s.source,
      url: s.url,
      isRecent: status === "CURRENT",
      isResolved: status === "IGNORED"
    });
  });
  return events;
}
function krRiskSources(ds) {
  return ds.map((d) => ({
    text: `${d.report} ${d.description}`,
    title: d.report,
    summary: d.description || d.report,
    date: d.date,
    url: d.url || null,
    source: "DART"
  }));
}
function usRiskSources(fs4) {
  return fs4.map((f) => ({
    text: `${f.form} ${f.description}`,
    title: `${f.form} \xB7 ${f.description}`,
    summary: `${f.form} \uACF5\uC2DC: ${f.description}`,
    date: f.date,
    url: f.url || null,
    source: "SEC"
  }));
}
var RiskAnalysisService = {
  async getRisk(ticker) {
    const entry = getCatalogEntry(ticker);
    if (!entry) return null;
    let filings = [];
    let disclosures = [];
    let feedOk = false;
    try {
      const feed = await FilingService.getFilings(ticker);
      if (feed) {
        filings = feed.filings;
        disclosures = feed.disclosures;
        feedOk = true;
      }
    } catch (err) {
      console.error("risk filing feed unavailable:", err);
    }
    const items = entry.market === "US" ? buildUsItems(filings) : buildKrItems(disclosures);
    const overallScore = items.length ? Math.round(items.reduce((s, i) => s + i.score, 0) / items.length) : 5;
    const overallLevel = levelFor(overallScore);
    const count = filings.length + disclosures.length;
    const now = /* @__PURE__ */ new Date();
    const events = feedOk ? buildRiskEvents(
      entry.market === "US" ? usRiskSources(filings) : krRiskSources(disclosures),
      now
    ) : [];
    return {
      market: entry.market,
      items,
      events,
      overallScore,
      overallLevel,
      explanation: overallExplanation(entry.market, items, count, feedOk),
      filings,
      disclosures
    };
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

// src/services/market-listing.service.ts
var SUMMARY_DEFS = [
  { key: "kospi", label: "\uCF54\uC2A4\uD53C", symbol: "^KS11", unit: "index" },
  { key: "kosdaq", label: "\uCF54\uC2A4\uB2E5", symbol: "^KQ11", unit: "index" },
  { key: "nasdaq", label: "\uB098\uC2A4\uB2E5", symbol: "^IXIC", unit: "index" },
  { key: "sp500", label: "S&P 500", symbol: "^GSPC", unit: "index" },
  { key: "dow", label: "\uB2E4\uC6B0", symbol: "^DJI", unit: "index" },
  { key: "russell", label: "\uB7EC\uC1402000", symbol: "^RUT", unit: "index" },
  { key: "vix", label: "VIX", symbol: "^VIX", unit: "index" },
  { key: "usdkrw", label: "\uC6D0/\uB2EC\uB7EC", symbol: "KRW=X", unit: "krw" },
  { key: "btc", label: "\uBE44\uD2B8\uCF54\uC778", symbol: "BTC-USD", unit: "usd" },
  { key: "gold", label: "\uAE08", symbol: "GC=F", unit: "usd" },
  { key: "oil", label: "\uC720\uAC00(WTI)", symbol: "CL=F", unit: "usd" }
];
async function getMarketSummary() {
  return Promise.all(
    SUMMARY_DEFS.map(async (d) => {
      try {
        const q = await getIndexQuote(d.symbol);
        return {
          key: d.key,
          label: d.label,
          price: q.price,
          changePercent: q.changePercent,
          spark: q.spark,
          unit: d.unit,
          ok: true
        };
      } catch {
        return {
          key: d.key,
          label: d.label,
          price: 0,
          changePercent: 0,
          spark: [],
          unit: d.unit,
          ok: false
        };
      }
    })
  );
}
var MAX = 30;
var CANDIDATE_CAP = 250;
var RATING_LABEL = {
  STRONG_BUY: "\uC801\uADF9 \uB9E4\uC218",
  BUY: "\uB9E4\uC218",
  HOLD: "\uBCF4\uD1B5",
  SELL: "\uB9E4\uB3C4",
  STRONG_SELL: "\uC801\uADF9 \uB9E4\uB3C4"
};
var US_ETF_TICKERS = /* @__PURE__ */ new Set([
  "SPY",
  "QQQ",
  "DIA",
  "IWM",
  "VOO",
  "VTI",
  "SCHD",
  "JEPI",
  "JEPQ",
  "SMH",
  "SOXX",
  "XLK",
  "XLE",
  "XLF",
  "XLV",
  "XLI",
  "ARKK",
  "ARKG",
  "ARKW",
  "SOXL",
  "SOXS",
  "TQQQ",
  "SQQQ",
  "SPXL",
  "SPXS",
  "TECL",
  "TECS",
  "LABU",
  "LABD",
  "BOIL",
  "KOLD",
  "UVXY"
]);
var KR_ETF_BRANDS = [
  "KODEX",
  "TIGER",
  "ACE",
  "RISE",
  "SOL",
  "HANARO",
  "ARIRANG",
  "PLUS",
  "KBSTAR",
  "KINDEX",
  "KOSEF",
  "TIMEFOLIO"
];
function assetTypeOf(e) {
  const name = e.name.toLowerCase();
  const upperName = e.name.toUpperCase();
  const ticker = e.ticker.toUpperCase();
  const isKrEtfBrand = KR_ETF_BRANDS.some(
    (brand) => upperName.startsWith(brand)
  );
  const leveraged = name.includes("3x") || name.includes("2x") || name.includes("\uB808\uBC84\uB9AC\uC9C0") || name.includes("bull") || name.includes("ultrapro") || name.includes("ultra ");
  const inverse = name.includes("inverse") || name.includes("short") || name.includes("bear") || name.includes("\uC778\uBC84\uC2A4");
  const etn = name.includes("etn") || upperName.includes(" ETN") || upperName.endsWith("ETN");
  if (etn) {
    if (leveraged) return "LEVERAGED_ETN";
    if (inverse) return "INVERSE_ETN";
    return "ETN";
  }
  if (isKrEtfBrand || US_ETF_TICKERS.has(ticker) || name.includes("etf")) {
    if (leveraged) return "LEVERAGED_ETF";
    if (inverse) return "INVERSE_ETF";
    return "ETF";
  }
  return classifyAssetType(e.name, e.market);
}
var isEtf = (a) => a === "ETF" || a === "LEVERAGED_ETF" || a === "INVERSE_ETF";
var isEtnAsset = (a) => a === "ETN" || a === "LEVERAGED_ETN" || a === "INVERSE_ETN";
var isStock = (a) => a === "STOCK" || a === "REIT" || a === "ADR";
async function buildCandidates(market) {
  const at = (e) => assetTypeOf(e);
  const uniqueAndRegister = (entries) => {
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    for (const entry of entries) {
      const key = `${entry.market}:${entry.ticker.toUpperCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      registerDynamicEntry(entry);
      out.push(entry);
    }
    return out;
  };
  const catalogKr = CATALOG.filter((e) => e.market === "KR");
  const catalogUs = CATALOG.filter((e) => e.market === "US");
  if (market === "KRX" || market === "KOSPI" || market === "KOSDAQ" || market === "KR_ETF" || market === "KR_ETN") {
    let krEntries = [];
    try {
      const universe = await getKrUniverse();
      krEntries = universe.filter((e) => {
        if (market === "KRX") {
          return isStock(e.assetType);
        }
        if (market === "KOSPI") {
          return isStock(e.assetType) && (e.marketName.includes("\uC720\uAC00\uC99D\uAD8C") || e.marketName.includes("\uCF54\uC2A4\uD53C") || e.marketName.toUpperCase().includes("KOSPI"));
        }
        if (market === "KOSDAQ") {
          return isStock(e.assetType) && (e.marketName.includes("\uCF54\uC2A4\uB2E5") || e.marketName.toUpperCase().includes("KOSDAQ"));
        }
        if (market === "KR_ETF") {
          return isEtf(e.assetType);
        }
        if (market === "KR_ETN") {
          return isEtnAsset(e.assetType);
        }
        return false;
      }).map((e) => ({
        ticker: e.ticker,
        name: e.name,
        market: "KR",
        currency: "KRW"
      }));
    } catch (error) {
      console.error("[market-listing] KRX universe failed:", error);
    }
    const catalogFallback = catalogKr.filter((e) => {
      const assetType = at(e);
      if (market === "KRX") return isStock(assetType);
      if (market === "KOSPI") return isStock(assetType);
      if (market === "KOSDAQ") return isStock(assetType);
      if (market === "KR_ETF") return isEtf(assetType);
      if (market === "KR_ETN") return isEtnAsset(assetType);
      return false;
    });
    return uniqueAndRegister([...krEntries, ...catalogFallback]).slice(
      0,
      CANDIDATE_CAP
    );
  }
  if (market === "NASDAQ" || market === "NYSE" || market === "AMEX" || market === "US_ETF" || market === "US_ETN") {
    let usEntries = [];
    try {
      const universe = await getUsUniverse();
      usEntries = universe.filter((e) => {
        if (market === "NASDAQ" || market === "NYSE" || market === "AMEX") {
          return e.exchange === market && isStock(e.assetType);
        }
        if (market === "US_ETF") {
          return isEtf(e.assetType);
        }
        if (market === "US_ETN") {
          return isEtnAsset(e.assetType);
        }
        return false;
      }).map((e) => ({
        ticker: e.ticker,
        name: e.name,
        market: "US",
        currency: "USD"
      }));
    } catch (error) {
      console.error("[market-listing] US universe failed:", error);
    }
    const catalogFallback = catalogUs.filter((e) => {
      const assetType = at(e);
      if (market === "NASDAQ" || market === "NYSE" || market === "AMEX") {
        return isStock(assetType);
      }
      if (market === "US_ETF") return isEtf(assetType);
      if (market === "US_ETN") return isEtnAsset(assetType);
      return false;
    });
    return uniqueAndRegister([...usEntries, ...catalogFallback]).slice(
      0,
      CANDIDATE_CAP
    );
  }
  return uniqueAndRegister(CATALOG).slice(0, CANDIDATE_CAP);
}
async function toRow(entry) {
  try {
    const quote = entry.market === "US" ? await getQuote2(entry) : await MarketDataService.getQuote(entry.ticker);
    if (!quote) return null;
    const price = Number(quote.price ?? 0);
    if (!Number.isFinite(price) || price <= 0) return null;
    const changeAmount = Number(quote.changeAmount ?? 0);
    const changePercent = Number(quote.changePercent ?? 0);
    const volume = Number(quote.volume ?? 0);
    const tradingValue = Number(quote.tradingValue ?? price * volume);
    const assetType = assetTypeOf(entry);
    const { overall } = computeScores(entry.ticker);
    return {
      ticker: entry.ticker,
      name: entry.name,
      market: entry.market,
      currency: entry.currency,
      assetType,
      price,
      changeAmount: Number.isFinite(changeAmount) ? changeAmount : 0,
      changePercent: Number.isFinite(changePercent) ? changePercent : 0,
      volume: Number.isFinite(volume) ? volume : 0,
      tradingValue: Number.isFinite(tradingValue) ? tradingValue : 0,
      high: Number(quote.high ?? 0) || void 0,
      low: Number(quote.low ?? 0) || void 0,
      open: Number(quote.open ?? 0) || void 0,
      previousClose: Number(quote.previousClose ?? 0) || void 0,
      updatedAt: String(quote.updatedAt ?? (/* @__PURE__ */ new Date()).toISOString()),
      rating: scoreToRating(overall),
      exchange: String(entry.exchange ?? "")
    };
  } catch {
    return null;
  }
}
function sma2(v, p, i) {
  if (i + 1 < p) return NaN;
  let s = 0;
  for (let k = i - p + 1; k <= i; k++) s += v[k];
  return s / p;
}
function rsi14(closes) {
  const n = closes.length;
  if (n < 15) return NaN;
  let gain = 0;
  let loss = 0;
  for (let i = n - 14; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  if (loss === 0) return 100;
  const rs = gain / 14 / (loss / 14);
  return 100 - 100 / (1 + rs);
}
function computeSignals(candles) {
  const closes = candles.map((c) => c.close);
  const vols = candles.map((c) => c.volume);
  const n = closes.length;
  const chips = [];
  if (n < 25) return chips;
  const i = n - 1;
  const s5 = sma2(closes, 5, i);
  const s20 = sma2(closes, 20, i);
  const p5 = sma2(closes, 5, i - 1);
  const p20 = sma2(closes, 20, i - 1);
  if (p5 <= p20 && s5 > s20) chips.push("\uACE8\uB4E0\uD06C\uB85C\uC2A4");
  else if (p5 >= p20 && s5 < s20) chips.push("\uB370\uB4DC\uD06C\uB85C\uC2A4");
  else if (s5 > s20) chips.push("\uC815\uBC30\uC5F4 \uC0C1\uC2B9\uCD94\uC138");
  const avgVol = vols.slice(n - 21, n - 1).reduce((a, b) => a + b, 0) / 20;
  if (avgVol > 0 && vols[i] > avgVol * 1.5) chips.push("\uAC70\uB798\uB7C9 \uAE09\uC99D");
  const r = rsi14(closes);
  if (r <= 30) chips.push("RSI \uACFC\uB9E4\uB3C4");
  else if (r >= 70) chips.push("RSI \uACFC\uB9E4\uC218");
  return chips;
}
function roundPrice(v, currency) {
  return currency === "KRW" ? Math.round(v) : Math.round(v * 100) / 100;
}
function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const recent = candles.slice(-period);
  const start = candles.length - period;
  const trs = recent.map((c, i) => {
    const prev = candles[start + i - 1];
    return Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close)
    );
  });
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}
function supportResistance(candles, price) {
  const recent = candles.slice(-60);
  const lows = recent.map((c) => c.low).filter((v) => v < price);
  const highs = recent.map((c) => c.high).filter((v) => v > price);
  return {
    support: lows.length ? Math.max(...lows) : null,
    resistance: highs.length ? Math.min(...highs) : null,
    recentHigh: recent.length ? Math.max(...recent.map((c) => c.high)) : null,
    recentLow: recent.length ? Math.min(...recent.map((c) => c.low)) : null
  };
}
function targetStopRates(rating, assetType) {
  const etfLike = isEtf(assetType) || isEtnAsset(assetType);
  const highRiskEtf = isLeveraged(assetType) || isInverse(assetType);
  if (highRiskEtf) {
    return { maxTargetRate: 0.05, maxStopRate: 0.035 };
  }
  if (etfLike) {
    return { maxTargetRate: 0.08, maxStopRate: 0.05 };
  }
  if (rating === "STRONG_BUY") {
    return { maxTargetRate: 0.1, maxStopRate: 0.065 };
  }
  if (rating === "BUY") {
    return { maxTargetRate: 0.08, maxStopRate: 0.055 };
  }
  if (rating === "HOLD") {
    return { maxTargetRate: 0.05, maxStopRate: 0.045 };
  }
  return { maxTargetRate: 0.035, maxStopRate: 0.035 };
}
function levels(price, rating, currency, assetType, candles = []) {
  const a = atr(candles);
  const sr = supportResistance(candles, price);
  const { maxTargetRate, maxStopRate } = targetStopRates(rating, assetType);
  const atrTake1 = a ? price + a * 1.2 : price * (1 + maxTargetRate * 0.45);
  const atrTake2 = a ? price + a * 2 : price * (1 + maxTargetRate);
  const atrStop = a ? price - a * 1.1 : price * (1 - maxStopRate);
  const rawTake1 = sr.resistance ?? atrTake1;
  const rawTake2 = sr.recentHigh && sr.recentHigh > price ? sr.recentHigh : atrTake2;
  const rawStop = sr.support ?? sr.recentLow ?? atrStop;
  const cappedTake1 = Math.min(rawTake1, price * (1 + maxTargetRate * 0.65));
  const cappedTake2 = Math.min(rawTake2, price * (1 + maxTargetRate));
  const cappedStop = Math.max(rawStop, price * (1 - maxStopRate));
  return {
    entry: roundPrice(price, currency),
    take1: roundPrice(Math.max(cappedTake1, price * 1.01), currency),
    take2: roundPrice(Math.max(cappedTake2, price * 1.02), currency),
    stop: roundPrice(Math.min(cappedStop, price * 0.995), currency)
  };
}
function riskOf(assetType, changePercent) {
  if (isLeveraged(assetType) || isInverse(assetType)) return "HIGH";
  const v = Math.abs(changePercent);
  if (v >= 5) return "HIGH";
  if (v >= 2) return "MEDIUM";
  return "LOW";
}
function reasonFor(row) {
  if (row.signals?.length) return row.signals.slice(0, 3).join(" \xB7 ");
  const label = RATING_LABEL[row.rating.rating];
  const parts = [];
  if (isEtf(row.assetType)) {
    parts.push("ETF \uCC28\uD2B8 \uAE30\uC900 \uD3C9\uAC00");
  } else if (isEtnAsset(row.assetType)) {
    parts.push("ETN \uBCC0\uB3D9\uC131 \uAE30\uC900 \uD3C9\uAC00");
  }
  if (row.changePercent >= 3) parts.push("\uAC15\uD55C \uC0C1\uC2B9 \uD750\uB984");
  else if (row.changePercent > 0) parts.push("\uC0C1\uC2B9 \uC804\uD658");
  else if (row.changePercent <= -3) parts.push("\uB099\uD3ED \uD655\uB300");
  else if (row.changePercent < 0) parts.push("\uC57D\uC138 \uD750\uB984");
  else parts.push("\uBCF4\uD569\uAD8C");
  parts.push(`AI ${row.rating.score}\uC810 \xB7 ${label}`);
  return parts.join(" \xB7 ");
}
async function enrichRecommended(row) {
  let signals = [];
  let candles = [];
  try {
    candles = await MarketDataService.getCandles(row.ticker, "1D");
    signals = computeSignals(candles);
  } catch {
  }
  const lv = levels(
    row.price,
    row.rating.rating,
    row.currency,
    row.assetType,
    candles
  );
  const enriched = {
    ...row,
    signals,
    ...lv,
    riskLevel: riskOf(row.assetType, row.changePercent)
  };
  enriched.reason = reasonFor(enriched);
  return enriched;
}
async function getMarketListings(market) {
  return cached(`listing:v5:${market}`, TTL.quote, async () => {
    const candidates = await buildCandidates(market);
    let rows = (await Promise.all(candidates.map(toRow))).filter(
      (r) => r !== null
    );
    if (market === "NASDAQ" || market === "NYSE" || market === "AMEX") {
      rows = rows.filter((r) => r.exchange === market);
    }
    const popular = rows.slice(0, MAX).map((r) => ({
      ...r,
      reason: reasonFor(r)
    }));
    const gainers = [...rows].filter((r) => r.changePercent > 0).sort((a, b) => b.changePercent - a.changePercent).slice(0, MAX).map((r) => ({ ...r, reason: reasonFor(r) }));
    const losers = [...rows].filter((r) => r.changePercent < 0).sort((a, b) => a.changePercent - b.changePercent).slice(0, MAX).map((r) => ({ ...r, reason: reasonFor(r) }));
    const topByScore = [...rows].sort((a, b) => b.rating.score - a.rating.score).slice(0, 12);
    const recommended = await Promise.all(topByScore.map(enrichRecommended));
    return { market, popular, gainers, losers, recommended };
  });
}
function num(v) {
  return typeof v === "number" && Number.isFinite(v) && v !== 0 ? v : null;
}
async function undervaluedCard(entry) {
  const assetType = assetTypeOf(entry);
  if (isEtf(assetType) || isEtnAsset(assetType)) {
    return null;
  }
  const [fin, quoteRow] = await Promise.all([
    FinancialService.getFinancials(entry.ticker).catch(() => null),
    toRow(entry)
  ]);
  if (!quoteRow) return null;
  const per = num(fin?.ratios?.per);
  const pbr = num(fin?.ratios?.pbr);
  const roe = num(fin?.ratios?.roe);
  const debtRatio = num(fin?.ratios?.debtRatio);
  const cash = num(fin?.cashBurn?.cashBalance);
  const revGrowth = fin?.growth?.revenue?.length ? fin.growth.revenue[fin.growth.revenue.length - 1] : null;
  const profitGrowth = fin?.growth?.profit?.length ? fin.growth.profit[fin.growth.profit.length - 1] : null;
  const reasons = [];
  const risks = [];
  let strength = 0;
  let weight = 0;
  const add = (w, s) => {
    strength += w * s;
    weight += w;
  };
  if (per != null) {
    if (per > 0 && per < 10) {
      add(1, 1);
      reasons.push(`\uC800PER ${per.toFixed(1)}\uBC30`);
    } else if (per > 0 && per < 15) {
      add(1, 0.6);
      reasons.push(`PER ${per.toFixed(1)}\uBC30 (\uD569\uB9AC\uC801)`);
    } else if (per > 0) {
      add(1, 0.1);
    }
    if (per <= 0) risks.push("\uC801\uC790 \uB610\uB294 PER \uC0B0\uC815 \uBD88\uAC00");
  }
  if (pbr != null) {
    if (pbr > 0 && pbr < 1) {
      add(1, 1);
      reasons.push(`\uC800PBR ${pbr.toFixed(2)}\uBC30 (\uCCAD\uC0B0\uAC00\uCE58 \uC774\uD558)`);
    } else if (pbr > 0 && pbr < 1.5) {
      add(1, 0.6);
      reasons.push(`PBR ${pbr.toFixed(2)}\uBC30`);
    } else if (pbr > 0) {
      add(1, 0.1);
    }
  }
  if (roe != null) {
    if (roe >= 15) {
      add(1, 1);
      reasons.push(`\uC6B0\uC218\uD55C ROE ${roe.toFixed(1)}%`);
    } else if (roe >= 8) {
      add(1, 0.7);
      reasons.push(`\uC591\uD638\uD55C ROE ${roe.toFixed(1)}%`);
    } else if (roe >= 0) {
      add(1, 0.3);
    } else {
      add(1, 0);
      risks.push(`\uB9C8\uC774\uB108\uC2A4 ROE ${roe.toFixed(1)}%`);
    }
  }
  if (debtRatio != null) {
    if (debtRatio < 80) {
      add(0.8, 1);
      reasons.push(`\uB0AE\uC740 \uBD80\uCC44\uBE44\uC728 ${debtRatio.toFixed(0)}%`);
    } else if (debtRatio < 150) {
      add(0.8, 0.5);
    } else {
      add(0.8, 0.1);
      risks.push(`\uB192\uC740 \uBD80\uCC44\uBE44\uC728 ${debtRatio.toFixed(0)}%`);
    }
  }
  if (cash != null && cash > 0) {
    add(0.5, 1);
    reasons.push("\uD604\uAE08 \uBCF4\uC720 \uC591\uD638");
  }
  if (revGrowth != null) {
    if (revGrowth > 0) {
      add(0.6, 1);
      reasons.push(`\uB9E4\uCD9C \uC131\uC7A5 +${revGrowth.toFixed(1)}%`);
    } else {
      add(0.6, 0.2);
      risks.push(`\uB9E4\uCD9C \uC5ED\uC131\uC7A5 ${revGrowth.toFixed(1)}%`);
    }
  }
  if (profitGrowth != null && profitGrowth > 0) {
    add(0.6, 1);
    reasons.push(`\uC774\uC775 \uAC1C\uC120 +${profitGrowth.toFixed(1)}%`);
  } else if (profitGrowth != null && profitGrowth < 0) {
    risks.push(`\uC774\uC775 \uAC10\uC18C ${profitGrowth.toFixed(1)}%`);
  }
  if (weight === 0) return null;
  const score = Math.round(strength / weight * 100);
  const factorsSeen = [per, pbr, roe, debtRatio].filter((v) => v != null).length;
  const dataQuality = factorsSeen >= 3 ? "ok" : factorsSeen >= 1 ? "partial" : "insufficient";
  if (risks.length === 0) risks.push("\uC7AC\uBB34\uC0C1 \uD2B9\uC774 \uB9AC\uC2A4\uD06C \uBBF8\uD655\uC778");
  let candles = [];
  try {
    candles = await MarketDataService.getCandles(quoteRow.ticker, "1D");
  } catch {
  }
  const lv = levels(
    quoteRow.price,
    quoteRow.rating.rating,
    quoteRow.currency,
    quoteRow.assetType,
    candles
  );
  return {
    ticker: entry.ticker,
    name: entry.name,
    market: entry.market,
    currency: entry.currency,
    price: quoteRow.price,
    changePercent: quoteRow.changePercent,
    score,
    per,
    pbr,
    roe,
    debtRatio,
    reasons,
    risks,
    entry: lv.entry,
    stop: lv.stop,
    target: lv.take2,
    dataQuality
  };
}
var UNDERVALUED_CAP = 30;
async function getUndervalued(market) {
  return cached(`undervalued:v5:${market}`, TTL.quote, async () => {
    const candidates = (await buildCandidates(market)).slice(0, UNDERVALUED_CAP);
    const cards = (await Promise.all(candidates.map((c) => undervaluedCard(c).catch(() => null)))).filter((c) => c !== null).sort((a, b) => b.score - a.score).slice(0, MAX);
    return { market, cards };
  });
}
function aggregateSectors(rows) {
  const map = /* @__PURE__ */ new Map();
  for (const r of rows) {
    const sector = SECTOR_MAP[r.ticker];
    if (!sector) continue;
    const cur = map.get(sector) ?? { sum: 0, count: 0 };
    cur.sum += r.changePercent;
    cur.count += 1;
    map.set(sector, cur);
  }
  return Array.from(map.entries()).filter(([, v]) => v.count >= 1).map(([sector, v]) => ({
    sector,
    changePercent: Math.round(v.sum / v.count * 100) / 100,
    count: v.count
  })).sort((a, b) => b.changePercent - a.changePercent);
}
function moodOf(avg) {
  if (avg >= 0.4) return "positive";
  if (avg <= -0.4) return "negative";
  return "neutral";
}
async function getBriefing() {
  return cached("briefing:v5", TTL.quote, async () => {
    const [summary, kr, us] = await Promise.all([
      getMarketSummary(),
      getMarketListings("KRX"),
      getMarketListings("NASDAQ")
    ]);
    const byKey = (k) => summary.find((s) => s.key === k);
    const kospi = byKey("kospi");
    const kosdaq = byKey("kosdaq");
    const nasdaq = byKey("nasdaq");
    const sp = byKey("sp500");
    const changes = [kospi, nasdaq, sp].filter((s) => !!s && s.ok).map((s) => s.changePercent);
    const avg = changes.length ? changes.reduce((a, b) => a + b, 0) / changes.length : 0;
    const mood = moodOf(avg);
    const pct = (s) => s && s.ok ? `${s.changePercent >= 0 ? "+" : ""}${s.changePercent.toFixed(2)}%` : "\u2014";
    const lines = [];
    if (kospi) lines.push(`\uCF54\uC2A4\uD53C ${pct(kospi)} \xB7 \uCF54\uC2A4\uB2E5 ${pct(kosdaq)}`);
    if (nasdaq) lines.push(`\uB098\uC2A4\uB2E5 ${pct(nasdaq)} \xB7 S&P500 ${pct(sp)}`);
    const vix = byKey("vix");
    const usdkrw = byKey("usdkrw");
    if (vix) {
      lines.push(
        `VIX ${vix.ok ? vix.price.toFixed(1) : "\u2014"} \xB7 \uC6D0/\uB2EC\uB7EC ${usdkrw?.ok ? Math.round(usdkrw.price).toLocaleString("ko-KR") : "\u2014"}\uC6D0`
      );
    }
    const headline = mood === "positive" ? "\uC704\uD5D8 \uC120\uD638 \uC6B0\uC704 \xB7 \uC9C0\uC218 \uC0C1\uC2B9 \uD750\uB984" : mood === "negative" ? "\uC704\uD5D8 \uD68C\uD53C \uC6B0\uC704 \xB7 \uC9C0\uC218 \uD558\uB77D \uC555\uB825" : "\uD63C\uC870\uC138 \xB7 \uBC29\uD5A5\uC131 \uD0D0\uC0C9 \uAD6C\uAC04";
    const sectorRows = [
      ...kr.popular,
      ...kr.gainers,
      ...kr.losers,
      ...us.popular,
      ...us.gainers,
      ...us.losers
    ];
    const bySector = /* @__PURE__ */ new Map();
    for (const r of sectorRows) {
      if (!bySector.has(r.ticker)) bySector.set(r.ticker, r);
    }
    const sectors = aggregateSectors(Array.from(bySector.values()));
    const strongSectors = sectors.filter((s) => s.changePercent > 0).slice(0, 4);
    const weakSectors = sectors.filter((s) => s.changePercent < 0).reverse().slice(0, 4);
    const picksRows = [...kr.recommended, ...us.recommended].sort((a, b) => b.rating.score - a.rating.score).slice(0, 4);
    const positiveNews = [];
    const negativeNews = [];
    const disclosureRisks = [];
    const enrich = await Promise.allSettled(
      picksRows.map(async (r) => {
        const [news, risk] = await Promise.all([
          NewsService.getNews(r.ticker).catch(() => null),
          RiskAnalysisService.getRisk(r.ticker).catch(() => null)
        ]);
        return { r, news, risk };
      })
    );
    for (const e of enrich) {
      if (e.status !== "fulfilled") continue;
      const { r, news, risk } = e.value;
      if (news?.positive?.[0]) {
        positiveNews.push({
          ticker: r.ticker,
          name: r.name,
          title: news.positive[0].title,
          url: news.positive[0].url
        });
      }
      if (news?.negative?.[0]) {
        negativeNews.push({
          ticker: r.ticker,
          name: r.name,
          title: news.negative[0].title,
          url: news.negative[0].url
        });
      }
      if (risk && (risk.overallLevel === "HIGH" || risk.overallLevel === "MEDIUM")) {
        const top = risk.items?.[0];
        disclosureRisks.push({
          ticker: r.ticker,
          name: r.name,
          level: risk.overallLevel,
          label: top?.label ?? "\uACF5\uC2DC \uC704\uD5D8"
        });
      }
    }
    return {
      asOf: (/* @__PURE__ */ new Date()).toISOString(),
      mood,
      headline,
      lines,
      strongSectors,
      weakSectors,
      positiveNews: positiveNews.slice(0, 3),
      negativeNews: negativeNews.slice(0, 3),
      disclosureRisks: disclosureRisks.slice(0, 3),
      gainers: kr.gainers.slice(0, 4).map((r) => ({
        ticker: r.ticker,
        name: r.name,
        changePercent: r.changePercent
      })),
      losers: kr.losers.slice(0, 4).map((r) => ({
        ticker: r.ticker,
        name: r.name,
        changePercent: r.changePercent
      })),
      picks: picksRows.slice(0, 3).map((r) => ({
        ticker: r.ticker,
        name: r.name,
        rating: r.rating.rating,
        score: r.rating.score
      }))
    };
  });
}
var MarketListingService = {
  getMarketSummary,
  getMarketListings,
  getBriefing,
  getUndervalued
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
function assetTypeOf2(entry) {
  return classifyAssetType(entry.name, entry.market);
}
function toThemeStock(entry, quote, assetType) {
  return {
    ticker: entry.ticker,
    name: entry.name,
    market: entry.market,
    currency: entry.currency,
    price: quote?.price ?? 0,
    changePercent: quote?.changePercent ?? 0,
    marketCap: quote?.marketCap,
    assetType
  };
}
async function buildThemes(market) {
  return cached(`themes:v4:${market}`, TTL.quote, async () => {
    const entries = CATALOG.filter((e) => e.market === market);
    const live = await Promise.all(
      entries.map(async (entry) => {
        let quote = null;
        try {
          quote = await MarketDataService.getQuote(entry.ticker);
        } catch {
          quote = null;
        }
        return { entry, quote, assetType: assetTypeOf2(entry) };
      })
    );
    const buckets = /* @__PURE__ */ new Map();
    const push = (key, stock) => {
      const list = buckets.get(key) ?? [];
      list.push(stock);
      buckets.set(key, list);
    };
    for (const { entry, quote, assetType } of live) {
      if (!quote || !Number.isFinite(quote.price) || quote.price <= 0) continue;
      const stock = toThemeStock(entry, quote, assetType);
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
      if (quote && Number.isFinite(quote.changePercent)) {
        if (quote.changePercent >= SURGE_PCT) push("surge", stock);
        if (quote.changePercent <= PLUNGE_PCT) push("plunge", stock);
      }
      if (quote && Number.isFinite(quote.marketCap) && quote.marketCap > 0) {
        const capMin = largeCapMin(entry.currency);
        if (quote.marketCap >= capMin) {
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
function normalizeMarket(value) {
  const raw = String(value ?? "ALL").toUpperCase();
  if (raw === "KR") return "KR";
  if (raw === "US") return "US";
  return "ALL";
}
function normalizeTicker2(value) {
  return String(value ?? "").trim().toUpperCase();
}
function uniqueTickers(values) {
  return Array.from(new Set(values.map(normalizeTicker2).filter(Boolean)));
}
function uniqueRows(rows) {
  const seen = /* @__PURE__ */ new Set();
  return rows.filter((row) => {
    const key = `${row.market}:${row.ticker}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return Number.isFinite(row.price) && row.price > 0;
  });
}
function rankByTradingValue(rows) {
  return [...rows].sort(
    (a, b) => Number(b.tradingValue ?? 0) - Number(a.tradingValue ?? 0)
  );
}
function rankByVolume(rows) {
  return [...rows].sort((a, b) => Number(b.volume ?? 0) - Number(a.volume ?? 0));
}
function rankByChange(rows, direction) {
  return [...rows].sort(
    (a, b) => direction === "desc" ? Number(b.changePercent ?? 0) - Number(a.changePercent ?? 0) : Number(a.changePercent ?? 0) - Number(b.changePercent ?? 0)
  );
}
function rankByScore(rows) {
  return [...rows].sort(
    (a, b) => Number(b.rating?.score ?? 0) - Number(a.rating?.score ?? 0)
  );
}
function marketKeys(scope) {
  if (scope === "KR") return ["KRX"];
  if (scope === "US") return ["NASDAQ", "NYSE"];
  return ["KRX", "NASDAQ", "NYSE"];
}
async function liveListings(scope) {
  const settled = await Promise.allSettled(
    marketKeys(scope).map((market) => MarketListingService.getMarketListings(market))
  );
  const rows = [];
  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    rows.push(
      ...result.value.popular,
      ...result.value.gainers,
      ...result.value.losers,
      ...result.value.recommended
    );
  }
  return uniqueRows(rows);
}
router2.get("/config", (_req, res) => {
  res.json({
    ok: true,
    service: "seungjae-stock-api",
    time: (/* @__PURE__ */ new Date()).toISOString(),
    providers: {
      kiwoom: Boolean(process.env.KIWOOM_APP_KEY && process.env.KIWOOM_APP_SECRET),
      naver: true,
      yahoo: true,
      upbit: Boolean(process.env.UPBIT_ACCESS_KEY && process.env.UPBIT_SECRET_KEY),
      bitget: Boolean(
        process.env.BITGET_API_KEY && process.env.BITGET_SECRET_KEY && process.env.BITGET_PASSPHRASE
      )
    }
  });
});
router2.get("/search", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  try {
    const results = await MarketDataService.search(q, q ? 100 : 500);
    return res.json({ q, results, count: results.length, updatedAt: (/* @__PURE__ */ new Date()).toISOString() });
  } catch (error) {
    console.error("market search error:", error);
    return res.status(502).json({ q, results: [], count: 0, error: "SEARCH_PROVIDER_ERROR" });
  }
});
router2.get("/search/quotes", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  try {
    const matches = await MarketDataService.search(q, 100);
    const quotes = await MarketDataService.getQuotes(matches.map((item) => item.ticker));
    const rows = uniqueRows(quotes);
    return res.json({ q, results: rows, count: rows.length, updatedAt: (/* @__PURE__ */ new Date()).toISOString() });
  } catch (error) {
    console.error("market quote search error:", error);
    return res.status(502).json({ q, results: [], count: 0, error: "QUOTE_SEARCH_PROVIDER_ERROR" });
  }
});
router2.get("/quotes", async (req, res) => {
  const raw = req.query.tickers ?? req.query.symbols ?? req.query.symbol ?? req.query.ticker ?? "";
  const tickers = uniqueTickers(String(raw).split(","));
  const quotes = await MarketDataService.getQuotes(tickers);
  return res.json({
    quotes: uniqueRows(quotes),
    requested: tickers.length,
    available: quotes.length,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  });
});
router2.get("/market/movers", async (req, res) => {
  const scope = normalizeMarket(req.query.market);
  try {
    const rows = await liveListings(scope);
    if (!rows.length) {
      return res.status(503).json({
        market: scope,
        popular: [],
        volume: [],
        recommended: [],
        gainers: [],
        losers: [],
        risky: [],
        error: "MARKET_DATA_UNAVAILABLE",
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      });
    }
    const popular = rankByTradingValue(rows).slice(0, 30);
    const volume = rankByVolume(rows).slice(0, 30);
    const gainers = rankByChange(rows, "desc").slice(0, 30);
    const losers = rankByChange(rows, "asc").slice(0, 30);
    const recommended = rankByScore(rows).slice(0, 30);
    return res.json({
      market: scope,
      provider: "live-market-providers",
      popular,
      volume,
      recommended,
      gainers,
      losers,
      risky: losers,
      rankingSource: {
        popular: "\uC2E4\uC81C \uAC70\uB798\uB300\uAE08 \uAE30\uC900",
        gainers: "\uC2E4\uC81C \uB4F1\uB77D\uB960 \uAE30\uC900",
        losers: "\uC2E4\uC81C \uB4F1\uB77D\uB960 \uAE30\uC900",
        recommended: "\uC2E4\uC81C \uB370\uC774\uD130 \uAE30\uBC18 \uC885\uD569\uC810\uC218 \uAE30\uC900"
      },
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    });
  } catch (error) {
    console.error("market movers error:", error);
    return res.status(502).json({
      market: scope,
      popular: [],
      volume: [],
      recommended: [],
      gainers: [],
      losers: [],
      risky: [],
      error: "MARKET_MOVERS_PROVIDER_ERROR"
    });
  }
});
router2.get("/market/home", async (_req, res) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  try {
    const rows = await MarketListingService.getMarketSummary();
    const indices = rows.filter((row) => ["kospi", "kosdaq", "nasdaq"].includes(row.key) && row.ok).map((row) => ({
      key: row.key.toUpperCase(),
      label: row.label,
      value: row.price,
      price: row.price,
      changeAmount: null,
      changePercent: row.changePercent,
      direction: row.changePercent > 0 ? "up" : row.changePercent < 0 ? "down" : "flat",
      spark: row.spark,
      provider: "Yahoo Finance",
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    }));
    return res.status(indices.length ? 200 : 503).json({
      ok: indices.length > 0,
      indices,
      sectorBriefings: [],
      updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      ...!indices.length ? { message: "\uC2E4\uC2DC\uAC04 \uC9C0\uC218 \uC81C\uACF5\uAE30\uAD00\uC758 \uC751\uB2F5\uC774 \uC9C0\uC5F0\uB418\uACE0 \uC788\uC2B5\uB2C8\uB2E4." } : {}
    });
  } catch (error) {
    console.error("market home error:", error);
    return res.status(502).json({ ok: false, indices: [], sectorBriefings: [], error: "INDEX_PROVIDER_ERROR" });
  }
});
router2.get("/market/summary", async (_req, res) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  try {
    const items = await MarketListingService.getMarketSummary();
    const available = items.filter((item) => item.ok);
    return res.status(available.length ? 200 : 503).json({
      items,
      ok: available.length > 0,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    });
  } catch (error) {
    console.error("market summary error:", error);
    return res.status(502).json({ ok: false, items: [], error: "SUMMARY_PROVIDER_ERROR" });
  }
});
router2.get("/market/briefing", async (_req, res) => {
  try {
    const briefing = await MarketListingService.getBriefing();
    return res.json(briefing);
  } catch (error) {
    console.error("market briefing error:", error);
    return res.status(502).json({
      asOf: (/* @__PURE__ */ new Date()).toISOString(),
      mood: "neutral",
      headline: "\uC2E4\uC81C \uC2DC\uC7A5 \uBE0C\uB9AC\uD551 \uB370\uC774\uD130\uB97C \uBD88\uB7EC\uC624\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.",
      lines: [],
      strongSectors: [],
      weakSectors: [],
      positiveNews: [],
      negativeNews: [],
      disclosureRisks: [],
      gainers: [],
      losers: [],
      picks: [],
      error: "BRIEFING_PROVIDER_ERROR"
    });
  }
});
router2.get("/market/themes", async (req, res) => {
  const market = String(req.query.market ?? "KR").toUpperCase() === "US" ? "US" : "KR";
  try {
    return res.json(await ThemesService.getThemes(market));
  } catch (error) {
    console.error("market themes route error:", error);
    return res.status(502).json({ market, themes: [], error: "MARKET_THEMES_PROVIDER_ERROR" });
  }
});
router2.get("/market/scan", async (req, res) => {
  const scope = normalizeMarket(req.query.market);
  try {
    const rows = rankByScore(await liveListings(scope)).slice(0, 100);
    return res.status(rows.length ? 200 : 503).json({
      market: scope,
      results: rows,
      cards: rows,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      ...!rows.length ? { error: "SCAN_DATA_UNAVAILABLE" } : {}
    });
  } catch (error) {
    console.error("market scan error:", error);
    return res.status(502).json({ market: scope, results: [], cards: [], error: "SCAN_PROVIDER_ERROR" });
  }
});
router2.get("/market/alerts", async (req, res) => {
  const scope = normalizeMarket(req.query.market);
  try {
    const rows = rankByChange(await liveListings(scope), "desc").slice(0, 20);
    const alerts = rows.map((row, index) => ({
      id: `${row.market}:${row.ticker}:movement`,
      ticker: row.ticker,
      name: row.name,
      market: row.market,
      kind: Number(row.changePercent ?? 0) >= 0 ? "positive" : "negative",
      category: "\uC2DC\uC138 \uBCC0\uB3D9",
      title: `${row.name} ${Number(row.changePercent ?? 0) >= 0 ? "\uC0C1\uC2B9" : "\uD558\uB77D"} ${Math.abs(Number(row.changePercent ?? 0)).toFixed(2)}%`,
      importance: index < 5 ? "high" : index < 12 ? "medium" : "low",
      time: row.updatedAt,
      url: null
    }));
    return res.json({ market: scope, positive: alerts.filter((item) => item.kind === "positive"), negative: alerts.filter((item) => item.kind === "negative"), alerts, updatedAt: (/* @__PURE__ */ new Date()).toISOString() });
  } catch (error) {
    console.error("market alerts error:", error);
    return res.status(502).json({ market: scope, positive: [], negative: [], alerts: [], error: "ALERT_PROVIDER_ERROR" });
  }
});
router2.get("/market/undervalued", async (req, res) => {
  const raw = String(req.query.market ?? "KRX").toUpperCase();
  const market = raw === "US" ? "NASDAQ" : raw === "KR" ? "KRX" : raw;
  try {
    return res.json(await MarketListingService.getUndervalued(market));
  } catch (error) {
    console.error("market undervalued error:", error);
    return res.status(502).json({ market, cards: [], error: "UNDERVALUED_PROVIDER_ERROR" });
  }
});
var market_default = router2;

// src/routes/news.route.ts
import { Router as Router3 } from "express";
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
import fs2 from "node:fs";
import path3 from "node:path";
import { Router as Router4 } from "express";
var router4 = Router4();
function normalizeTicker3(value) {
  return String(value ?? "").trim().toUpperCase();
}
function isKrTicker4(ticker) {
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
    const text = fs2.readFileSync(filePath, "utf8");
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
  const clean = normalizeTicker3(ticker);
  const result = {
    ticker: clean,
    marketGuess: isKrTicker4(clean) ? "KR" : "US",
    naver: null,
    yahoo: null
  };
  if (isKrTicker4(clean)) {
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
  const tickers = raw.split(",").map((ticker) => normalizeTicker3(ticker)).filter(Boolean);
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
  const sourceYahooPath = path3.resolve(cwd, "src/providers/yahoo.ts");
  const sourceNaverPath = path3.resolve(cwd, "src/providers/naver.ts");
  const sourceMarketPath = path3.resolve(cwd, "src/routes/market.ts");
  const sourceProviderDebugPath = path3.resolve(cwd, "src/routes/provider-debug.ts");
  const sourceIndexPath = path3.resolve(cwd, "src/routes/index.ts");
  const distPath = path3.resolve(cwd, "dist/index.mjs");
  const packagePath = path3.resolve(cwd, "package.json");
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

// src/services/notification.service.ts
import webPush from "web-push";
var DEFAULT_NOTIFICATION_TYPES = [
  "news_positive",
  "news_negative",
  "disclosure_positive",
  "disclosure_negative",
  "ai_strong_buy",
  "ai_sell_signal",
  "golden_cross",
  "volume_surge",
  "capital_event",
  "price_target",
  "auto_trade",
  "system"
];
var vapidInitialized = false;
var priceMonitorRunning = false;
var priceMonitorTimer = null;
function isVapidReady() {
  return Boolean(
    process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT
  );
}
function initializeVapid() {
  if (vapidInitialized || !isVapidReady()) return;
  webPush.setVapidDetails(
    process.env.VAPID_SUBJECT,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  vapidInitialized = true;
}
async function ensureNotificationPreferences(memberId) {
  const supabase = getSupabase();
  const { data, error } = await supabase.from("notification_preferences").select("*").eq("member_id", memberId).maybeSingle();
  if (error) throw error;
  if (data) return data;
  const { data: created, error: createError } = await supabase.from("notification_preferences").insert({ member_id: memberId, enabled_types: DEFAULT_NOTIFICATION_TYPES }).select("*").single();
  if (createError) throw createError;
  return created;
}
async function deliverMemberNotification(input) {
  const preferences = await ensureNotificationPreferences(input.memberId);
  const enabledTypes = Array.isArray(preferences.enabled_types) ? preferences.enabled_types : [...DEFAULT_NOTIFICATION_TYPES];
  if (!enabledTypes.includes(input.type)) {
    return { appStored: false, pushSent: 0, skipped: "TYPE_DISABLED" };
  }
  const appAllowed = input.app !== false && preferences.app_enabled !== false;
  const pushAllowed = input.push !== false && preferences.push_enabled === true && isVapidReady();
  let pushSent = 0;
  if (pushAllowed) {
    initializeVapid();
    const supabase = getSupabase();
    const { data, error } = await supabase.from("push_subscriptions").select("id,endpoint,subscription").eq("member_id", input.memberId);
    if (error) throw error;
    const invalidEndpoints = [];
    const payload = JSON.stringify({
      title: input.title,
      body: input.body,
      url: input.url ?? "/alerts",
      type: input.type,
      metadata: input.metadata ?? {}
    });
    await Promise.all(
      (data ?? []).map(async (row) => {
        try {
          await webPush.sendNotification(
            row.subscription,
            payload
          );
          pushSent += 1;
        } catch {
          invalidEndpoints.push(String(row.endpoint));
        }
      })
    );
    if (invalidEndpoints.length > 0) {
      await supabase.from("push_subscriptions").delete().eq("member_id", input.memberId).in("endpoint", invalidEndpoints);
    }
  }
  let appStored = false;
  if (appAllowed) {
    const { error } = await getSupabase().from("notification_history").insert({
      member_id: input.memberId,
      notification_type: input.type,
      title: input.title,
      body: input.body,
      url: input.url ?? null,
      channel: pushSent > 0 ? "both" : "app"
    });
    if (error) throw error;
    appStored = true;
  }
  return { appStored, pushSent };
}
async function fetchJson4(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1e4);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "knowledge-info-price-alert/1.0"
      },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}
function cleanSymbol(value) {
  return String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 30);
}
async function readAlertPrice(alert) {
  const symbol = cleanSymbol(alert.symbol);
  if (!symbol) throw new Error("INVALID_SYMBOL");
  if (alert.asset_type === "stock") {
    const quote = await MarketDataService.getQuoteRow(symbol);
    if (!quote || !Number.isFinite(quote.price) || quote.price <= 0) {
      throw new Error("STOCK_QUOTE_UNAVAILABLE");
    }
    return quote.price;
  }
  if (alert.asset_type === "coin_spot") {
    const market = symbol.startsWith("KRW-") ? symbol : `KRW-${symbol}`;
    const rows = await fetchJson4(
      `https://api.upbit.com/v1/ticker?markets=${encodeURIComponent(market)}`
    );
    const price2 = Number(rows[0]?.trade_price);
    if (!Number.isFinite(price2) || price2 <= 0) {
      throw new Error("UPBIT_QUOTE_UNAVAILABLE");
    }
    return price2;
  }
  const futuresSymbol = symbol.endsWith("USDT") ? symbol : `${symbol}USDT`;
  const payload = await fetchJson4(
    `https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES&symbol=${encodeURIComponent(futuresSymbol)}`
  );
  if (String(payload.code ?? "") !== "00000") {
    throw new Error(`BITGET_${String(payload.code ?? "INVALID")}`);
  }
  const price = Number(payload.data?.[0]?.markPrice ?? payload.data?.[0]?.lastPr);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("BITGET_QUOTE_UNAVAILABLE");
  }
  return price;
}
function isConditionMet(alert, price) {
  const target = Number(alert.target_price);
  return alert.direction === "above" ? price >= target : price <= target;
}
function alertUrl(alert) {
  const symbol = encodeURIComponent(cleanSymbol(alert.symbol));
  if (alert.asset_type === "stock") {
    const market = encodeURIComponent(String(alert.market || "KR").toUpperCase());
    return `/stock-info?asset=stock&market=${market}&ticker=${symbol}`;
  }
  const coinMarket = alert.asset_type === "coin_futures" ? "futures" : "spot";
  return `/stock-info?asset=coin&coinMarket=${coinMarket}&symbol=${symbol}`;
}
function formatPrice(value, assetType) {
  if (assetType === "coin_futures") {
    return value.toLocaleString("ko-KR", { maximumFractionDigits: 8 });
  }
  return value.toLocaleString("ko-KR", { maximumFractionDigits: 4 });
}
async function evaluatePriceAlert(alert) {
  const supabase = getSupabase();
  const now = /* @__PURE__ */ new Date();
  if (alert.expires_at && Date.parse(alert.expires_at) <= now.getTime()) {
    await supabase.from("price_alerts").update({ enabled: false, updated_at: now.toISOString() }).eq("id", alert.id);
    return;
  }
  try {
    const currentPrice = await readAlertPrice(alert);
    const met = isConditionMet(alert, currentPrice);
    const wasMet = alert.condition_met === true;
    const update = {
      condition_met: met,
      last_checked_price: currentPrice,
      last_checked_at: now.toISOString(),
      last_error: null,
      updated_at: now.toISOString()
    };
    if (met && !wasMet) {
      const target = Number(alert.target_price);
      const directionText = alert.direction === "above" ? "\uC774\uC0C1" : "\uC774\uD558";
      await deliverMemberNotification({
        memberId: alert.member_id,
        type: "price_target",
        title: `\uC9C0\uC815\uAC00 \uB3C4\uB2EC \xB7 ${cleanSymbol(alert.symbol)}`,
        body: `\uD604\uC7AC\uAC00 ${formatPrice(currentPrice, alert.asset_type)} \xB7 \uC124\uC815\uAC00 ${formatPrice(target, alert.asset_type)} ${directionText}`,
        url: alertUrl(alert),
        app: alert.app_enabled,
        push: alert.push_enabled,
        metadata: {
          alertId: alert.id,
          assetType: alert.asset_type,
          market: alert.market,
          symbol: cleanSymbol(alert.symbol),
          currentPrice,
          targetPrice: target,
          direction: alert.direction
        }
      });
      update.last_triggered_at = now.toISOString();
      if (!alert.repeat_enabled) update.enabled = false;
    }
    const { error } = await supabase.from("price_alerts").update(update).eq("id", alert.id);
    if (error) throw error;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await supabase.from("price_alerts").update({
      last_checked_at: now.toISOString(),
      last_error: message.slice(0, 300),
      updated_at: now.toISOString()
    }).eq("id", alert.id);
  }
}
async function runPriceAlertMonitorOnce() {
  if (priceMonitorRunning) return { checked: 0, skipped: "ALREADY_RUNNING" };
  if (!isSupabaseConfigured()) return { checked: 0, skipped: "SUPABASE_NOT_CONFIGURED" };
  priceMonitorRunning = true;
  try {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const { data, error } = await getSupabase().from("price_alerts").select("*").eq("enabled", true).or(`expires_at.is.null,expires_at.gt.${now}`).order("updated_at", { ascending: true }).limit(500);
    if (error) throw error;
    const alerts = data ?? [];
    for (let index = 0; index < alerts.length; index += 5) {
      await Promise.all(alerts.slice(index, index + 5).map(evaluatePriceAlert));
    }
    return { checked: alerts.length };
  } finally {
    priceMonitorRunning = false;
  }
}
function startPriceAlertMonitor() {
  if (priceMonitorTimer) return;
  const configured = Number(process.env.PRICE_ALERT_MONITOR_INTERVAL_MS ?? 6e4);
  const intervalMs = Math.max(3e4, Math.min(15 * 6e4, Number.isFinite(configured) ? configured : 6e4));
  const run = () => {
    void runPriceAlertMonitorOnce().catch((error) => {
      console.error("price alert monitor error:", error);
    });
  };
  const initialTimer = setTimeout(run, 1e4);
  initialTimer.unref?.();
  priceMonitorTimer = setInterval(run, intervalMs);
  priceMonitorTimer.unref?.();
  console.log(`[api-server] price alert monitor enabled (${intervalMs}ms)`);
}

// src/routes/push.ts
var router5 = Router5();
function getEndpoint(body) {
  if (!body || typeof body !== "object") return null;
  const endpoint = body.endpoint;
  return typeof endpoint === "string" && endpoint.length > 0 ? endpoint : null;
}
router5.get("/notifications/preferences", async (req, res) => {
  try {
    return res.json({ preferences: await ensureNotificationPreferences(req.member.id), vapidReady: isVapidReady() });
  } catch (error) {
    console.error("notification preferences read error:", error);
    return res.status(500).json({ error: "NOTIFICATION_PREFERENCES_READ_FAILED" });
  }
});
router5.put("/notifications/preferences", async (req, res) => {
  const enabledTypes = Array.isArray(req.body?.enabledTypes) ? [...new Set(req.body.enabledTypes.map(String))].filter((item) => DEFAULT_NOTIFICATION_TYPES.includes(item)) : [...DEFAULT_NOTIFICATION_TYPES];
  const changes = { member_id: req.member.id, enabled_types: enabledTypes, app_enabled: req.body?.appEnabled !== false, push_enabled: req.body?.pushEnabled === true, updated_at: (/* @__PURE__ */ new Date()).toISOString() };
  const { data, error } = await getSupabase().from("notification_preferences").upsert(changes, { onConflict: "member_id" }).select("*").single();
  if (error) return res.status(500).json({ error: "NOTIFICATION_PREFERENCES_SAVE_FAILED" });
  return res.json({ preferences: data });
});
router5.post("/push/subscribe", async (req, res) => {
  const endpoint = getEndpoint(req.body);
  if (!endpoint) return res.status(400).json({ error: "INVALID_SUBSCRIPTION" });
  const { error } = await getSupabase().from("push_subscriptions").upsert({ member_id: req.member.id, endpoint, subscription: req.body, updated_at: (/* @__PURE__ */ new Date()).toISOString() }, { onConflict: "endpoint" });
  if (error) return res.status(500).json({ error: "PUSH_SUBSCRIPTION_SAVE_FAILED" });
  await getSupabase().from("notification_preferences").upsert({ member_id: req.member.id, push_enabled: true, updated_at: (/* @__PURE__ */ new Date()).toISOString() }, { onConflict: "member_id" });
  const { count } = await getSupabase().from("push_subscriptions").select("*", { count: "exact", head: true }).eq("member_id", req.member.id);
  return res.json({ ok: true, count: count ?? 0, vapidReady: isVapidReady() });
});
router5.post("/push/unsubscribe", async (req, res) => {
  const endpoint = getEndpoint(req.body);
  if (!endpoint) return res.status(400).json({ error: "INVALID_ENDPOINT" });
  const { error } = await getSupabase().from("push_subscriptions").delete().eq("member_id", req.member.id).eq("endpoint", endpoint);
  if (error) return res.status(500).json({ error: "PUSH_UNSUBSCRIBE_FAILED" });
  return res.json({ ok: true });
});
router5.post("/push/test", async (req, res) => {
  const body = typeof req.body === "object" && req.body ? req.body : {};
  const result = await deliverMemberNotification({
    memberId: req.member.id,
    type: "system",
    title: String(body.title ?? "\uC9C0\uC2DD\uC815\uBCF4 \uD14C\uC2A4\uD2B8 \uC54C\uB9BC"),
    body: String(body.body ?? "\uD68C\uC6D0\uBCC4 \uD1B5\uD569 \uC54C\uB9BC \uC5F0\uACB0 \uD14C\uC2A4\uD2B8\uC785\uB2C8\uB2E4."),
    url: String(body.url ?? "/alerts"),
    app: true,
    push: true
  });
  return res.json({ ok: true, ...result, vapidReady: isVapidReady() });
});
router5.post("/notifications/price-alerts/check-now", async (_req, res) => {
  try {
    return res.json({ ok: true, ...await runPriceAlertMonitorOnce() });
  } catch (error) {
    console.error("price alert manual check error:", error);
    return res.status(500).json({ error: "PRICE_ALERT_CHECK_FAILED" });
  }
});
router5.get("/notifications/history", async (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit ?? 100) || 100));
  const { data, error } = await getSupabase().from("notification_history").select("*").eq("member_id", req.member.id).order("created_at", { ascending: false }).limit(limit);
  if (error) return res.status(500).json({ error: "NOTIFICATION_HISTORY_READ_FAILED" });
  return res.json({ notifications: data ?? [], count: data?.length ?? 0 });
});
router5.patch("/notifications/history/:id/read", async (req, res) => {
  const { data, error } = await getSupabase().from("notification_history").update({ read_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("id", req.params.id).eq("member_id", req.member.id).select("*").maybeSingle();
  if (error) return res.status(500).json({ error: "NOTIFICATION_HISTORY_UPDATE_FAILED" });
  return res.json({ notification: data });
});
router5.get("/notifications/price-alerts", async (req, res) => {
  const { data, error } = await getSupabase().from("price_alerts").select("*").eq("member_id", req.member.id).order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: "PRICE_ALERT_LIST_FAILED" });
  return res.json({ alerts: data ?? [] });
});
router5.post("/notifications/price-alerts", async (req, res) => {
  const assetType = ["stock", "coin_spot", "coin_futures"].includes(String(req.body?.assetType)) ? String(req.body.assetType) : null;
  const direction = ["above", "below"].includes(String(req.body?.direction)) ? String(req.body.direction) : null;
  const symbol = String(req.body?.symbol ?? "").trim().toUpperCase();
  const targetPrice = Number(req.body?.targetPrice);
  if (!assetType || !direction || !symbol || !Number.isFinite(targetPrice) || targetPrice <= 0) return res.status(400).json({ error: "INVALID_PRICE_ALERT" });
  const row = { member_id: req.member.id, asset_type: assetType, market: String(req.body?.market ?? ""), symbol, direction, target_price: targetPrice, repeat_enabled: req.body?.repeatEnabled === true, app_enabled: req.body?.appEnabled !== false, push_enabled: req.body?.pushEnabled !== false, expires_at: req.body?.expiresAt || null, enabled: true, updated_at: (/* @__PURE__ */ new Date()).toISOString() };
  const { data, error } = await getSupabase().from("price_alerts").upsert(row, { onConflict: "member_id,asset_type,market,symbol,direction,target_price" }).select("*").single();
  if (error) return res.status(500).json({ error: "PRICE_ALERT_SAVE_FAILED" });
  return res.json({ alert: data });
});
router5.delete("/notifications/price-alerts/:id", async (req, res) => {
  const { error } = await getSupabase().from("price_alerts").delete().eq("id", req.params.id).eq("member_id", req.member.id);
  if (error) return res.status(500).json({ error: "PRICE_ALERT_DELETE_FAILED" });
  return res.json({ ok: true });
});
var push_default = router5;

// src/routes/stocks.ts
import { Router as Router6 } from "express";
import { mkdir as mkdir2, readFile as readFile2, writeFile as writeFile2 } from "node:fs/promises";
import path4 from "node:path";
import { randomUUID } from "node:crypto";

// src/middleware/auth.ts
function bearerToken(req) {
  const value = req.header("authorization") ?? "";
  return value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() : null;
}
async function requireMember(req, res, next) {
  if (!isSupabaseConfigured()) return res.status(503).json({ error: "AUTH_NOT_CONFIGURED" });
  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: "LOGIN_REQUIRED" });
  const supabase = getSupabase();
  const { data: auth, error: authError } = await supabase.auth.getUser(token);
  if (authError || !auth.user) return res.status(401).json({ error: "INVALID_SESSION" });
  const { data: profile, error } = await supabase.from("profiles").select("*").eq("id", auth.user.id).single();
  if (error || !profile) return res.status(403).json({ error: "PROFILE_NOT_FOUND" });
  if (profile.status !== "approved") return res.status(403).json({ error: "MEMBER_NOT_APPROVED", status: profile.status });
  req.member = profile;
  req.accessToken = token;
  return next();
}
function requireAdmin(req, res, next) {
  if (req.member?.role !== "admin") return res.status(403).json({ error: "ADMIN_REQUIRED" });
  return next();
}

// src/routes/stocks.ts
var router6 = Router6();
var liveDataCache = /* @__PURE__ */ new Map();
async function withLiveCache(key, ttlMs, loader) {
  const cached2 = liveDataCache.get(key);
  if (cached2 && cached2.expiresAt > Date.now()) return cached2.value;
  const value = await loader();
  liveDataCache.set(key, { expiresAt: Date.now() + ttlMs, value });
  if (liveDataCache.size > 300) {
    for (const [cacheKey, entry] of liveDataCache) {
      if (entry.expiresAt <= Date.now()) liveDataCache.delete(cacheKey);
    }
  }
  return value;
}
router6.get("/server-ip", requireAdmin, async (_req, res) => {
  const providers = [
    "https://api.ipify.org?format=json",
    "https://ifconfig.me/all.json",
    "https://checkip.amazonaws.com"
  ];
  const attempts = [];
  for (const provider of providers) {
    try {
      const response = await fetch(provider, {
        headers: {
          Accept: "application/json,text/plain;q=0.9,*/*;q=0.8",
          "User-Agent": "seungjae-stock-app/1.0"
        }
      });
      if (!response.ok) {
        attempts.push({
          provider,
          ok: false,
          status: response.status
        });
        continue;
      }
      const raw = (await response.text()).trim();
      let ip = raw;
      try {
        const parsed = JSON.parse(raw);
        ip = String(
          parsed.ip ?? parsed.ip_addr ?? parsed.address ?? parsed.ipv4 ?? parsed.ipv6 ?? ""
        ).trim();
      } catch {
      }
      const matchedIp = ip.match(
        /(?:\d{1,3}\.){3}\d{1,3}|(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}/
      )?.[0] ?? "";
      if (!matchedIp) {
        attempts.push({
          provider,
          ok: false,
          error: "IP_ADDRESS_NOT_FOUND"
        });
        continue;
      }
      res.setHeader("Cache-Control", "no-store");
      res.json({
        ok: true,
        ip: matchedIp,
        provider,
        checkedAt: (/* @__PURE__ */ new Date()).toISOString(),
        note: "\uC774 \uAC12\uC740 \uD604\uC7AC \uC2E4\uD589 \uC911\uC778 Replit \uC11C\uBC84\uC758 \uC678\uBD80 \uC694\uCCAD IP\uC785\uB2C8\uB2E4. \uC11C\uBC84 \uC7AC\uC2DC\uC791\xB7\uC7AC\uBC30\uD3EC\xB7\uC2E4\uD589 \uD658\uACBD \uBCC0\uACBD \uC2DC \uB2EC\uB77C\uC9C8 \uC218 \uC788\uC2B5\uB2C8\uB2E4."
      });
      return;
    } catch (error) {
      attempts.push({
        provider,
        ok: false,
        error: error instanceof Error ? error.message : "UNKNOWN_SERVER_IP_ERROR"
      });
    }
  }
  res.status(502).json({
    ok: false,
    error: "SERVER_IP_LOOKUP_FAILED",
    attempts
  });
});
function normalizeTicker4(value) {
  return String(value ?? "").trim().toUpperCase();
}
function normalizeTimeframe2(value) {
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
  try {
    return await getCorpCode(ticker);
  } catch {
  }
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
async function fetchDartFilings(ticker, allHistory = false) {
  const apiKey = String(process.env.DART_API_KEY ?? "").trim();
  const ymd3 = (date) => date.toISOString().slice(0, 10).replace(/-/g, "");
  const endDate = /* @__PURE__ */ new Date();
  const startDate = allHistory ? /* @__PURE__ */ new Date("1990-01-01T00:00:00+09:00") : new Date(endDate.getTime() - 3 * 365 * 24 * 60 * 60 * 1e3);
  const fallback = {
    title: "DART\uC5D0\uC11C " + ticker + " \uACF5\uC2DC \uC804\uCCB4\uBCF4\uAE30",
    report_nm: "\uACF5\uC2DD \uC804\uC790\uACF5\uC2DC \uAC80\uC0C9",
    date: "\uC2E4\uC2DC\uAC04",
    rcept_dt: "",
    url: "https://dart.fss.or.kr/dsab001/main.do",
    source: "DART"
  };
  if (!apiKey || !/^\d{6}$/.test(ticker)) return [];
  const corpCode = await getDartCorpCode(ticker, apiKey);
  if (!corpCode) return [fallback];
  const items = [];
  let pageNo = 1;
  let totalPage = 1;
  do {
    const query = new URLSearchParams({
      crtfc_key: apiKey,
      corp_code: corpCode,
      bgn_de: ymd3(startDate),
      end_de: ymd3(endDate),
      last_reprt_at: "N",
      page_no: String(pageNo),
      page_count: "100",
      sort: "date",
      sort_mth: "desc"
    });
    const response = await fetch(
      "https://opendart.fss.or.kr/api/list.json?" + query.toString()
    );
    if (!response.ok) throw new Error("DART_LIST_HTTP_" + response.status);
    const data = await response.json();
    if (data?.status && data.status !== "000" && data.status !== "013") {
      throw new Error(`DART_LIST_${String(data.status)}:${String(data.message ?? "")}`);
    }
    if (Array.isArray(data?.list)) items.push(...data.list);
    totalPage = Math.max(1, Number(data?.total_page ?? 1) || 1);
    pageNo += 1;
  } while (pageNo <= totalPage && (allHistory || pageNo <= 1));
  const unique = /* @__PURE__ */ new Map();
  for (const item of items) {
    const key = String(item?.rcept_no ?? `${item?.rcept_dt}:${item?.report_nm}`);
    if (!unique.has(key)) unique.set(key, item);
  }
  const result = [...unique.values()].map((item) => ({
    ...item,
    title: item.report_nm,
    date: item.rcept_dt,
    url: item.rcept_no ? "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=" + item.rcept_no : fallback.url,
    source: "DART"
  }));
  const grouped = /* @__PURE__ */ new Map();
  for (const item of result) {
    const normalizedTitle = String(item.report_nm ?? item.title ?? "").toLowerCase().replace(/\[[^\]]*\]|\([^)]*\)/g, "").replace(/정정|첨부정정|기재정정/g, "").replace(/[^0-9a-z가-힣]/g, "");
    const existing = grouped.get(normalizedTitle);
    if (existing) existing.relatedCount = Number(existing.relatedCount ?? 1) + 1;
    else grouped.set(normalizedTitle, { ...item, relatedCount: 1 });
  }
  const groupedItems = [...grouped.values()];
  return allHistory ? groupedItems : groupedItems.slice(0, 5);
}
var secTickerMapCache = null;
function secHeaders() {
  return {
    Accept: "application/json",
    "User-Agent": String(process.env.SEC_USER_AGENT ?? "").trim() || "seungjae-stock-app/1.0 seungjae3908@gmail.com"
  };
}
async function getSecCik(ticker) {
  if (!secTickerMapCache) {
    const response = await fetch("https://www.sec.gov/files/company_tickers.json", {
      headers: secHeaders()
    });
    if (!response.ok) throw new Error("SEC_TICKERS_HTTP_" + response.status);
    const data = await response.json();
    const map = /* @__PURE__ */ new Map();
    for (const entry of Object.values(data)) {
      const symbol = String(entry?.ticker ?? "").trim().toUpperCase();
      const cik = String(entry?.cik_str ?? "").replace(/\D/g, "").padStart(10, "0");
      if (symbol && cik) map.set(symbol, cik);
    }
    secTickerMapCache = map;
  }
  return secTickerMapCache.get(ticker.trim().toUpperCase()) ?? "";
}
function secColumnRows(source, cik) {
  const count = Math.max(
    ...Object.values(source ?? {}).map(
      (value) => Array.isArray(value) ? value.length : 0
    ),
    0
  );
  const rows = [];
  const cikNoZero = String(Number(cik));
  for (let index = 0; index < count; index += 1) {
    const accessionNumber = String(source?.accessionNumber?.[index] ?? "");
    const primaryDocument = String(source?.primaryDocument?.[index] ?? "");
    const filingDate = String(source?.filingDate?.[index] ?? "");
    const form = String(source?.form?.[index] ?? "");
    if (!accessionNumber || !filingDate) continue;
    rows.push({
      accessionNumber,
      filingDate,
      date: filingDate,
      acceptedAt: source?.acceptanceDateTime?.[index] ?? filingDate,
      form,
      title: form ? `${form} \uC81C\uCD9C` : "SEC \uACF5\uC2DC",
      primaryDocument,
      reportDate: source?.reportDate?.[index] ?? "",
      url: primaryDocument ? `https://www.sec.gov/Archives/edgar/data/${cikNoZero}/${accessionNumber.replace(/-/g, "")}/${primaryDocument}` : `https://www.sec.gov/Archives/edgar/data/${cikNoZero}/${accessionNumber.replace(/-/g, "")}/`,
      source: "SEC EDGAR"
    });
  }
  return rows;
}
async function fetchSecFilings(ticker) {
  const cik = await getSecCik(ticker);
  if (!cik) return [];
  const response = await fetch(
    `https://data.sec.gov/submissions/CIK${cik}.json`,
    { headers: secHeaders() }
  );
  if (!response.ok) throw new Error("SEC_SUBMISSIONS_HTTP_" + response.status);
  const data = await response.json();
  const items = secColumnRows(data?.filings?.recent ?? {}, cik);
  for (const file of Array.isArray(data?.filings?.files) ? data.filings.files : []) {
    const name = String(file?.name ?? "").trim();
    if (!name) continue;
    const historyResponse = await fetch(
      `https://data.sec.gov/submissions/${encodeURIComponent(name)}`,
      { headers: secHeaders() }
    );
    if (!historyResponse.ok) continue;
    const history = await historyResponse.json();
    items.push(...secColumnRows(history, cik));
  }
  const unique = /* @__PURE__ */ new Map();
  for (const item of items) {
    if (!unique.has(item.accessionNumber)) unique.set(item.accessionNumber, item);
  }
  return [...unique.values()].sort(
    (a, b) => String(b.filingDate).localeCompare(String(a.filingDate))
  );
}
async function fetchAllFilings(ticker, allHistory = false) {
  return /^\d{6}$/.test(ticker) ? fetchDartFilings(ticker, allHistory) : fetchSecFilings(ticker).then((items) => allHistory ? items : items.slice(0, 5));
}
function metricRow(rows, patterns) {
  return rows.find((cells) => patterns.some((pattern) => pattern.test(cells[0] ?? "")));
}
function financialNumber(value) {
  if (value == null) return null;
  const raw = String(value).replace(/&#40;|\$#40;|#40;/gi, "(").replace(/&#41;|\$#41;|#41;/gi, ")").replace(/&nbsp;|&#160;/gi, " ").replace(/,/g, "").replace(/%/g, "").trim();
  if (!raw || raw === "-" || raw === "N/A") return null;
  const negative = /^\(.*\)$/.test(raw);
  const normalized = raw.replace(/[()]/g, "").replace(/[^0-9+\-.]/g, "");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed === 0) return null;
  return negative ? -Math.abs(parsed) : parsed;
}
function periodIsAvailable(period) {
  const clean = period.replace(/\(E\)/gi, "").replace(/[^0-9.]/g, "");
  const match = clean.match(/^(20\d{2})(?:\.(\d{2}))?/);
  if (!match) return true;
  const year = Number(match[1]);
  const month = Number(match[2] ?? 12);
  const now = /* @__PURE__ */ new Date();
  return year < now.getFullYear() || year === now.getFullYear() && month <= now.getMonth() + 1;
}
function buildNaverFinancialRows(html) {
  const table = financeTableRows(html);
  const periodCells = table.find((cells) => cells.filter((cell) => /^20\d{2}\.\d{2}/.test(cell)).length >= 4) ?? [];
  const periods = periodCells.filter((cell) => /^20\d{2}\.\d{2}/.test(cell));
  if (!periods.length) return { annual: [], quarterly: [], ratios: {}, marketCap: null };
  const marketCapMatch = html.match(/id=["']_market_sum["'][^>]*>([\s\S]*?)<\/em>/i);
  const marketCapHundredMillion = financialNumber(
    marketCapMatch ? cleanFinanceCell(marketCapMatch[1]) : null
  );
  const marketCap = marketCapHundredMillion == null ? null : marketCapHundredMillion * 1e8;
  const definitions = {
    revenue: [/^매출액/, /^영업수익/],
    operatingIncome: [/^영업이익/],
    netIncome: [/^당기순이익/, /^순이익/],
    assets: [/^자산총계/],
    liabilities: [/^부채총계/],
    equity: [/^자본총계/],
    capitalStock: [/^자본금/],
    cash: [/^현금및현금성자산/, /^현금 및 현금성자산/],
    operatingCashFlow: [/^영업활동.*현금흐름/],
    investingCashFlow: [/^투자활동.*현금흐름/],
    financingCashFlow: [/^재무활동.*현금흐름/],
    roe: [/^ROE/],
    per: [/^PER/],
    pbr: [/^PBR/]
  };
  const metricRows = Object.fromEntries(
    Object.entries(definitions).map(([key, patterns]) => [key, metricRow(table, [...patterns])])
  );
  const valuesAt = (key, index) => financialNumber(metricRows[key]?.[index + 1]);
  const rows = periods.filter(periodIsAvailable).map((period, index) => ({
    period: period.replace(/&#40;|\$#40;|#40;/gi, "(").replace(/&#41;|\$#41;|#41;/gi, ")").replace(/\(E\)/g, "").replace(/<[^>]+>/g, "").trim(),
    revenue: valuesAt("revenue", index),
    operatingIncome: valuesAt("operatingIncome", index),
    netIncome: valuesAt("netIncome", index),
    assets: valuesAt("assets", index),
    liabilities: valuesAt("liabilities", index),
    equity: valuesAt("equity", index),
    capitalStock: valuesAt("capitalStock", index),
    cash: valuesAt("cash", index),
    operatingCashFlow: valuesAt("operatingCashFlow", index),
    investingCashFlow: valuesAt("investingCashFlow", index),
    financingCashFlow: valuesAt("financingCashFlow", index)
  }));
  const annual = rows.filter((row) => /\.12/.test(row.period)).slice(0, 5);
  const quarterly = rows.filter((row) => !/\.12/.test(row.period)).slice(0, 6);
  const latestIndex = 0;
  return {
    annual,
    yearly: annual,
    quarterly,
    quarters: quarterly,
    ratios: {
      roe: valuesAt("roe", latestIndex),
      per: valuesAt("per", latestIndex),
      pbr: valuesAt("pbr", latestIndex),
      debtRatio: annual[0]?.liabilities != null && annual[0]?.equity ? annual[0].liabilities / annual[0].equity * 100 : null
    },
    marketCap,
    source: "NAVER_FINANCE",
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
async function fetchNaverFinancials(ticker) {
  const response = await fetch(
    `https://finance.naver.com/item/main.naver?code=${encodeURIComponent(ticker)}`,
    { headers: { "User-Agent": "Mozilla/5.0", Referer: "https://finance.naver.com/" } }
  );
  if (!response.ok) throw new Error("NAVER_FINANCIAL_HTTP_" + response.status);
  return buildNaverFinancialRows(await response.text());
}
function secFactUnits(data, tags) {
  for (const tag of tags) {
    const units = data?.facts?.["us-gaap"]?.[tag]?.units;
    if (!units || typeof units !== "object") continue;
    const first = Object.values(units).find((value) => Array.isArray(value));
    if (Array.isArray(first)) return first;
  }
  return [];
}
function secFactValueFor(data, tags, end, form) {
  for (const tag of tags) {
    const matches = secFactUnits(data, [tag]).filter((item) => String(item?.end ?? "") === end && String(item?.form ?? "") === form).sort((a, b) => String(b?.filed ?? "").localeCompare(String(a?.filed ?? "")));
    const value = financialNumber(matches[0]?.val);
    if (value != null) return value;
  }
  return null;
}
async function fetchSecFinancials(ticker) {
  const cik = await getSecCik(ticker);
  if (!cik) return { annual: [], quarterly: [], ratios: {}, source: "SEC_COMPANYFACTS", updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
  const response = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, { headers: secHeaders() });
  if (!response.ok) throw new Error("SEC_COMPANYFACTS_HTTP_" + response.status);
  const data = await response.json();
  const revenueTags = ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet"];
  const seed = secFactUnits(data, revenueTags).filter((item) => ["10-K", "10-Q"].includes(String(item?.form ?? "")) && item?.end);
  const periods = [...new Map(seed.map((item) => [`${item.form}:${item.end}`, { end: String(item.end), form: String(item.form), fy: Number(item.fy), fp: String(item.fp ?? "") }])).values()].filter((item) => Date.parse(item.end) <= Date.now()).sort((a, b) => b.end.localeCompare(a.end));
  const tags = {
    revenue: revenueTags,
    operatingIncome: ["OperatingIncomeLoss"],
    netIncome: ["NetIncomeLoss", "ProfitLoss"],
    assets: ["Assets"],
    liabilities: ["Liabilities"],
    equity: ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
    capitalStock: ["CommonStocksIncludingAdditionalPaidInCapital", "CommonStockValue", "AdditionalPaidInCapital"],
    cash: ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"],
    operatingCashFlow: ["NetCashProvidedByUsedInOperatingActivities"],
    investingCashFlow: ["NetCashProvidedByUsedInInvestingActivities"],
    financingCashFlow: ["NetCashProvidedByUsedInFinancingActivities"]
  };
  const build = (period) => ({
    period: period.end.slice(0, 7).replace("-", "."),
    periodLabel: `${period.fy || period.end.slice(0, 4)} ${period.fp || (period.form === "10-K" ? "\uC5F0\uAC04" : "\uBD84\uAE30")}`,
    revenue: secFactValueFor(data, tags.revenue, period.end, period.form),
    operatingIncome: secFactValueFor(data, tags.operatingIncome, period.end, period.form),
    netIncome: secFactValueFor(data, tags.netIncome, period.end, period.form),
    assets: secFactValueFor(data, tags.assets, period.end, period.form),
    liabilities: secFactValueFor(data, tags.liabilities, period.end, period.form),
    equity: secFactValueFor(data, tags.equity, period.end, period.form),
    capitalStock: secFactValueFor(data, tags.capitalStock, period.end, period.form),
    cash: secFactValueFor(data, tags.cash, period.end, period.form),
    operatingCashFlow: secFactValueFor(data, tags.operatingCashFlow, period.end, period.form),
    investingCashFlow: secFactValueFor(data, tags.investingCashFlow, period.end, period.form),
    financingCashFlow: secFactValueFor(data, tags.financingCashFlow, period.end, period.form)
  });
  const annual = periods.filter((item) => item.form === "10-K").slice(0, 5).map(build);
  const quarterly = periods.filter((item) => item.form === "10-Q").slice(0, 8).map(build);
  const latest = annual[0] ?? quarterly[0];
  return { annual, yearly: annual, quarterly, quarters: quarterly, ratios: { debtRatio: latest?.liabilities != null && latest?.equity ? latest.liabilities / latest.equity * 100 : null }, source: "SEC_COMPANYFACTS", updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
}
async function fetchFinancials(ticker) {
  if (/^\d{6}$/.test(ticker)) {
    const [raw, naver] = await Promise.all([
      getFinancials3(ticker),
      fetchNaverFinancials(ticker).catch(() => null)
    ]);
    const equity = Number(raw.latest?.equity ?? 0);
    const netIncome = Number(raw.latest?.netIncome ?? 0);
    const liabilities = Number(raw.latest?.liabilities ?? 0);
    const latestAnnual = Array.isArray(raw.annual) ? raw.annual.at(-1) : null;
    const latestRevenue = Number(latestAnnual?.revenue ?? 0);
    const marketCap = Number(naver?.marketCap ?? 0);
    const naverRatios = naver?.ratios ?? {};
    return {
      ...raw,
      yearly: raw.annual,
      quarters: raw.quarterly,
      ratios: {
        roe: financialNumber(naverRatios.roe) ?? (equity ? netIncome / equity * 100 : null),
        debtRatio: equity ? liabilities / equity * 100 : null,
        per: financialNumber(naverRatios.per),
        pbr: financialNumber(naverRatios.pbr),
        psr: marketCap > 0 && latestRevenue > 0 ? marketCap / latestRevenue : null
      },
      marketCap: marketCap || null,
      source: "OPEN_DART",
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
  }
  return fetchSecFinancials(ticker);
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
async function fetchGoogleNews(ticker, allHistory = false) {
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
  const normalized = (title, source) => {
    const suffix = source ? " - " + source.toLowerCase() : "";
    let value = title.toLowerCase().replace(/\s+/g, " ").trim();
    if (suffix && value.endsWith(suffix)) value = value.slice(0, -suffix.length);
    return value.replace(/\[[^\]]+\]|\([^)]*\)/g, " ").replace(/[^0-9a-z가-힣]+/g, "").slice(0, 80);
  };
  const grouped = /* @__PURE__ */ new Map();
  const items = (xml.match(/<item>[\s\S]*?<\/item>/g) ?? []).slice(0, 100).map((block) => ({
    title: xmlTag(block, "title"),
    url: xmlTag(block, "link"),
    link: xmlTag(block, "link"),
    publishedAt: xmlTag(block, "pubDate"),
    date: xmlTag(block, "pubDate"),
    source: xmlTag(block, "source") || "Google News",
    description: cleanFinanceCell(xmlTag(block, "description")),
    summary: cleanFinanceCell(xmlTag(block, "description"))
  })).filter((item) => {
    const timestamp = Date.parse(item.publishedAt);
    return item.title && item.url && Number.isFinite(timestamp);
  }).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  for (const item of items) {
    const key = normalized(item.title, item.source) || item.url;
    const existing = grouped.get(key);
    if (existing) existing.relatedCount = Number(existing.relatedCount ?? 1) + 1;
    else grouped.set(key, { ...item, relatedCount: 1 });
  }
  const groupedItems = [...grouped.values()];
  return allHistory ? groupedItems : groupedItems.slice(0, 5);
}
var autoTradeExecuted = /* @__PURE__ */ new Set();
var autoTradePositions = /* @__PURE__ */ new Map();
var autoTradeJournal = [];
var autoTradePositionFile = path4.resolve(
  process.env.KIWOOM_AUTO_TRADE_POSITION_FILE?.trim() || "data/auto-trade-positions.json"
);
var autoTradeJournalFile = path4.resolve(
  process.env.KIWOOM_AUTO_TRADE_JOURNAL_FILE?.trim() || "data/auto-trade-journal.json"
);
var autoTradePositionsLoaded = false;
function autoTradePositionKey(memberId, market, ticker) {
  return `${memberId}:${market}:${ticker}`;
}
async function ensureAutoTradePositionsLoaded() {
  if (autoTradePositionsLoaded) return;
  autoTradePositionsLoaded = true;
  try {
    const parsed = JSON.parse(await readFile2(autoTradePositionFile, "utf8"));
    if (!Array.isArray(parsed)) return;
    for (const raw of parsed) {
      const position = raw;
      const memberId = String(position.memberId ?? "").trim();
      if (!memberId) continue;
      const ticker = normalizeTicker4(position.ticker);
      const market = position.market === "US" ? "US" : "KR";
      const currency = market === "US" ? "USD" : "KRW";
      const exchange = market === "US" && ["NASDAQ", "NYSE", "AMEX"].includes(String(position.exchange)) ? position.exchange : null;
      const quantity = Math.trunc(Number(position.quantity));
      const entryPrice = Number(position.entryPrice);
      const stopPrice = Number(position.stopPrice);
      const targetPrice = Number(position.targetPrice);
      if ((market === "KR" ? /^\d{6}$/.test(ticker) : /^[A-Z][A-Z0-9.-]{0,11}$/.test(ticker)) && (market === "KR" || exchange !== null) && quantity > 0 && entryPrice > 0 && stopPrice > 0 && targetPrice > 0) {
        autoTradePositions.set(autoTradePositionKey(memberId, market, ticker), {
          memberId,
          ticker,
          name: String(position.name ?? ticker),
          market,
          currency,
          exchange,
          quantity,
          entryPrice,
          stopPrice,
          targetPrice,
          probability: Number(position.probability ?? 0),
          reasons: Array.isArray(position.reasons) ? position.reasons.map(String) : [],
          journalId: String(position.journalId ?? `${position.openedAt ?? "legacy"}:${ticker}`),
          openedAt: String(position.openedAt ?? (/* @__PURE__ */ new Date()).toISOString()),
          exitSignalReason: position.exitSignalReason ? String(position.exitSignalReason) : null,
          exitSignalAt: position.exitSignalAt ? String(position.exitSignalAt) : null
        });
      }
    }
  } catch {
  }
  try {
    const parsed = JSON.parse(await readFile2(autoTradeJournalFile, "utf8"));
    autoTradeJournal = Array.isArray(parsed) ? parsed.slice(-500).flatMap((raw) => {
      const entry = raw;
      const memberId = String(entry.memberId ?? "").trim();
      if (!memberId) return [];
      const market = entry.market === "US" ? "US" : "KR";
      return [{
        ...entry,
        memberId,
        market,
        currency: market === "US" ? "USD" : "KRW",
        exchange: market === "US" && ["NASDAQ", "NYSE", "AMEX"].includes(String(entry.exchange)) ? entry.exchange : null
      }];
    }) : [];
  } catch {
    autoTradeJournal = [];
  }
}
async function saveAutoTradePositions() {
  await mkdir2(path4.dirname(autoTradePositionFile), { recursive: true });
  await writeFile2(
    autoTradePositionFile,
    JSON.stringify([...autoTradePositions.values()], null, 2),
    "utf8"
  );
}
async function saveAutoTradeJournal() {
  await mkdir2(path4.dirname(autoTradeJournalFile), { recursive: true });
  await writeFile2(
    autoTradeJournalFile,
    JSON.stringify(autoTradeJournal.slice(-500), null, 2),
    "utf8"
  );
}
function marketTimeParts(timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(/* @__PURE__ */ new Date());
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}
function marketOpenNow(market) {
  if (process.env.KIWOOM_AUTO_TRADE_ALLOW_OFF_HOURS === "true") return true;
  const parts = marketTimeParts(market === "US" ? "America/New_York" : "Asia/Seoul");
  if (["Sat", "Sun"].includes(parts.weekday)) return false;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return market === "US" ? minutes >= 9 * 60 + 30 && minutes < 16 * 60 : minutes >= 9 * 60 && minutes <= 15 * 60 + 30;
}
function marketDateString(market, value = /* @__PURE__ */ new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: market === "US" ? "America/New_York" : "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}
function normalizeUsExchange(value, ticker) {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (normalized === "NASDAQ" || normalized === "NASD" || normalized === "ND") return "NASDAQ";
  if (normalized === "NYSE" || normalized === "NY") return "NYSE";
  if (normalized === "AMEX" || normalized === "NYSE AMERICAN" || normalized === "NA") return "AMEX";
  if (["AAPL", "MSFT", "NVDA", "AMZN", "META", "TSLA"].includes(ticker)) return "NASDAQ";
  return null;
}
function formatTradePrice(value, currency) {
  return new Intl.NumberFormat(currency === "USD" ? "en-US" : "ko-KR", {
    style: "currency",
    currency,
    maximumFractionDigits: currency === "USD" ? 2 : 0
  }).format(value);
}
var autoTradeApprovalPlans = /* @__PURE__ */ new Map();
var autoTradeCloseApprovalPlans = /* @__PURE__ */ new Map();
function cleanupAutoTradeApprovalPlans() {
  const now = Date.now();
  for (const [token, plan] of autoTradeApprovalPlans) {
    if (plan.expiresAt <= now) autoTradeApprovalPlans.delete(token);
  }
  for (const [token, plan] of autoTradeCloseApprovalPlans) {
    if (plan.expiresAt <= now) autoTradeCloseApprovalPlans.delete(token);
  }
}
function validateRealOrderAccess(req) {
  const enabled = process.env.KIWOOM_AUTO_TRADE_ENABLED === "true";
  const realMode = String(process.env.KIWOOM_MODE ?? "").trim().toLowerCase() === "real";
  const configuredKey = String(process.env.KIWOOM_AUTO_TRADE_KEY ?? "").trim();
  const suppliedKey = String(req.header("X-Auto-Trade-Key") ?? "").trim();
  if (!enabled) return { ok: false, status: 403, message: "\uC11C\uBC84\uC758 \uC2E4\uC81C \uC790\uB3D9\uB9E4\uB9E4 \uAE30\uB2A5\uC774 \uAEBC\uC838 \uC788\uC2B5\uB2C8\uB2E4." };
  if (!realMode) return { ok: false, status: 409, message: "\uC2E4\uC81C \uC8FC\uBB38\uC740 KIWOOM_MODE=real \uC124\uC815\uC774 \uD544\uC694\uD569\uB2C8\uB2E4." };
  if (!configuredKey || suppliedKey !== configuredKey) return { ok: false, status: 401, message: "\uC790\uB3D9\uB9E4\uB9E4 \uC2E4\uD589\uD0A4\uAC00 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4." };
  if (!req.member?.id) return { ok: false, status: 401, message: "\uB85C\uADF8\uC778\uC774 \uD544\uC694\uD569\uB2C8\uB2E4." };
  return { ok: true };
}
router6.post("/auto-trade/plan", async (req, res) => {
  const enabled = process.env.KIWOOM_AUTO_TRADE_ENABLED === "true";
  const realMode = String(process.env.KIWOOM_MODE ?? "").trim().toLowerCase() === "real";
  const configuredKey = String(process.env.KIWOOM_AUTO_TRADE_KEY ?? "").trim();
  const suppliedKey = String(req.header("X-Auto-Trade-Key") ?? "").trim();
  if (!enabled) return res.status(403).json({ ok: false, message: "\uC11C\uBC84\uC758 \uC2E4\uC81C \uC790\uB3D9\uB9E4\uB9E4 \uAE30\uB2A5\uC774 \uAEBC\uC838 \uC788\uC2B5\uB2C8\uB2E4." });
  if (!realMode) return res.status(409).json({ ok: false, message: "\uC2E4\uC81C \uC8FC\uBB38\uACC4\uD68D\uC740 KIWOOM_MODE=real \uC124\uC815\uC774 \uD544\uC694\uD569\uB2C8\uB2E4." });
  if (!configuredKey || suppliedKey !== configuredKey) return res.status(401).json({ ok: false, message: "\uC790\uB3D9\uB9E4\uB9E4 \uC2E4\uD589\uD0A4\uAC00 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4." });
  if (!req.member?.id) return res.status(401).json({ ok: false, message: "\uB85C\uADF8\uC778\uC774 \uD544\uC694\uD569\uB2C8\uB2E4." });
  const candidates = Array.isArray(req.body?.candidates) ? [...req.body.candidates].sort((a, b) => Number(b?.probability ?? b?.score ?? 0) - Number(a?.probability ?? a?.score ?? 0)).slice(0, 1) : [];
  const candidate = candidates[0];
  if (!candidate) return res.status(400).json({ ok: false, message: "\uC2B9\uC778\uD560 \uC8FC\uBB38 \uD6C4\uBCF4\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4." });
  const ticker = normalizeTicker4(candidate.ticker);
  const market = candidate.market === "US" ? "US" : "KR";
  const currency = market === "US" ? "USD" : "KRW";
  const investmentPerTrade = Math.max(1, Math.min(1e6, Math.round(Number(req.body?.investmentPerTrade ?? 0))));
  const stopLossPercent = Math.min(20, Math.max(0.1, Number(req.body?.stopLossPercent ?? 3)));
  const takeProfitPercent = Math.min(100, Math.max(0.1, Number(req.body?.takeProfitPercent ?? 5)));
  const quote = await MarketDataService.getQuoteRow(ticker);
  const currentPrice = Math.abs(Number(quote?.price ?? 0));
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return res.status(409).json({ ok: false, message: "\uC8FC\uBB38\uACC4\uD68D \uC0DD\uC131 \uC804 \uD604\uC7AC\uAC00\uB97C \uD655\uC778\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4." });
  const quantity = Math.floor(investmentPerTrade / currentPrice);
  if (quantity < 1) return res.status(409).json({ ok: false, message: "\uC124\uC815 \uC8FC\uBB38\uAE08\uC561\uC73C\uB85C 1\uC8FC \uC774\uC0C1 \uC8FC\uBB38\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." });
  const stopPrice = currentPrice * (1 - stopLossPercent / 100);
  const targetPrice = currentPrice * (1 + takeProfitPercent / 100);
  cleanupAutoTradeApprovalPlans();
  const token = randomUUID();
  const expiresAt = Date.now() + 10 * 6e4;
  const plan = {
    token,
    memberId: req.member.id,
    expiresAt,
    body: { candidates, investmentPerTrade, stopLossPercent, takeProfitPercent },
    order: { ticker, name: String(candidate.name ?? ticker), market, currency, quantity, currentPrice, estimatedAmount: quantity * currentPrice, stopPrice, targetPrice }
  };
  autoTradeApprovalPlans.set(token, plan);
  return res.json({ ok: true, approvalToken: token, expiresAt: new Date(expiresAt).toISOString(), order: plan.order, message: "\uC8FC\uBB38 \uB0B4\uC6A9\uC744 \uD655\uC778\uD55C \uB4A4 10\uBD84 \uC548\uC5D0 \uD55C \uBC88\uB9CC \uC2B9\uC778\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4." });
});
router6.post("/auto-trade/close-plan", async (req, res) => {
  const access = validateRealOrderAccess(req);
  if (!access.ok) return res.status(access.status).json({ ok: false, message: access.message });
  await ensureAutoTradePositionsLoaded();
  const memberId = req.member.id;
  const ticker = normalizeTicker4(req.body?.ticker);
  const market = req.body?.market === "US" ? "US" : "KR";
  const positionKey = autoTradePositionKey(memberId, market, ticker);
  const position = autoTradePositions.get(positionKey);
  if (!position) return res.status(404).json({ ok: false, message: "\uD604\uC7AC \uD68C\uC6D0\uC758 \uBCF4\uC720 \uC790\uB3D9\uB9E4\uB9E4 \uD3EC\uC9C0\uC158\uC744 \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4." });
  if (!marketOpenNow(market)) return res.status(409).json({ ok: false, message: market === "US" ? "\uBBF8\uAD6D \uC815\uADDC\uC7A5 \uC8FC\uBB38 \uAC00\uB2A5 \uC2DC\uAC04\uC774 \uC544\uB2D9\uB2C8\uB2E4." : "\uAD6D\uB0B4 \uC815\uADDC\uC7A5 \uC8FC\uBB38 \uAC00\uB2A5 \uC2DC\uAC04\uC774 \uC544\uB2D9\uB2C8\uB2E4." });
  const quote = await MarketDataService.getQuoteRow(ticker);
  const currentPrice = Math.abs(Number(quote?.price ?? 0));
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return res.status(409).json({ ok: false, message: "\uB9E4\uB3C4\uACC4\uD68D \uC0DD\uC131 \uC804 \uD604\uC7AC\uAC00\uB97C \uD655\uC778\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4." });
  const reason = currentPrice <= position.stopPrice ? "\uC190\uC808\uAC00 \uB3C4\uB2EC" : currentPrice >= position.targetPrice ? "\uBAA9\uD45C\uAC00 \uB3C4\uB2EC" : "\uC0AC\uC6A9\uC790 \uC218\uB3D9 \uCCAD\uC0B0";
  cleanupAutoTradeApprovalPlans();
  const token = randomUUID();
  const expiresAt = Date.now() + 10 * 6e4;
  const plan = {
    token,
    memberId,
    expiresAt,
    positionKey,
    order: {
      ticker: position.ticker,
      name: position.name,
      market: position.market,
      currency: position.currency,
      quantity: position.quantity,
      currentPrice,
      estimatedAmount: currentPrice * position.quantity,
      stopPrice: position.stopPrice,
      targetPrice: position.targetPrice,
      reason
    }
  };
  autoTradeCloseApprovalPlans.set(token, plan);
  return res.json({
    ok: true,
    approvalToken: token,
    expiresAt: new Date(expiresAt).toISOString(),
    order: plan.order,
    message: "\uB9E4\uB3C4 \uB0B4\uC6A9\uC744 \uD655\uC778\uD55C \uB4A4 10\uBD84 \uC548\uC5D0 \uD55C \uBC88\uB9CC \uC2B9\uC778\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4."
  });
});
router6.post("/auto-trade/close-execute", async (req, res) => {
  cleanupAutoTradeApprovalPlans();
  const approvalToken = String(req.body?.approvalToken ?? "").trim();
  const approval = autoTradeCloseApprovalPlans.get(approvalToken);
  if (!approval || approval.expiresAt <= Date.now() || approval.memberId !== req.member?.id) {
    return res.status(409).json({ ok: false, message: "\uB9E4\uB3C4 \uC2B9\uC778\uC774 \uC5C6\uAC70\uB098 \uB9CC\uB8CC\uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uB9E4\uB3C4\uACC4\uD68D\uC744 \uB2E4\uC2DC \uD655\uC778\uD574 \uC8FC\uC138\uC694." });
  }
  autoTradeCloseApprovalPlans.delete(approvalToken);
  const access = validateRealOrderAccess(req);
  if (!access.ok) return res.status(access.status).json({ ok: false, message: access.message });
  await ensureAutoTradePositionsLoaded();
  const position = autoTradePositions.get(approval.positionKey);
  if (!position || position.memberId !== req.member.id) {
    return res.status(404).json({ ok: false, message: "\uCCAD\uC0B0\uD560 \uD604\uC7AC \uD68C\uC6D0\uC758 \uD3EC\uC9C0\uC158\uC774 \uC5C6\uC2B5\uB2C8\uB2E4." });
  }
  if (!marketOpenNow(position.market)) {
    return res.status(409).json({ ok: false, message: position.market === "US" ? "\uBBF8\uAD6D \uC815\uADDC\uC7A5 \uC8FC\uBB38 \uAC00\uB2A5 \uC2DC\uAC04\uC774 \uC544\uB2D9\uB2C8\uB2E4." : "\uAD6D\uB0B4 \uC815\uADDC\uC7A5 \uC8FC\uBB38 \uAC00\uB2A5 \uC2DC\uAC04\uC774 \uC544\uB2D9\uB2C8\uB2E4." });
  }
  const quote = await MarketDataService.getQuoteRow(position.ticker);
  const currentPrice = Math.abs(Number(quote?.price ?? 0));
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return res.status(409).json({ ok: false, message: "\uB9E4\uB3C4 \uC9C1\uC804 \uD604\uC7AC\uAC00\uB97C \uD655\uC778\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4." });
  try {
    const order = position.market === "US" ? await placeKiwoomUsOrder({ ticker: position.ticker, exchange: position.exchange, side: "sell", quantity: position.quantity, orderType: "market" }) : await placeKiwoomDomesticOrder({ ticker: position.ticker, side: "sell", quantity: position.quantity, orderType: "market" });
    const closedAt = (/* @__PURE__ */ new Date()).toISOString();
    const status = currentPrice <= position.stopPrice ? "STOP_LOSS" : currentPrice >= position.targetPrice ? "TAKE_PROFIT" : "MANUAL_CLOSE";
    const reason = status === "STOP_LOSS" ? "\uC190\uC808\uAC00 \uB3C4\uB2EC" : status === "TAKE_PROFIT" ? "\uBAA9\uD45C\uAC00 \uB3C4\uB2EC" : "\uC0AC\uC6A9\uC790 \uC218\uB3D9 \uCCAD\uC0B0";
    const profitPercent = position.entryPrice > 0 ? (currentPrice - position.entryPrice) / position.entryPrice * 100 : 0;
    const journal = autoTradeJournal.find((entry) => entry.memberId === position.memberId && entry.id === position.journalId);
    if (journal) {
      journal.status = status;
      journal.exitPrice = currentPrice;
      journal.exitReason = reason;
      journal.exitAnalysis = `${reason}\uC5D0 \uB530\uB77C \uC0AC\uC6A9\uC790 \uD655\uC778 \uD6C4 ${position.quantity}\uC8FC \uC2DC\uC7A5\uAC00 \uB9E4\uB3C4 \uC8FC\uBB38\uC744 \uC804\uC1A1\uD588\uC2B5\uB2C8\uB2E4.`;
      journal.profitPercent = profitPercent;
      journal.exitOrderNo = order.orderNo ?? null;
      journal.closedAt = closedAt;
    }
    autoTradePositions.delete(approval.positionKey);
    await saveAutoTradePositions();
    await saveAutoTradeJournal();
    void deliverMemberNotification({
      memberId: position.memberId,
      type: "auto_trade",
      title: `\uB9E4\uB3C4 \uC8FC\uBB38 \uC804\uC1A1 \xB7 ${position.name}`,
      body: `${reason} \xB7 ${position.quantity}\uC8FC \xB7 \uAE30\uC900\uAC00 ${formatTradePrice(currentPrice, position.currency)} \xB7 \uC608\uC0C1 \uC218\uC775\uB960 ${profitPercent >= 0 ? "+" : ""}${profitPercent.toFixed(2)}%`,
      url: "/auto-trading",
      app: true,
      push: true,
      metadata: { ticker: position.ticker, market: position.market, quantity: position.quantity, currentPrice, reason, orderNo: order.orderNo ?? null }
    }).catch((error) => console.error("auto trade close notification error:", error));
    return res.json({ ok: true, ticker: position.ticker, market: position.market, quantity: position.quantity, orderNo: order.orderNo ?? null, currentPrice, reason, profitPercent, message: "\uC0AC\uC6A9\uC790 \uC2B9\uC778\uC5D0 \uB530\uB77C \uC2DC\uC7A5\uAC00 \uB9E4\uB3C4 \uC8FC\uBB38\uC744 \uC804\uC1A1\uD588\uC2B5\uB2C8\uB2E4." });
  } catch (error) {
    const message = error instanceof Error ? error.message : "\uD0A4\uC6C0 \uB9E4\uB3C4 \uC8FC\uBB38 \uC804\uC1A1 \uC2E4\uD328";
    void deliverMemberNotification({ memberId: position.memberId, type: "auto_trade", title: `\uB9E4\uB3C4 \uC8FC\uBB38 \uC2E4\uD328 \xB7 ${position.name}`, body: message, url: "/auto-trading", app: true, push: true }).catch(() => void 0);
    return res.status(502).json({ ok: false, message });
  }
});
router6.post("/auto-trade/execute", async (req, res) => {
  cleanupAutoTradeApprovalPlans();
  const approvalToken = String(req.body?.approvalToken ?? "").trim();
  const approval = autoTradeApprovalPlans.get(approvalToken);
  if (!approval || approval.expiresAt <= Date.now() || approval.memberId !== req.member?.id) {
    return res.status(409).json({ ok: false, message: "\uC8FC\uBB38 \uC2B9\uC778\uC774 \uC5C6\uAC70\uB098 \uB9CC\uB8CC\uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uC8FC\uBB38\uACC4\uD68D\uC744 \uB2E4\uC2DC \uD655\uC778\uD574 \uC8FC\uC138\uC694." });
  }
  autoTradeApprovalPlans.delete(approvalToken);
  const approvedBody = approval.body;
  const enabled = process.env.KIWOOM_AUTO_TRADE_ENABLED === "true";
  const realMode = String(process.env.KIWOOM_MODE ?? "").trim().toLowerCase() === "real";
  const configuredKey = String(process.env.KIWOOM_AUTO_TRADE_KEY ?? "").trim();
  const suppliedKey = String(req.header("X-Auto-Trade-Key") ?? "").trim();
  if (!enabled) {
    return res.status(403).json({ ok: false, message: "\uC11C\uBC84\uC758 \uC2E4\uC81C \uC790\uB3D9\uB9E4\uB9E4 \uAE30\uB2A5\uC774 \uAEBC\uC838 \uC788\uC2B5\uB2C8\uB2E4." });
  }
  if (!realMode) {
    return res.status(409).json({
      ok: false,
      message: "\uC2E4\uC81C \uC790\uB3D9\uB9E4\uB9E4\uB294 \uC11C\uBC84\uC758 KIWOOM_MODE=real \uC124\uC815\uACFC \uC2E4\uC804\uC6A9 App Key\uAC00 \uD544\uC694\uD569\uB2C8\uB2E4."
    });
  }
  if (!configuredKey || suppliedKey !== configuredKey) {
    return res.status(401).json({ ok: false, message: "\uC790\uB3D9\uB9E4\uB9E4 \uC2E4\uD589\uD0A4\uAC00 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4." });
  }
  await ensureAutoTradePositionsLoaded();
  const memberId = req.member.id;
  const candidates = Array.isArray(approvedBody.candidates) ? [...approvedBody.candidates].sort((a, b) => Number(b?.probability ?? 0) - Number(a?.probability ?? 0)).slice(0, 1) : [];
  const investmentPerTrade = Math.max(1, Number(approvedBody.investmentPerTrade ?? 0));
  const stopLossPercent = Math.min(20, Math.max(0.1, Number(approvedBody.stopLossPercent ?? 3)));
  const takeProfitPercent = Math.min(100, Math.max(0.1, Number(approvedBody.takeProfitPercent ?? 5)));
  const minimumProbability = Math.min(
    99,
    Math.max(1, Number(process.env.KIWOOM_AUTO_TRADE_MIN_PROBABILITY ?? 70))
  );
  const maximumRiskScore = Math.min(
    100,
    Math.max(0, Number(process.env.KIWOOM_AUTO_TRADE_MAX_RISK_SCORE ?? 55))
  );
  const minimumDataCompleteness = Math.min(
    100,
    Math.max(0, Number(process.env.KIWOOM_AUTO_TRADE_MIN_DATA_COMPLETENESS ?? 45))
  );
  const dailyOrderLimit = Math.max(
    1,
    Number(process.env.KIWOOM_AUTO_TRADE_DAILY_ORDER_LIMIT ?? 1)
  );
  const results = [];
  for (const candidate of candidates) {
    const ticker = normalizeTicker4(candidate?.ticker);
    const market = candidate?.market === "US" ? "US" : "KR";
    const currency = market === "US" ? "USD" : "KRW";
    const exchange = market === "US" ? normalizeUsExchange(candidate?.exchange, ticker) : null;
    const probability = Number(candidate?.probability ?? 0);
    const riskScore = Number(candidate?.riskScore ?? 50);
    const dataCompleteness = Number(candidate?.dataCompleteness ?? 50);
    const day = marketDateString(market);
    const key = `${memberId}:${day}:${market}:${ticker}:BUY`;
    const positionKey = autoTradePositionKey(memberId, market, ticker);
    const ordersPlacedToday = autoTradeJournal.filter(
      (entry) => entry.memberId === memberId && entry.market === market && marketDateString(market, entry.openedAt) === day
    ).length;
    if (ordersPlacedToday >= dailyOrderLimit) {
      results.push({
        ticker,
        ok: true,
        skipped: true,
        message: `\uC624\uB298 \uC790\uB3D9\uB9E4\uB9E4 \uC2E0\uADDC \uC8FC\uBB38 \uD55C\uB3C4(${dailyOrderLimit}\uD68C)\uC5D0 \uB3C4\uB2EC\uD588\uC2B5\uB2C8\uB2E4.`
      });
      continue;
    }
    if (market === "KR" && !/^\d{6}$/.test(ticker)) {
      results.push({ ticker, market, ok: false, skipped: true, message: "\uAD6D\uB0B4 \uC885\uBAA9\uCF54\uB4DC \uD615\uC2DD\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4." });
      continue;
    }
    if (market === "US" && (!/^[A-Z][A-Z0-9.-]{0,11}$/.test(ticker) || !exchange)) {
      results.push({ ticker, market, ok: false, skipped: true, message: "\uBBF8\uAD6D \uC885\uBAA9\uCF54\uB4DC \uB610\uB294 \uAC70\uB798\uC18C(NASDAQ/NYSE/AMEX)\uB97C \uD655\uC778\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." });
      continue;
    }
    if (!marketOpenNow(market)) {
      results.push({
        ticker,
        market,
        ok: false,
        skipped: true,
        message: market === "US" ? "\uBBF8\uAD6D \uC815\uADDC\uC7A5 \uC8FC\uBB38 \uAC00\uB2A5 \uC2DC\uAC04\uC774 \uC544\uB2D9\uB2C8\uB2E4." : "\uAD6D\uB0B4 \uC815\uADDC\uC7A5 \uC8FC\uBB38 \uAC00\uB2A5 \uC2DC\uAC04\uC774 \uC544\uB2D9\uB2C8\uB2E4."
      });
      continue;
    }
    if (!Number.isFinite(probability) || probability < minimumProbability) {
      results.push({
        ticker,
        ok: false,
        skipped: true,
        message: `\uC11C\uBC84 \uCD5C\uC18C \uD655\uB960 ${minimumProbability}%\uB97C \uCDA9\uC871\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.`
      });
      continue;
    }
    if (!Number.isFinite(riskScore) || riskScore > maximumRiskScore) {
      results.push({
        ticker,
        market,
        ok: false,
        skipped: true,
        message: `\uC704\uD5D8\uC810\uC218 ${Math.round(riskScore)}\uC810\uC73C\uB85C \uC11C\uBC84 \uD5C8\uC6A9\uCE58 ${maximumRiskScore}\uC810\uC744 \uCD08\uACFC\uD588\uC2B5\uB2C8\uB2E4.`
      });
      continue;
    }
    if (!Number.isFinite(dataCompleteness) || dataCompleteness < minimumDataCompleteness) {
      results.push({
        ticker,
        market,
        ok: false,
        skipped: true,
        message: `\uB370\uC774\uD130 \uCDA9\uC871\uB3C4 ${Math.round(dataCompleteness)}%\uB85C \uC11C\uBC84 \uCD5C\uC18C\uCE58 ${minimumDataCompleteness}%\uBCF4\uB2E4 \uB0AE\uC2B5\uB2C8\uB2E4.`
      });
      continue;
    }
    if (autoTradePositions.has(positionKey)) {
      results.push({ ticker, ok: true, skipped: true, message: "\uC774\uBBF8 \uC790\uB3D9\uB9E4\uB9E4\uB85C \uBCF4\uC720 \uC911\uC778 \uC885\uBAA9\uC785\uB2C8\uB2E4." });
      continue;
    }
    if (autoTradeExecuted.has(key)) {
      results.push({ ticker, ok: true, skipped: true, message: "\uC624\uB298 \uC774\uBBF8 \uC8FC\uBB38\uD55C \uC885\uBAA9\uC785\uB2C8\uB2E4." });
      continue;
    }
    let price = 0;
    try {
      const quote = await MarketDataService.getQuoteRow(ticker);
      price = Math.abs(Number(quote?.price ?? quote?.currentPrice ?? quote?.cur_prc ?? 0));
    } catch {
      price = 0;
    }
    if (!Number.isFinite(price) || price <= 0) {
      results.push({ ticker, ok: false, skipped: true, message: "\uC8FC\uBB38 \uC9C1\uC804 \uD604\uC7AC\uAC00\uB97C \uD655\uC778\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4." });
      continue;
    }
    const quantity = Math.floor(investmentPerTrade / price);
    if (quantity < 1) {
      results.push({ ticker, ok: false, skipped: true, message: "\uC8FC\uBB38\uAE08\uC561\uC774 \uD604\uC7AC\uAC00\uBCF4\uB2E4 \uC791\uC2B5\uB2C8\uB2E4." });
      continue;
    }
    try {
      const order = market === "US" ? await placeKiwoomUsOrder({
        ticker,
        exchange,
        side: "buy",
        quantity,
        orderType: "market"
      }) : await placeKiwoomDomesticOrder({
        ticker,
        side: "buy",
        quantity,
        orderType: "market"
      });
      const stopPrice = price * (1 - stopLossPercent / 100);
      const targetPrice = price * (1 + takeProfitPercent / 100);
      const openedAt = (/* @__PURE__ */ new Date()).toISOString();
      const reasons = Array.isArray(candidate?.reasons) ? candidate.reasons.map(String).filter(Boolean).slice(0, 8) : [];
      const journalId = `${openedAt}:${market}:${ticker}`;
      const name = String(candidate?.name ?? ticker);
      autoTradeExecuted.add(key);
      autoTradePositions.set(positionKey, {
        memberId,
        ticker,
        name,
        market,
        currency,
        exchange,
        quantity,
        entryPrice: price,
        stopPrice,
        targetPrice,
        probability,
        reasons,
        journalId,
        openedAt,
        exitSignalReason: null,
        exitSignalAt: null
      });
      autoTradeJournal.push({
        memberId,
        id: journalId,
        ticker,
        name,
        market,
        currency,
        exchange,
        status: "OPEN",
        quantity,
        entryPrice: price,
        exitPrice: null,
        stopPrice,
        targetPrice,
        probability,
        entryReasons: reasons,
        entryAnalysis: `${reasons.join(" \xB7 ") || "\uC885\uD569 \uC870\uAC74"}\uC774 \uD655\uC778\uB418\uC5B4 \uD6C4\uBCF4 \uC911 \uBAA8\uB378\uC810\uC218 ${probability}\uC810\uC73C\uB85C \uC120\uC815\uD588\uC2B5\uB2C8\uB2E4. \uD604\uC7AC\uAC00 ${formatTradePrice(price, currency)}\uB97C \uC9C4\uC785 \uAE30\uC900\uC73C\uB85C \uC190\uC808 ${formatTradePrice(stopPrice, currency)}, \uBAA9\uD45C ${formatTradePrice(targetPrice, currency)}\uB97C \uC124\uC815\uD588\uC2B5\uB2C8\uB2E4.`,
        exitReason: null,
        exitAnalysis: null,
        profitPercent: null,
        entryOrderNo: order.orderNo ?? null,
        exitOrderNo: null,
        openedAt,
        closedAt: null
      });
      await saveAutoTradePositions();
      await saveAutoTradeJournal();
      void deliverMemberNotification({
        memberId,
        type: "auto_trade",
        title: `\uB9E4\uC218 \uC8FC\uBB38 \uC804\uC1A1 \xB7 ${name}`,
        body: `${quantity}\uC8FC \xB7 \uAE30\uC900\uAC00 ${formatTradePrice(price, currency)} \xB7 \uC190\uC808 ${formatTradePrice(stopPrice, currency)} \xB7 \uBAA9\uD45C ${formatTradePrice(targetPrice, currency)}`,
        url: "/auto-trading",
        app: true,
        push: true,
        metadata: { ticker, market, quantity, price, stopPrice, targetPrice, orderNo: order.orderNo ?? null }
      }).catch((error) => console.error("auto trade entry notification error:", error));
      results.push({
        ticker,
        market,
        currency,
        ok: true,
        quantity,
        orderNo: order.orderNo,
        stopPrice,
        targetPrice,
        message: "\uC2DC\uC7A5\uAC00 \uB9E4\uC218 \uC8FC\uBB38\uC744 \uC804\uC1A1\uD588\uC2B5\uB2C8\uB2E4."
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "\uD0A4\uC6C0 \uC8FC\uBB38 \uC804\uC1A1 \uC2E4\uD328";
      void deliverMemberNotification({ memberId, type: "auto_trade", title: `\uB9E4\uC218 \uC8FC\uBB38 \uC2E4\uD328 \xB7 ${String(candidate?.name ?? ticker)}`, body: message, url: "/auto-trading", app: true, push: true }).catch(() => void 0);
      results.push({
        ticker,
        market,
        ok: false,
        quantity,
        message
      });
    }
  }
  const completed = results.filter((item) => item.ok && !item.skipped).length;
  return res.json({
    ok: completed > 0 || results.every((item) => item.skipped),
    message: completed > 0 ? `${completed}\uAC1C \uC885\uBAA9 \uC2E4\uC8FC\uBB38\uC744 \uC804\uC1A1\uD588\uC2B5\uB2C8\uB2E4.` : "\uC2E0\uADDC \uC2E4\uC8FC\uBB38\uC774 \uC804\uC1A1\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4.",
    results
  });
});
async function inspectAutoTradePositions(memberId) {
  await ensureAutoTradePositionsLoaded();
  const results = [];
  const memberPositions = [...autoTradePositions.values()].filter((position) => position.memberId === memberId);
  let changed = false;
  for (const position of memberPositions) {
    try {
      const quote = await MarketDataService.getQuoteRow(position.ticker);
      const currentPrice = Math.abs(Number(quote?.price ?? 0));
      if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
        results.push({ ticker: position.ticker, market: position.market, ok: false, skipped: true, message: "\uD604\uC7AC\uAC00 \uD655\uC778 \uC2E4\uD328" });
        continue;
      }
      const reason = currentPrice <= position.stopPrice ? "\uC190\uC808\uAC00 \uB3C4\uB2EC" : currentPrice >= position.targetPrice ? "\uBAA9\uD45C\uAC00 \uB3C4\uB2EC" : "\uBCF4\uC720 \uC720\uC9C0";
      if (reason === "\uBCF4\uC720 \uC720\uC9C0") {
        if (position.exitSignalReason) {
          position.exitSignalReason = null;
          position.exitSignalAt = null;
          changed = true;
        }
      } else if (position.exitSignalReason !== reason) {
        position.exitSignalReason = reason;
        position.exitSignalAt = (/* @__PURE__ */ new Date()).toISOString();
        changed = true;
        void deliverMemberNotification({
          memberId,
          type: "auto_trade",
          title: `\uCCAD\uC0B0 \uC2B9\uC778 \uD544\uC694 \xB7 ${position.name}`,
          body: `${reason} \xB7 \uD604\uC7AC\uAC00 ${formatTradePrice(currentPrice, position.currency)} \xB7 \uB9E4\uB3C4 \uC8FC\uBB38\uC740 \uC544\uC9C1 \uC804\uC1A1\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4.`,
          url: "/auto-trading",
          app: true,
          push: true,
          metadata: { ticker: position.ticker, market: position.market, currentPrice, stopPrice: position.stopPrice, targetPrice: position.targetPrice, reason }
        }).catch((error) => console.error("auto trade exit signal notification error:", error));
      }
      results.push({
        ticker: position.ticker,
        market: position.market,
        ok: true,
        skipped: true,
        currentPrice,
        stopPrice: position.stopPrice,
        targetPrice: position.targetPrice,
        approvalRequired: reason !== "\uBCF4\uC720 \uC720\uC9C0",
        message: reason === "\uBCF4\uC720 \uC720\uC9C0" ? "\uC190\uC808\xB7\uBAA9\uD45C\uAC00 \uBBF8\uB3C4\uB2EC" : `${reason}: \uB9E4\uB3C4 \uC8FC\uBB38\uC740 \uC0AC\uC6A9\uC790 \uC2B9\uC778 \uC804\uAE4C\uC9C0 \uC804\uC1A1\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.`
      });
    } catch (error) {
      results.push({ ticker: position.ticker, market: position.market, ok: false, skipped: true, message: error instanceof Error ? error.message : "\uAC10\uC2DC \uC2E4\uD328" });
    }
  }
  if (changed) await saveAutoTradePositions();
  return { results, activePositions: memberPositions.length };
}
router6.post("/auto-trade/monitor", async (req, res) => {
  const configuredKey = String(process.env.KIWOOM_AUTO_TRADE_KEY ?? "").trim();
  const suppliedKey = String(req.header("X-Auto-Trade-Key") ?? "").trim();
  if (!configuredKey || suppliedKey !== configuredKey) return res.status(401).json({ ok: false, message: "\uC790\uB3D9\uB9E4\uB9E4 \uC2E4\uD589\uD0A4\uAC00 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4." });
  const monitored = await inspectAutoTradePositions(req.member.id);
  return res.json({ ok: true, activePositions: monitored.activePositions, message: "\uBCF4\uC720 \uC885\uBAA9\uC744 \uAC10\uC2DC\uD588\uC2B5\uB2C8\uB2E4. \uCCAD\uC0B0 \uC8FC\uBB38\uC740 \uC8FC\uBB38\uBCC4 \uC0AC\uC6A9\uC790 \uC2B9\uC778 \uC804\uAE4C\uC9C0 \uC804\uC1A1\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.", results: monitored.results });
});
router6.get("/auto-trade/status", (_req, res) => {
  const mode = String(process.env.KIWOOM_MODE ?? "").trim().toLowerCase();
  return res.json({
    ok: true,
    mode: mode === "real" ? "real" : "mock",
    enabled: process.env.KIWOOM_AUTO_TRADE_ENABLED === "true",
    domesticSupported: true,
    usSupported: true,
    realKeyConfigured: Boolean(
      process.env.KIWOOM_APP_KEY?.trim() && process.env.KIWOOM_APP_SECRET?.trim()
    ),
    executionKeyConfigured: Boolean(process.env.KIWOOM_AUTO_TRADE_KEY?.trim()),
    checks: [
      "\uC815\uADDC\uC7A5 \uC2DC\uAC04",
      "\uCD5C\uC18C \uBAA8\uB378\uC810\uC218",
      "\uC704\uD5D8\uC810\uC218",
      "\uB370\uC774\uD130 \uCDA9\uC871\uB3C4",
      "\uC77C\uC77C \uC8FC\uBB38\uD55C\uB3C4",
      "\uC911\uBCF5 \uBCF4\uC720",
      "\uC8FC\uBB38 \uC9C1\uC804 \uD604\uC7AC\uAC00"
    ]
  });
});
router6.get("/auto-trade/journal", async (req, res) => {
  await ensureAutoTradePositionsLoaded();
  return res.json({ ok: true, entries: autoTradeJournal.filter((entry) => entry.memberId === req.member.id).reverse() });
});
router6.get("/:ticker/quote", async (req, res) => {
  const ticker = normalizeTicker4(req.params.ticker);
  if (!ticker) {
    res.status(400).json({
      error: "MISSING_TICKER"
    });
    return;
  }
  try {
    const quote = await MarketDataService.getQuoteRow(ticker);
    if (!quote) {
      res.status(404).json({
        error: "QUOTE_NOT_FOUND",
        ticker
      });
      return;
    }
    res.json(quote);
  } catch (error) {
    console.error("stock quote route error:", error);
    res.status(500).json({
      error: "STOCK_QUOTE_ROUTE_ERROR",
      ticker
    });
  }
});
router6.get("/:ticker/profile", async (req, res) => {
  const ticker = normalizeTicker4(req.params.ticker);
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
  const ticker = normalizeTicker4(req.params.ticker);
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
  const ticker = normalizeTicker4(req.params.ticker);
  const timeframe = normalizeTimeframe2(req.query.tf ?? req.query.timeframe);
  if (!ticker) {
    res.status(400).json({
      error: "MISSING_TICKER"
    });
    return;
  }
  try {
    const candles = await MarketDataService.getCandles(
      ticker,
      timeframe
    );
    res.json({
      ticker,
      timeframe,
      candles,
      count: candles.length,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
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
  const ticker = normalizeTicker4(req.params.ticker);
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
  const ticker = normalizeTicker4(req.params.ticker);
  res.setHeader("Cache-Control", "no-store, max-age=0");
  try {
    const financials = await withLiveCache(`financials:${ticker}`, 5 * 6e4, () => fetchFinancials(ticker));
    res.json({
      ticker,
      financials,
      ...financials,
      items: financials.annual ?? [],
      summary: "\uC2E4\uC81C \uACF5\uAC1C \uC7AC\uBB34 \uB370\uC774\uD130\uB97C \uBD88\uB7EC\uC654\uC2B5\uB2C8\uB2E4."
    });
  } catch (error) {
    console.error("stock financials route error:", error);
    res.status(503).json({
      ticker,
      annual: [],
      quarterly: [],
      items: [],
      ratios: {},
      code: "FINANCIAL_PROVIDER_DELAY",
      summary: "\uC7AC\uBB34 \uB370\uC774\uD130 \uC81C\uACF5\uAE30\uAD00\uC758 \uC751\uB2F5\uC774 \uC9C0\uC5F0\uB418\uACE0 \uC788\uC2B5\uB2C8\uB2E4."
    });
  }
});
router6.get("/:ticker/risk", async (req, res) => {
  const ticker = normalizeTicker4(req.params.ticker);
  res.json({
    ticker,
    delistingRisk: false,
    riskLevel: "normal",
    summary: "\uD604\uC7AC \uD655\uC778\uB41C \uC0C1\uC7A5\uD3D0\uC9C0 \uACE0\uC704\uD5D8 \uC2E0\uD638\uB294 \uC5C6\uC2B5\uB2C8\uB2E4."
  });
});
router6.get("/:ticker/filings", async (req, res) => {
  const ticker = normalizeTicker4(req.params.ticker);
  const allHistory = String(req.query.all ?? "") === "1";
  res.setHeader("Cache-Control", "no-store, max-age=0");
  try {
    const items = await withLiveCache(
      `filings:${ticker}:${allHistory ? "all" : "recent"}`,
      6e4,
      () => fetchAllFilings(ticker, allHistory)
    );
    res.json({
      ticker,
      filings: items,
      items,
      summary: simpleDartSummary(items[0]) + (items.length > 1 ? " \uC804\uCCB4 \uACF5\uC2DC " + items.length + "\uAC74\uC744 \uBD88\uB7EC\uC654\uC2B5\uB2C8\uB2E4." : "")
    });
  } catch (error) {
    console.error("stock filings route error:", error);
    const items = [];
    res.json({
      ticker,
      filings: items,
      items,
      summary: /^\d{6}$/.test(ticker) ? "DART \uC5F0\uACB0\uC744 \uD655\uC778\uD574 \uC8FC\uC138\uC694." : "SEC EDGAR \uC5F0\uACB0\uC744 \uD655\uC778\uD574 \uC8FC\uC138\uC694."
    });
  }
});
router6.get("/:ticker/disclosures", async (req, res) => {
  const ticker = normalizeTicker4(req.params.ticker);
  const allHistory = String(req.query.all ?? "") === "1";
  res.setHeader("Cache-Control", "no-store, max-age=0");
  try {
    const result = await withLiveCache(`disclosures:v3:${ticker}:${allHistory ? "all" : "recent"}`, 6e4, () => FilingService.getFilings(ticker, { allHistory }));
    if (!result) return res.status(404).json({ code: "TICKER_NOT_FOUND", message: "\uC885\uBAA9\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." });
    res.json(result);
  } catch (error) {
    console.error("stock disclosures route error:", error);
    res.json({
      ticker,
      disclosures: [],
      items: [],
      summary: /^\d{6}$/.test(ticker) ? "DART \uC5F0\uACB0\uC744 \uD655\uC778\uD574 \uC8FC\uC138\uC694." : "SEC EDGAR \uC5F0\uACB0\uC744 \uD655\uC778\uD574 \uC8FC\uC138\uC694."
    });
  }
});
router6.get("/:ticker/news", async (req, res) => {
  const ticker = normalizeTicker4(req.params.ticker);
  const allHistory = String(req.query.all ?? "") === "1";
  res.setHeader("Cache-Control", "no-store, max-age=0");
  try {
    const items = await withLiveCache(
      `news:${ticker}:${allHistory ? "all" : "recent"}`,
      6e4,
      () => fetchGoogleNews(ticker, allHistory)
    );
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
function marketPeriodKey(dateText, period) {
  const match = dateText.match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
  if (!match) return dateText;
  const [, year, month, day] = match;
  if (period === "yearly") return year;
  if (period === "monthly") return `${year}.${month}`;
  if (period === "weekly") {
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    const mondayOffset = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - mondayOffset);
    return `${date.getUTCFullYear()}.${String(date.getUTCMonth() + 1).padStart(2, "0")}.${String(date.getUTCDate()).padStart(2, "0")}`;
  }
  return dateText;
}
function marketPeriodLabel(key, period) {
  if (period === "weekly") return `${key} \uC8FC`;
  return key;
}
function groupInvestorRows(rows, period) {
  if (period === "daily") return rows.slice(0, 30);
  const grouped = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const key = marketPeriodKey(row.date, period);
    const current = grouped.get(key) ?? {
      date: marketPeriodLabel(key, period),
      individual: 0,
      institution: 0,
      foreign: 0
    };
    current.individual += Number(row.individual ?? 0);
    current.institution += Number(row.institution ?? 0);
    current.foreign += Number(row.foreign ?? 0);
    grouped.set(key, current);
  }
  return [...grouped.values()].slice(0, 30);
}
function groupShortRows(rows, period) {
  if (period === "daily") return rows.slice(0, 30);
  const grouped = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const key = marketPeriodKey(row.date, period);
    const current = grouped.get(key) ?? {
      date: marketPeriodLabel(key, period),
      shortVolume: 0,
      ratioTotal: 0,
      ratioCount: 0,
      balance: row.balance,
      balanceAmount: row.balanceAmount,
      balanceRatio: row.balanceRatio
    };
    current.shortVolume += Number(row.shortVolume ?? 0);
    if (Number.isFinite(Number(row.ratio))) {
      current.ratioTotal += Number(row.ratio);
      current.ratioCount += 1;
    }
    grouped.set(key, current);
  }
  return [...grouped.values()].slice(0, 30).map((row) => ({
    date: row.date,
    shortVolume: row.shortVolume,
    ratio: row.ratioCount ? row.ratioTotal / row.ratioCount : 0,
    balance: row.balance,
    balanceAmount: row.balanceAmount,
    balanceRatio: row.balanceRatio
  }));
}
function extractKiwoomShortRows(raw) {
  const arrays = [];
  const visit = (value, depth = 0) => {
    if (depth > 4 || value == null) return;
    if (Array.isArray(value)) {
      arrays.push(value);
      for (const item of value.slice(0, 3)) visit(item, depth + 1);
      return;
    }
    if (typeof value === "object") {
      for (const child of Object.values(value)) visit(child, depth + 1);
    }
  };
  visit(raw);
  const numberValue = (value) => financeNumber(String(value ?? ""));
  const normalized = arrays.map((list) => list.map((item) => item)).map((list) => list.map((item) => {
    const rawDate = String(item.dt ?? item.date ?? item.base_dt ?? item.trde_dt ?? "").replace(/\D/g, "");
    const date = rawDate.length >= 8 ? `${rawDate.slice(0, 4)}.${rawDate.slice(4, 6)}.${rawDate.slice(6, 8)}` : "";
    const shortVolume = numberValue(
      item.shrts_qty ?? item.short_qty ?? item.shrt_qty ?? item.shortVolume ?? item.shrt_trde_qty
    );
    const ratio = numberValue(
      item.trde_wght ?? item.shrts_qty_rt ?? item.short_ratio ?? item.shrt_rt ?? item.ratio ?? item.shrt_trde_rt
    );
    return { date, shortVolume, ratio };
  })).find((list) => list.some((row) => row.date && (row.shortVolume > 0 || row.ratio > 0)));
  return (normalized ?? []).filter((row) => row.date).slice(0, 120);
}
router6.get("/:ticker/market-flow", async (req, res) => {
  const ticker = normalizeTicker4(req.params.ticker);
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
      (sum, row) => ({
        individual: sum.individual + Number(row.individual ?? 0),
        institution: sum.institution + Number(row.institution ?? 0),
        foreign: sum.foreign + Number(row.foreign ?? 0)
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
  const ticker = normalizeTicker4(req.params.ticker);
  const period = String(req.query.period ?? "daily");
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
    const [kiwoomRaw, tradeResponse, balanceResponse] = await Promise.all([
      getKiwoomShortSellingRaw(ticker).catch(() => null),
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
    const naverTradeRows = financeTableRows(tradeHtml).filter(
      (cells) => /^\d{4}\.\d{2}\.\d{2}$/.test(cells[0] ?? "") && cells.length >= 6
    ).map((cells) => ({
      date: cells[0],
      shortVolume: financeNumber(cells[cells.length - 2]),
      ratio: financeNumber(cells[cells.length - 1])
    }));
    const kiwoomTradeRows = kiwoomRaw ? extractKiwoomShortRows(kiwoomRaw) : [];
    const tradeRows = kiwoomTradeRows.length ? kiwoomTradeRows : naverTradeRows;
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
    const dailyRows = tradeRows.slice(0, 30).map((row) => ({ ...row, ...balanceMap.get(row.date) ?? {} }));
    const rows = groupShortRows(dailyRows, period);
    const latestBalance = [...balanceMap.values()][0] ?? {};
    const latest = rows.length ? { ...rows[0], ...latestBalance, borrowRate: null } : null;
    res.json({
      ticker,
      period,
      available: rows.length > 0,
      rows,
      latest,
      source: kiwoomTradeRows.length ? "KIWOOM_KA10014" : "NAVER_FINANCE",
      note: "\uACF5\uB9E4\uB3C4 \uAC70\uB798\uB294 \uD0A4\uC6C0 ka10014\uB97C \uC6B0\uC120 \uC0AC\uC6A9\uD558\uBA70, \uB300\uCC28\uC794\uACE0\xB7\uC774\uC790\uC728\uC740 \uC81C\uACF5 \uAC00\uB2A5\uD55C \uACF5\uAC1C \uB370\uC774\uD130\uB9CC \uD45C\uC2DC\uD569\uB2C8\uB2E4."
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
  requireMember,
  requireAdmin,
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
  requireMember,
  requireAdmin,
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
  requireMember,
  requireAdmin,
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
  requireMember,
  requireAdmin,
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
  requireMember,
  requireAdmin,
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

// src/routes/admin.ts
import { Router as Router9 } from "express";
var router9 = Router9();
router9.use(requireMember, requireAdmin);
router9.get("/members", async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : void 0;
  let query = getSupabase().from("profiles").select("*").order("created_at", { ascending: false }).limit(500);
  if (status) query = query.eq("status", status);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: "MEMBER_LIST_FAILED" });
  return res.json({ members: data ?? [] });
});
router9.patch("/members/:id", async (req, res) => {
  if (!hasSupabaseServerKey()) return res.status(503).json({ error: "ADMIN_KEY_REQUIRED" });
  const allowedStatus = ["pending", "approved", "rejected", "suspended", "withdrawn"];
  const allowedRole = ["user", "admin"];
  const status = allowedStatus.includes(req.body?.status) ? req.body.status : void 0;
  const role = allowedRole.includes(req.body?.role) ? req.body.role : void 0;
  if (!status && !role) return res.status(400).json({ error: "NO_VALID_CHANGE" });
  if (req.params.id === req.member?.id && (status && status !== "approved" || role === "user")) {
    return res.status(409).json({ error: "CANNOT_REMOVE_OWN_ADMIN_ACCESS" });
  }
  const changes = { updated_at: (/* @__PURE__ */ new Date()).toISOString() };
  if (status) Object.assign(changes, { status, approved_at: status === "approved" ? (/* @__PURE__ */ new Date()).toISOString() : null, approved_by: status === "approved" ? req.member?.id : null });
  if (role) changes.role = role;
  const { data, error } = await getSupabase().from("profiles").update(changes).eq("id", req.params.id).select("*").single();
  if (error) return res.status(500).json({ error: "MEMBER_UPDATE_FAILED" });
  await getSupabase().from("audit_logs").insert({ actor_id: req.member?.id, action: "member.update", target_type: "profile", target_id: req.params.id, details: changes, ip_address: req.ip });
  return res.json({ member: data });
});
router9.get("/audit-logs", async (_req, res) => {
  const { data, error } = await getSupabase().from("audit_logs").select("*").order("created_at", { ascending: false }).limit(500);
  if (error) return res.status(500).json({ error: "AUDIT_LIST_FAILED" });
  return res.json({ logs: data ?? [] });
});
router9.get("/system", (req, res) => {
  const maskHost = (value) => {
    if (!value) return null;
    try {
      const url = new URL(value);
      return `${url.protocol}//${url.hostname.replace(/^[^.]+/, "***")}${url.port ? `:${url.port}` : ""}`;
    } catch {
      return "configured";
    }
  };
  return res.json({ appVersion: process.env.APP_VERSION ?? "development", environment: "development", kiwoomMode: process.env.KIWOOM_MODE ?? "disabled", apiBase: maskHost(process.env.PUBLIC_API_URL), serverBase: maskHost(process.env.SERVER_URL), databaseConfigured: Boolean(process.env.SUPABASE_URL), autoTradeEnabled: process.env.KIWOOM_AUTO_TRADE_ENABLED === "true", checkedAt: (/* @__PURE__ */ new Date()).toISOString(), requestedBy: req.member?.id });
});
var admin_default = router9;

// src/routes/crypto.ts
import { Router as Router10 } from "express";
import { createHmac, randomUUID as randomUUID2 } from "node:crypto";
var router10 = Router10();
var UPBIT_BASE = "https://api.upbit.com";
var BITGET_BASE = "https://api.bitget.com";
function base64Url(value) {
  return Buffer.from(value).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function createUpbitToken(accessKey, secretKey) {
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ access_key: accessKey, nonce: randomUUID2() }));
  const signature = base64Url(createHmac("sha256", secretKey).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${signature}`;
}
async function fetchJsonWithHeaders(url, headers) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12e3);
  try {
    const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "knowledge-info-app/1.0", ...headers }, signal: controller.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`HTTP_${response.status}:${body.slice(0, 200)}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}
function bitgetHeaders(method, requestPath, query = "", body = "") {
  const apiKey = String(process.env.BITGET_API_KEY ?? "").trim();
  const secret = String(process.env.BITGET_SECRET_KEY ?? "").trim();
  const passphrase = String(process.env.BITGET_PASSPHRASE ?? "").trim();
  if (!apiKey || !secret || !passphrase) throw new Error("BITGET_PRIVATE_KEYS_NOT_CONFIGURED");
  const timestamp = Date.now().toString();
  const queryPart = query ? `?${query}` : "";
  const signature = createHmac("sha256", secret).update(`${timestamp}${method}${requestPath}${queryPart}${body}`).digest("base64");
  return {
    "ACCESS-KEY": apiKey,
    "ACCESS-SIGN": signature,
    "ACCESS-TIMESTAMP": timestamp,
    "ACCESS-PASSPHRASE": passphrase,
    "Content-Type": "application/json",
    locale: "en-US"
  };
}
async function fetchJson5(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12e3);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "seungjae-investment-app/1.0" },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}
function safeSymbol(value) {
  return String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 30);
}
function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
router10.get("/crypto/status", async (_req, res) => {
  const [upbit, bitget] = await Promise.allSettled([
    fetchJson5(`${UPBIT_BASE}/v1/market/all?isDetails=true`),
    fetchJson5(`${BITGET_BASE}/api/v2/mix/market/tickers?productType=USDT-FUTURES`)
  ]);
  return res.json({
    upbit: {
      ok: upbit.status === "fulfilled" && Array.isArray(upbit.value),
      privateKeyConfigured: Boolean(process.env.UPBIT_ACCESS_KEY && process.env.UPBIT_SECRET_KEY)
    },
    bitget: {
      ok: bitget.status === "fulfilled" && Array.isArray(bitget.value?.data),
      privateKeyConfigured: Boolean(
        process.env.BITGET_API_KEY && process.env.BITGET_SECRET_KEY && process.env.BITGET_PASSPHRASE
      )
    },
    checkedAt: (/* @__PURE__ */ new Date()).toISOString()
  });
});
router10.get("/crypto/spot/markets", async (_req, res) => {
  try {
    const markets = await fetchJson5(`${UPBIT_BASE}/v1/market/all?isDetails=true`);
    const rows = markets.filter((item) => String(item.market ?? "").startsWith("KRW-")).map((item) => ({
      market: String(item.market),
      symbol: String(item.market).replace(/^KRW-/, ""),
      koreanName: String(item.korean_name ?? item.market),
      englishName: String(item.english_name ?? item.market),
      warning: String(item.market_warning ?? "NONE") !== "NONE"
    }));
    return res.json({ exchange: "UPBIT", quoteCurrency: "KRW", markets: rows, count: rows.length, updatedAt: (/* @__PURE__ */ new Date()).toISOString() });
  } catch (error) {
    console.error("upbit markets error:", error);
    return res.status(502).json({ exchange: "UPBIT", markets: [], count: 0, error: "UPBIT_MARKETS_UNAVAILABLE" });
  }
});
router10.get("/crypto/spot/tickers", async (req, res) => {
  try {
    const requested = String(req.query.markets ?? "").split(",").map(safeSymbol).filter(Boolean);
    let markets = requested.map((symbol) => symbol.startsWith("KRW-") ? symbol : `KRW-${symbol}`);
    if (!markets.length) {
      const master = await fetchJson5(`${UPBIT_BASE}/v1/market/all?isDetails=false`);
      markets = master.filter((item) => String(item.market ?? "").startsWith("KRW-")).map((item) => String(item.market)).slice(0, 100);
    }
    const chunks = [];
    for (let index = 0; index < markets.length; index += 100) chunks.push(markets.slice(index, index + 100));
    const payloads = await Promise.all(chunks.map((chunk) => fetchJson5(`${UPBIT_BASE}/v1/ticker?markets=${encodeURIComponent(chunk.join(","))}`)));
    const tickers = payloads.flat().map((item) => ({
      market: String(item.market),
      symbol: String(item.market).replace(/^KRW-/, ""),
      price: finite(item.trade_price),
      change: String(item.change ?? ""),
      changeRate: finite(item.signed_change_rate),
      changePercent: finite(item.signed_change_rate) == null ? null : Number(item.signed_change_rate) * 100,
      changePrice: finite(item.signed_change_price),
      high24h: finite(item.high_price),
      low24h: finite(item.low_price),
      volume24h: finite(item.acc_trade_volume_24h),
      tradingValue24h: finite(item.acc_trade_price_24h),
      timestamp: finite(item.timestamp)
    }));
    return res.json({ exchange: "UPBIT", quoteCurrency: "KRW", tickers, count: tickers.length, updatedAt: (/* @__PURE__ */ new Date()).toISOString() });
  } catch (error) {
    console.error("upbit tickers error:", error);
    return res.status(502).json({ exchange: "UPBIT", tickers: [], count: 0, error: "UPBIT_TICKERS_UNAVAILABLE" });
  }
});
router10.get("/crypto/spot/orderbook", async (req, res) => {
  const symbol = safeSymbol(req.query.symbol || "BTC");
  try {
    const rows = await fetchJson5(`${UPBIT_BASE}/v1/orderbook?markets=${encodeURIComponent(`KRW-${symbol}`)}&level=0`);
    const item = rows[0];
    if (!item) return res.status(404).json({ error: "ORDERBOOK_NOT_FOUND" });
    return res.json({
      exchange: "UPBIT",
      market: item.market,
      totalAskSize: finite(item.total_ask_size),
      totalBidSize: finite(item.total_bid_size),
      units: Array.isArray(item.orderbook_units) ? item.orderbook_units.map((unit) => ({ askPrice: finite(unit.ask_price), bidPrice: finite(unit.bid_price), askSize: finite(unit.ask_size), bidSize: finite(unit.bid_size) })) : [],
      timestamp: finite(item.timestamp)
    });
  } catch (error) {
    console.error("upbit orderbook error:", error);
    return res.status(502).json({ exchange: "UPBIT", units: [], error: "UPBIT_ORDERBOOK_UNAVAILABLE" });
  }
});
router10.get("/crypto/spot/candles", async (req, res) => {
  const symbol = safeSymbol(req.query.symbol || "BTC");
  const unit = Math.max(1, Math.min(240, Number(req.query.unit ?? 15) || 15));
  const count = Math.max(1, Math.min(200, Number(req.query.count ?? 120) || 120));
  try {
    const rows = await fetchJson5(`${UPBIT_BASE}/v1/candles/minutes/${unit}?market=${encodeURIComponent(`KRW-${symbol}`)}&count=${count}`);
    const candles = rows.reverse().map((row) => ({ time: row.candle_date_time_kst, open: finite(row.opening_price), high: finite(row.high_price), low: finite(row.low_price), close: finite(row.trade_price), volume: finite(row.candle_acc_trade_volume), tradingValue: finite(row.candle_acc_trade_price) }));
    return res.json({ exchange: "UPBIT", market: `KRW-${symbol}`, unit: `${unit}m`, candles, count: candles.length, updatedAt: (/* @__PURE__ */ new Date()).toISOString() });
  } catch (error) {
    console.error("upbit candles error:", error);
    return res.status(502).json({ exchange: "UPBIT", candles: [], count: 0, error: "UPBIT_CANDLES_UNAVAILABLE" });
  }
});
router10.get("/crypto/futures/tickers", async (req, res) => {
  const requested = safeSymbol(req.query.symbol);
  try {
    const payload = await fetchJson5(`${BITGET_BASE}/api/v2/mix/market/tickers?productType=USDT-FUTURES${requested ? `&symbol=${encodeURIComponent(requested)}` : ""}`);
    if (String(payload?.code ?? "") !== "00000" || !Array.isArray(payload?.data)) throw new Error(`BITGET_${String(payload?.code ?? "INVALID")}`);
    const tickers = payload.data.map((item) => ({
      symbol: String(item.symbol ?? ""),
      price: finite(item.lastPr),
      markPrice: finite(item.markPrice),
      indexPrice: finite(item.indexPrice),
      changePercent24h: finite(item.change24h) == null ? null : Number(item.change24h) * 100,
      high24h: finite(item.high24h),
      low24h: finite(item.low24h),
      volume24h: finite(item.baseVolume),
      tradingValue24h: finite(item.usdtVolume),
      fundingRate: finite(item.fundingRate),
      openInterest: finite(item.holdingAmount),
      bidPrice: finite(item.bidPr),
      askPrice: finite(item.askPr),
      timestamp: finite(item.ts)
    }));
    return res.json({ exchange: "BITGET", productType: "USDT-FUTURES", tickers, count: tickers.length, updatedAt: (/* @__PURE__ */ new Date()).toISOString() });
  } catch (error) {
    console.error("bitget tickers error:", error);
    return res.status(502).json({ exchange: "BITGET", tickers: [], count: 0, error: "BITGET_TICKERS_UNAVAILABLE" });
  }
});
router10.get("/crypto/futures/candles", async (req, res) => {
  const symbol = safeSymbol(req.query.symbol || "BTCUSDT");
  const allowed = /* @__PURE__ */ new Set(["1m", "3m", "5m", "15m", "30m", "1H", "4H", "6H", "12H", "1D", "1W"]);
  const rawGranularity = String(req.query.granularity ?? "15m");
  const granularity = allowed.has(rawGranularity) ? rawGranularity : "15m";
  const limit = Math.max(1, Math.min(1e3, Number(req.query.limit ?? 200) || 200));
  try {
    const payload = await fetchJson5(`${BITGET_BASE}/api/v2/mix/market/candles?symbol=${encodeURIComponent(symbol)}&productType=USDT-FUTURES&granularity=${encodeURIComponent(granularity)}&limit=${limit}`);
    if (String(payload?.code ?? "") !== "00000" || !Array.isArray(payload?.data)) throw new Error(`BITGET_${String(payload?.code ?? "INVALID")}`);
    const candles = payload.data.reverse().map((row) => ({ time: finite(row[0]), open: finite(row[1]), high: finite(row[2]), low: finite(row[3]), close: finite(row[4]), volume: finite(row[5]), quoteVolume: finite(row[6]) }));
    return res.json({ exchange: "BITGET", symbol, productType: "USDT-FUTURES", granularity, candles, count: candles.length, updatedAt: (/* @__PURE__ */ new Date()).toISOString() });
  } catch (error) {
    console.error("bitget candles error:", error);
    return res.status(502).json({ exchange: "BITGET", candles: [], count: 0, error: "BITGET_CANDLES_UNAVAILABLE" });
  }
});
router10.get("/crypto/spot/accounts", async (_req, res) => {
  const accessKey = String(process.env.UPBIT_ACCESS_KEY ?? "").trim();
  const secretKey = String(process.env.UPBIT_SECRET_KEY ?? "").trim();
  if (!accessKey || !secretKey) return res.status(503).json({ exchange: "UPBIT", configured: false, accounts: [], error: "UPBIT_PRIVATE_KEYS_NOT_CONFIGURED" });
  try {
    const token = createUpbitToken(accessKey, secretKey);
    const rows = await fetchJsonWithHeaders(`${UPBIT_BASE}/v1/accounts`, { Authorization: `Bearer ${token}` });
    const accounts = rows.map((row) => ({
      currency: String(row.currency ?? ""),
      balance: finite(row.balance),
      locked: finite(row.locked),
      averageBuyPrice: finite(row.avg_buy_price),
      averageBuyPriceModified: Boolean(row.avg_buy_price_modified),
      unitCurrency: String(row.unit_currency ?? "KRW")
    }));
    return res.json({ exchange: "UPBIT", configured: true, accounts, count: accounts.length, updatedAt: (/* @__PURE__ */ new Date()).toISOString() });
  } catch (error) {
    console.error("upbit accounts error:", error instanceof Error ? error.message : error);
    return res.status(502).json({ exchange: "UPBIT", configured: true, accounts: [], error: "UPBIT_ACCOUNTS_UNAVAILABLE" });
  }
});
router10.get("/crypto/futures/account", async (_req, res) => {
  const path6 = "/api/v2/mix/account/accounts";
  const query = "productType=USDT-FUTURES";
  try {
    const payload = await fetchJsonWithHeaders(`${BITGET_BASE}${path6}?${query}`, bitgetHeaders("GET", path6, query));
    if (String(payload?.code ?? "") !== "00000" || !Array.isArray(payload?.data)) throw new Error(`BITGET_${String(payload?.code ?? "INVALID")}`);
    const accounts = payload.data.map((row) => ({
      marginCoin: String(row.marginCoin ?? ""),
      available: finite(row.available),
      locked: finite(row.locked),
      accountEquity: finite(row.accountEquity),
      unrealizedPL: finite(row.unrealizedPL),
      crossedMaxAvailable: finite(row.crossedMaxAvailable),
      isolatedMaxAvailable: finite(row.isolatedMaxAvailable)
    }));
    return res.json({ exchange: "BITGET", configured: true, accounts, count: accounts.length, updatedAt: (/* @__PURE__ */ new Date()).toISOString() });
  } catch (error) {
    const notConfigured = error instanceof Error && error.message === "BITGET_PRIVATE_KEYS_NOT_CONFIGURED";
    console.error("bitget account error:", error instanceof Error ? error.message : error);
    return res.status(notConfigured ? 503 : 502).json({ exchange: "BITGET", configured: !notConfigured, accounts: [], error: notConfigured ? "BITGET_PRIVATE_KEYS_NOT_CONFIGURED" : "BITGET_ACCOUNT_UNAVAILABLE" });
  }
});
router10.get("/crypto/futures/positions", async (_req, res) => {
  const path6 = "/api/v2/mix/position/all-position";
  const query = "productType=USDT-FUTURES&marginCoin=USDT";
  try {
    const payload = await fetchJsonWithHeaders(`${BITGET_BASE}${path6}?${query}`, bitgetHeaders("GET", path6, query));
    if (String(payload?.code ?? "") !== "00000" || !Array.isArray(payload?.data)) throw new Error(`BITGET_${String(payload?.code ?? "INVALID")}`);
    const positions = payload.data.map((row) => ({
      symbol: String(row.symbol ?? ""),
      holdSide: String(row.holdSide ?? ""),
      total: finite(row.total),
      available: finite(row.available),
      openPriceAvg: finite(row.openPriceAvg),
      markPrice: finite(row.markPrice),
      unrealizedPL: finite(row.unrealizedPL),
      liquidationPrice: finite(row.liquidationPrice),
      leverage: finite(row.leverage),
      marginMode: String(row.marginMode ?? ""),
      marginSize: finite(row.marginSize),
      breakEvenPrice: finite(row.breakEvenPrice)
    })).filter((row) => Number(row.total ?? 0) !== 0);
    return res.json({ exchange: "BITGET", configured: true, positions, count: positions.length, updatedAt: (/* @__PURE__ */ new Date()).toISOString() });
  } catch (error) {
    const notConfigured = error instanceof Error && error.message === "BITGET_PRIVATE_KEYS_NOT_CONFIGURED";
    console.error("bitget positions error:", error instanceof Error ? error.message : error);
    return res.status(notConfigured ? 503 : 502).json({ exchange: "BITGET", configured: !notConfigured, positions: [], error: notConfigured ? "BITGET_PRIVATE_KEYS_NOT_CONFIGURED" : "BITGET_POSITIONS_UNAVAILABLE" });
  }
});
var crypto_default = router10;

// src/routes/backup.ts
import { createHash } from "node:crypto";
import { Router as Router11 } from "express";
var router11 = Router11();
var ALLOWED_KEYS = /* @__PURE__ */ new Set([
  "knowledge-info-asset-mode-v1",
  "sa-settings-v1",
  "stock-currency-mode",
  "app-accent-color",
  "app-appearance-mode",
  "seungjae_watchlist_v1",
  "scanner.threshold.v1",
  "scanner-market",
  "sa-auto-trade-settings-v1",
  "sa-portfolio-chart-overlays-v1",
  "sa-portfolio-purchase-dates-v1",
  "sa-chart-volume-height-v1",
  "sa-chart-frames-v1",
  "sa-chart-ma-v1"
]);
var MAX_BACKUP_BYTES = 5 * 1024 * 1024;
var MAX_ITEMS = 500;
var MAX_VALUE_BYTES = 1024 * 1024;
function normalizePayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("INVALID_BACKUP_PAYLOAD");
  }
  const result = {};
  const entries = Object.entries(value);
  if (entries.length > MAX_ITEMS) throw new Error("BACKUP_ITEM_LIMIT_EXCEEDED");
  for (const [key, item] of entries) {
    if (!ALLOWED_KEYS.has(key) || typeof item !== "string") continue;
    if (Buffer.byteLength(item, "utf8") > MAX_VALUE_BYTES) {
      throw new Error("BACKUP_VALUE_TOO_LARGE");
    }
    result[key] = item;
  }
  const encoded = JSON.stringify(result);
  if (Buffer.byteLength(encoded, "utf8") > MAX_BACKUP_BYTES) {
    throw new Error("BACKUP_TOO_LARGE");
  }
  return result;
}
function checksum(payload) {
  const sorted = Object.fromEntries(Object.entries(payload).sort(([a], [b]) => a.localeCompare(b)));
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}
router11.get("/latest", async (req, res) => {
  if (!req.member || !req.accessToken) return res.status(401).json({ error: "LOGIN_REQUIRED" });
  try {
    const supabase = getUserSupabase(req.accessToken);
    const { data, error } = await supabase.from("app_backups").select("schema_version,payload,item_count,checksum,client_updated_at,updated_at").eq("member_id", req.member.id).maybeSingle();
    if (error) throw error;
    if (!data) return res.json({ ok: true, exists: false });
    return res.json({
      ok: true,
      exists: true,
      schemaVersion: data.schema_version,
      localStorage: normalizePayload(data.payload),
      itemCount: data.item_count,
      checksum: data.checksum,
      clientUpdatedAt: data.client_updated_at,
      updatedAt: data.updated_at
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "BACKUP_READ_FAILED";
    return res.status(503).json({ error: "BACKUP_READ_FAILED", detail: message });
  }
});
router11.put("/latest", async (req, res) => {
  if (!req.member || !req.accessToken) return res.status(401).json({ error: "LOGIN_REQUIRED" });
  try {
    const schemaVersion = Number(req.body?.schemaVersion ?? 1);
    if (!Number.isInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > 20) {
      return res.status(400).json({ error: "INVALID_BACKUP_VERSION" });
    }
    const payload = normalizePayload(req.body?.localStorage);
    const clientUpdatedAt = req.body?.clientUpdatedAt ? new Date(String(req.body.clientUpdatedAt)).toISOString() : (/* @__PURE__ */ new Date()).toISOString();
    const digest = checksum(payload);
    const supabase = getUserSupabase(req.accessToken);
    const { data, error } = await supabase.from("app_backups").upsert(
      {
        member_id: req.member.id,
        schema_version: schemaVersion,
        payload,
        item_count: Object.keys(payload).length,
        checksum: digest,
        client_updated_at: clientUpdatedAt,
        updated_at: (/* @__PURE__ */ new Date()).toISOString()
      },
      { onConflict: "member_id" }
    ).select("schema_version,item_count,checksum,client_updated_at,updated_at").single();
    if (error) throw error;
    return res.json({
      ok: true,
      exists: true,
      schemaVersion: data.schema_version,
      itemCount: data.item_count,
      checksum: data.checksum,
      clientUpdatedAt: data.client_updated_at,
      updatedAt: data.updated_at
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "BACKUP_SAVE_FAILED";
    const status = message.startsWith("BACKUP_") || message.startsWith("INVALID_") ? 400 : 503;
    return res.status(status).json({ error: message, detail: message });
  }
});
var backup_default = router11;

// src/routes/index.ts
var router12 = Router12();
router12.get("/", (_req, res) => {
  res.json({ ok: true, service: "seungjae-stock-api" });
});
router12.use("/", health_default);
router12.use("/", market_default);
router12.use("/", news_route_default);
router12.use("/kiwoom", kiwoom_routes_default);
router12.use("/", crypto_default);
router12.use("/admin", admin_default);
router12.use(requireMember);
router12.use("/debug", requireAdmin, provider_debug_default);
router12.use("/", push_default);
router12.use("/", watchlist_default);
router12.use("/stocks", stocks_default);
router12.use("/backup", backup_default);
var routes_default = router12;

// src/index.ts
var __filename = fileURLToPath(import.meta.url);
var __dirname = path5.dirname(__filename);
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
  path5.resolve(
    __dirname,
    "../../stock-analyzer/dist/public"
  ),
  path5.resolve(
    __dirname,
    "../../stock-analyzer/dist"
  ),
  path5.resolve(
    __dirname,
    "../../../stock-analyzer/dist/public"
  ),
  path5.resolve(
    __dirname,
    "../../../stock-analyzer/dist"
  ),
  path5.resolve(
    process.cwd(),
    "../stock-analyzer/dist/public"
  ),
  path5.resolve(
    process.cwd(),
    "../stock-analyzer/dist"
  ),
  path5.resolve(
    process.cwd(),
    "artifacts/stock-analyzer/dist/public"
  ),
  path5.resolve(
    process.cwd(),
    "artifacts/stock-analyzer/dist"
  ),
  path5.resolve(
    process.cwd(),
    "stock-analyzer/dist/public"
  ),
  path5.resolve(
    process.cwd(),
    "stock-analyzer/dist"
  )
];
var frontendDist = frontendDistCandidates.find(
  (candidate) => fs3.existsSync(
    path5.join(
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
      path5.join(
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
    startPriceAlertMonitor();
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
