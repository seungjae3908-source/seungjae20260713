# Stage 7 fixed-risk expectancy verification

- commit: 457d3544d6fd3383196a779c43d6dd45fd214e70
- started_at: 2026-07-26T13:24:20Z

## Install
- exit_code: 0
```text
! Corepack is about to download https://registry.npmjs.org/pnpm/-/pnpm-11.17.0.tgz
Scope: all 8 workspace projects
? Verifying lockfile against supply-chain policies (746 entries)...
Lockfile is up to date, resolution step is skipped
Progress: resolved 1, reused 0, downloaded 0, added 0
Packages: +650
++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
Progress: resolved 650, reused 0, downloaded 0, added 0
Progress: resolved 650, reused 0, downloaded 65, added 4
Progress: resolved 650, reused 0, downloaded 230, added 12
Progress: resolved 650, reused 0, downloaded 330, added 20
✓ Lockfile passes supply-chain policies (746 entries in 4.8s)
Progress: resolved 650, reused 0, downloaded 587, added 40
Progress: resolved 650, reused 0, downloaded 650, added 650, done
.../esbuild@0.27.3/node_modules/esbuild postinstall$ node install.js
.../esbuild@0.25.12/node_modules/esbuild postinstall$ node install.js
.../esbuild@0.27.3/node_modules/esbuild postinstall: Done
.../esbuild@0.25.12/node_modules/esbuild postinstall: Done

devDependencies:
+ typescript 5.9.3

Done in 7.6s using pnpm v11.17.0
```
## Frontend build
- exit_code: 0
```text
$ vite build --config vite.config.ts
[36mvite v6.4.3 [32mbuilding for production...[36m[39m
transforming...
[32m✓[39m 1802 modules transformed.
rendering chunks...
computing gzip size...
[2mdist/public/[22m[32mindex.html                             [39m[1m[2m  4.91 kB[22m[1m[22m[2m │ gzip:   1.98 kB[22m
[2mdist/public/[22m[2massets/[22m[35mindex-3Vi31GOW.css              [39m[1m[2m 81.60 kB[22m[1m[22m[2m │ gzip:  13.50 kB[22m
[2mdist/public/[22m[2massets/[22m[36mchevron-up-BsvCt413.js          [39m[1m[2m  0.30 kB[22m[1m[22m[2m │ gzip:   0.24 kB[22m
[2mdist/public/[22m[2massets/[22m[36mchevron-right-BVLb6lUN.js       [39m[1m[2m  0.30 kB[22m[1m[22m[2m │ gzip:   0.25 kB[22m
[2mdist/public/[22m[2massets/[22m[36mplus-DQ-ATrvv.js                [39m[1m[2m  0.32 kB[22m[1m[22m[2m │ gzip:   0.25 kB[22m
[2mdist/public/[22m[2massets/[22m[36mcircle-check-CYukHZbZ.js        [39m[1m[2m  0.34 kB[22m[1m[22m[2m │ gzip:   0.27 kB[22m
[2mdist/public/[22m[2massets/[22m[36mchart-line-BV0vSieC.js          [39m[1m[2m  0.35 kB[22m[1m[22m[2m │ gzip:   0.27 kB[22m
[2mdist/public/[22m[2massets/[22m[36msmartphone-D6SRydja.js          [39m[1m[2m  0.37 kB[22m[1m[22m[2m │ gzip:   0.29 kB[22m
[2mdist/public/[22m[2massets/[22m[36mlog-in-DL2CiErx.js              [39m[1m[2m  0.43 kB[22m[1m[22m[2m │ gzip:   0.32 kB[22m
[2mdist/public/[22m[2massets/[22m[36mdownload-CJJlraaU.js            [39m[1m[2m  0.43 kB[22m[1m[22m[2m │ gzip:   0.32 kB[22m
[2mdist/public/[22m[2massets/[22m[36mtriangle-alert-DBD6P1P5.js      [39m[1m[2m  0.43 kB[22m[1m[22m[2m │ gzip:   0.31 kB[22m
[2mdist/public/[22m[2massets/[22m[36mshield-check-DK5WkAbm.js        [39m[1m[2m  0.49 kB[22m[1m[22m[2m │ gzip:   0.35 kB[22m
[2mdist/public/[22m[2massets/[22m[36mrefresh-cw-DRCIkfKo.js          [39m[1m[2m  0.49 kB[22m[1m[22m[2m │ gzip:   0.32 kB[22m
[2mdist/public/[22m[2massets/[22m[36mwallet-cards-D1UJ_Lrj.js        [39m[1m[2m  0.50 kB[22m[1m[22m[2m │ gzip:   0.36 kB[22m
[2mdist/public/[22m[2massets/[22m[36mbot-BnIQJU3-.js                 [39m[1m[2m  0.50 kB[22m[1m[22m[2m │ gzip:   0.33 kB[22m
[2mdist/public/[22m[2massets/[22m[36mshield-alert-DkPiVSVQ.js        [39m[1m[2m  0.52 kB[22m[1m[22m[2m │ gzip:   0.36 kB[22m
[2mdist/public/[22m[2massets/[22m[36muse-stock-data-BJWp2wJH.js      [39m[1m[2m  0.59 kB[22m[1m[22m[2m │ gzip:   0.34 kB[22m
[2mdist/public/[22m[2massets/[22m[36mnot-found---b-mTXX.js           [39m[1m[2m  0.63 kB[22m[1m[22m[2m │ gzip:   0.42 kB[22m
[2mdist/public/[22m[2massets/[22m[36mportfolio-fx-DpK1wrvH.js        [39m[1m[2m  0.67 kB[22m[1m[22m[2m │ gzip:   0.46 kB[22m
[2mdist/public/[22m[2massets/[22m[36mcalculator-DqTuFIYT.js          [39m[1m[2m  0.70 kB[22m[1m[22m[2m │ gzip:   0.38 kB[22m
[2mdist/public/[22m[2massets/[22m[36mportfolio-cash-v2QYQPzs.js      [39m[1m[2m  1.00 kB[22m[1m[22m[2m │ gzip:   0.56 kB[22m
[2mdist/public/[22m[2massets/[22m[36masset-switch-CyObt4lr.js        [39m[1m[2m  1.33 kB[22m[1m[22m[2m │ gzip:   0.60 kB[22m
[2mdist/public/[22m[2massets/[22m[36mportfolio-calc-Ow6AIlPB.js      [39m[1m[2m  1.38 kB[22m[1m[22m[2m │ gzip:   0.53 kB[22m
[2mdist/public/[22m[2massets/[22m[36mapp-modal-DXRKT9Yu.js           [39m[1m[2m  1.45 kB[22m[1m[22m[2m │ gzip:   0.75 kB[22m
[2mdist/public/[22m[2massets/[22m[36mkey-round-DDxxMNv0.js           [39m[1m[2m  1.45 kB[22m[1m[22m[2m │ gzip:   0.57 kB[22m
[2mdist/public/[22m[2massets/[22m[36mportfolio-holdings-C_uUu9Tw.js  [39m[1m[2m  1.65 kB[22m[1m[22m[2m │ gzip:   0.83 kB[22m
[2mdist/public/[22m[2massets/[22m[36mnotifications-DouNyxvR.js       [39m[1m[2m  2.13 kB[22m[1m[22m[2m │ gzip:   1.02 kB[22m
[2mdist/public/[22m[2massets/[22m[36mtech-B5l5Vfw3.js                [39m[1m[2m  2.68 kB[22m[1m[22m[2m │ gzip:   1.36 kB[22m
[2mdist/public/[22m[2massets/[22m[36mwatchlist-assets-rM9YlDiE.js    [39m[1m[2m  5.05 kB[22m[1m[22m[2m │ gzip:   2.04 kB[22m
[2mdist/public/[22m[2massets/[22m[36mmarket-analysis-DF2BGkes.js     [39m[1m[2m  5.68 kB[22m[1m[22m[2m │ gzip:   2.08 kB[22m
[2mdist/public/[22m[2massets/[22m[36mauto-trade-DIwQ4PuW.js          [39m[1m[2m  6.25 kB[22m[1m[22m[2m │ gzip:   2.00 kB[22m
[2mdist/public/[22m[2massets/[22m[36masset-evaluation-D5XdJJae.js    [39m[1m[2m  7.33 kB[22m[1m[22m[2m │ gzip:   2.92 kB[22m
[2mdist/public/[22m[2massets/[22m[36minstall-Br7dLYed.js             [39m[1m[2m  8.25 kB[22m[1m[22m[2m │ gzip:   3.06 kB[22m
[2mdist/public/[22m[2massets/[22m[36mranking-CcF0ceo4.js             [39m[1m[2m  8.36 kB[22m[1m[22m[2m │ gzip:   3.24 kB[22m
[2mdist/public/[22m[2massets/[22m[36mrecommendations-BQqSLcg4.js     [39m[1m[2m  8.59 kB[22m[1m[22m[2m │ gzip:   3.25 kB[22m
[2mdist/public/[22m[2massets/[22m[36mportfolio-cash-gWQoSWy4.js      [39m[1m[2m  9.85 kB[22m[1m[22m[2m │ gzip:   3.69 kB[22m
[2mdist/public/[22m[2massets/[22m[36mfavorite-button-DdtJYtwh.js     [39m[1m[2m  9.95 kB[22m[1m[22m[2m │ gzip:   4.08 kB[22m
[2mdist/public/[22m[2massets/[22m[36mportfolio-plan-CrtfZr6v.js      [39m[1m[2m 11.94 kB[22m[1m[22m[2m │ gzip:   4.11 kB[22m
[2mdist/public/[22m[2massets/[22m[36msignal-scan-D8AJRStz.js         [39m[1m[2m 13.14 kB[22m[1m[22m[2m │ gzip:   4.56 kB[22m
[2mdist/public/[22m[2massets/[22m[36mportfolio-simulate-CeVPT8pN.js  [39m[1m[2m 15.06 kB[22m[1m[22m[2m │ gzip:   5.11 kB[22m
[2mdist/public/[22m[2massets/[22m[36maccount-Cu6UIS3d.js             [39m[1m[2m 16.90 kB[22m[1m[22m[2m │ gzip:   4.57 kB[22m
[2mdist/public/[22m[2massets/[22m[36mwatchlist-DHQ8nB70.js           [39m[1m[2m 21.40 kB[22m[1m[22m[2m │ gzip:   6.29 kB[22m
[2mdist/public/[22m[2massets/[22m[36madmin-qbpj3vc2.js               [39m[1m[2m 22.81 kB[22m[1m[22m[2m │ gzip:   5.83 kB[22m
[2mdist/public/[22m[2massets/[22m[36malerts-D-C9DMSg.js              [39m[1m[2m 24.33 kB[22m[1m[22m[2m │ gzip:   6.96 kB[22m
[2mdist/public/[22m[2massets/[22m[36mlearn-CUw4b5yr.js               [39m[1m[2m 27.18 kB[22m[1m[22m[2m │ gzip:   9.25 kB[22m
[2mdist/public/[22m[2massets/[22m[36mstock-info-CQhM3WQk.js          [39m[1m[2m 28.56 kB[22m[1m[22m[2m │ gzip:   8.66 kB[22m
[2mdist/public/[22m[2massets/[22m[36mstocks-DjLTOQVJ.js              [39m[1m[2m 29.49 kB[22m[1m[22m[2m │ gzip:   8.94 kB[22m
[2mdist/public/[22m[2massets/[22m[36mmore-BujlwaQm.js                [39m[1m[2m 42.81 kB[22m[1m[22m[2m │ gzip:  10.74 kB[22m
[2mdist/public/[22m[2massets/[22m[36mportfolio-D0Buzc2z.js           [39m[1m[2m 47.44 kB[22m[1m[22m[2m │ gzip:  13.18 kB[22m
[2mdist/public/[22m[2massets/[22m[36mchart-broadcast-Dfn95Xb2.js     [39m[1m[2m 74.81 kB[22m[1m[22m[2m │ gzip:  21.91 kB[22m
[2mdist/public/[22m[2massets/[22m[36mchart-relay-BrlifpRA.js         [39m[1m[2m118.10 kB[22m[1m[22m[2m │ gzip:  32.95 kB[22m
[2mdist/public/[22m[2massets/[22m[36mscanner-DpZOEiKT.js             [39m[1m[2m155.21 kB[22m[1m[22m[2m │ gzip:  40.97 kB[22m
[2mdist/public/[22m[2massets/[22m[36mindex-B5n6f-cH.js               [39m[1m[33m767.89 kB[39m[22m[2m │ gzip: 241.03 kB[22m
[33m
(!) Some chunks are larger than 500 kB after minification. Consider:
- Using dynamic import() to code-split the application
- Use build.rollupOptions.output.manualChunks to improve chunking: https://rollupjs.org/configuration-options/#output-manualchunks
- Adjust chunk size limit for this warning via build.chunkSizeWarningLimit.[39m
[32m✓ built in 4.88s[39m
```
## Backend typecheck
- exit_code: 2
```text
$ tsc -p tsconfig.json --noEmit
src/lib/risk.ts(4,15): error TS2305: Module '"../providers/sec-edgar"' has no exported member 'FilingCounts'.
src/providers/dart.ts(14,15): error TS2305: Module '"./sec-edgar"' has no exported member 'FinancialsRaw'.
src/providers/sec-edgar.ts(224,3): error TS2322: Type '{ label: string; value: number; unit: string; period: string; }[]' is not assignable to type 'FinancialRow[]'.
  Type '{ label: string; value: number; unit: string; period: string; }' is missing the following properties from type 'FinancialRow': revenue, operatingIncome, netIncome, cash, debt
src/services/financial.service.ts(11,15): error TS2305: Module '"../providers/sec-edgar"' has no exported member 'FinancialsRaw'.
src/services/financial.service.ts(106,9): error TS2339: Property 'getFinancials' does not exist on type 'typeof import("/home/runner/work/seungjae20260713/seungjae20260713/api-server/src/providers/sec-edgar")'.
/home/runner/work/seungjae20260713/seungjae20260713/api-server:
[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @workspace/api-server@0.0.0 typecheck: `tsc -p tsconfig.json --noEmit`
Exit status 2
```
## Python dependencies
- exit_code: 0
```text
Collecting numpy
  Downloading numpy-2.5.1-cp312-cp312-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl.metadata (6.6 kB)
Collecting pandas
  Downloading pandas-3.0.5-cp312-cp312-manylinux_2_24_x86_64.manylinux_2_28_x86_64.whl.metadata (79 kB)
Collecting requests
  Downloading requests-2.34.2-py3-none-any.whl.metadata (4.8 kB)
Collecting python-dateutil>=2.8.2 (from pandas)
  Downloading python_dateutil-2.9.0.post0-py2.py3-none-any.whl.metadata (8.4 kB)
Collecting charset_normalizer<4,>=2 (from requests)
  Downloading charset_normalizer-3.4.9-cp312-cp312-manylinux2014_x86_64.manylinux_2_17_x86_64.manylinux_2_28_x86_64.whl.metadata (41 kB)
Collecting idna<4,>=2.5 (from requests)
  Downloading idna-3.18-py3-none-any.whl.metadata (6.1 kB)
Collecting urllib3<3,>=1.26 (from requests)
  Downloading urllib3-2.7.0-py3-none-any.whl.metadata (6.9 kB)
Collecting certifi>=2023.5.7 (from requests)
  Downloading certifi-2026.7.22-py3-none-any.whl.metadata (2.5 kB)
Collecting six>=1.5 (from python-dateutil>=2.8.2->pandas)
  Downloading six-1.17.0-py2.py3-none-any.whl.metadata (1.7 kB)
Downloading numpy-2.5.1-cp312-cp312-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl (16.7 MB)
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 16.7/16.7 MB 280.0 MB/s  0:00:00
Downloading pandas-3.0.5-cp312-cp312-manylinux_2_24_x86_64.manylinux_2_28_x86_64.whl (11.0 MB)
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 11.0/11.0 MB 305.3 MB/s  0:00:00
Downloading requests-2.34.2-py3-none-any.whl (73 kB)
Downloading charset_normalizer-3.4.9-cp312-cp312-manylinux2014_x86_64.manylinux_2_17_x86_64.manylinux_2_28_x86_64.whl (224 kB)
Downloading idna-3.18-py3-none-any.whl (65 kB)
Downloading urllib3-2.7.0-py3-none-any.whl (131 kB)
Downloading certifi-2026.7.22-py3-none-any.whl (136 kB)
Downloading python_dateutil-2.9.0.post0-py2.py3-none-any.whl (229 kB)
Downloading six-1.17.0-py2.py3-none-any.whl (11 kB)
Installing collected packages: urllib3, six, numpy, idna, charset_normalizer, certifi, requests, python-dateutil, pandas

Successfully installed certifi-2026.7.22 charset_normalizer-3.4.9 idna-3.18 numpy-2.5.1 pandas-3.0.5 python-dateutil-2.9.0.post0 requests-2.34.2 six-1.17.0 urllib3-2.7.0
```
## Syntax and synthetic risk tests
- exit_code: 0
```text
self-test passed
```
## Public-data backtest
- exit_code: 0
```text
        "SOLUSDT": -1350.0,
        "XRPUSDT": 183.51538712353675,
        "DOGEUSDT": 0
      },
      "scope": "FOLD_A_OLDEST"
    },
    {
      "timeframe": "1H",
      "plan": "BALANCED_1_5R_2_5R_4R",
      "period_start": "2025-07-31T14:00:00+00:00",
      "period_end": "2026-01-27T13:00:00+00:00",
      "bars": 4299,
      "initial_equity_krw": 300000.0,
      "final_equity_krw": 299281.31942026154,
      "net_pnl_krw": -718.6805797384586,
      "return_pct": -0.23956019324615774,
      "trades": 9,
      "wins": 3,
      "losses": 6,
      "win_rate_pct": 33.33333333333333,
      "profit_factor": 0.771847435003672,
      "average_win_krw": 810.4398067538572,
      "average_loss_krw": -525.0000000000008,
      "expectancy_per_trade_krw": -79.85339774871487,
      "expectancy_r": -0.053235598499143236,
      "maximum_drawdown_pct": -0.676016076667506,
      "maximum_consecutive_losses": 2,
      "total_fees_krw": 765.626750786935,
      "estimated_slippage_krw": 957.0369982553067,
      "approx_pre_cost_pnl_krw": 1003.983169303783,
      "daily_lock_days": [],
      "total_loss_lock_triggered": false,
      "symbol_pnl_krw": {
        "BTCUSDT": 102.37635020776833,
        "ETHUSDT": -386.3122025970462,
        "SOLUSDT": 465.2552726508441,
        "XRPUSDT": -450.00000000000006,
        "DOGEUSDT": -450.0
      },
      "scope": "FOLD_B_MIDDLE"
    },
    {
      "timeframe": "1H",
      "plan": "BALANCED_1_5R_2_5R_4R",
      "period_start": "2026-01-27T14:00:00+00:00",
      "period_end": "2026-07-26T12:00:00+00:00",
      "bars": 4298,
      "initial_equity_krw": 300000.0,
      "final_equity_krw": 297295.12893039186,
      "net_pnl_krw": -2704.87106960814,
      "return_pct": -0.9016236898693797,
      "trades": 3,
      "wins": 0,
      "losses": 3,
      "win_rate_pct": 0.0,
      "profit_factor": 0.0,
      "average_win_krw": 0.0,
      "average_loss_krw": -901.6236898693746,
      "expectancy_per_trade_krw": -901.6236898693746,
      "expectancy_r": -0.6010824599129164,
      "maximum_drawdown_pct": -0.948952976715433,
      "maximum_consecutive_losses": 3,
      "total_fees_krw": 470.0778150198065,
      "estimated_slippage_krw": 587.593562575442,
      "approx_pre_cost_pnl_krw": -1647.1996920128913,
      "daily_lock_days": [],
      "total_loss_lock_triggered": false,
      "symbol_pnl_krw": {
        "BTCUSDT": -2360.9601412746047,
        "ETHUSDT": 0,
        "SOLUSDT": 0,
        "XRPUSDT": 0,
        "DOGEUSDT": -343.9109283335192
      },
      "scope": "FOLD_C_LATEST"
    },
    {
      "timeframe": "1H",
      "plan": "FIXED_3R_ALL",
      "period_start": "2025-02-01T14:00:00+00:00",
      "period_end": "2025-07-31T13:00:00+00:00",
      "bars": 4298,
      "initial_equity_krw": 300000.0,
      "final_equity_krw": 294577.71405367734,
      "net_pnl_krw": -5422.285946322663,
      "return_pct": -1.807428648774223,
      "trades": 12,
      "wins": 1,
      "losses": 11,
      "win_rate_pct": 8.333333333333332,
      "profit_factor": 0.0047153256586704535,
      "average_win_krw": 25.6889759387323,
      "average_loss_krw": -495.2704474783081,
      "expectancy_per_trade_krw": -451.85716219355476,
      "expectancy_r": -0.30123810812903645,
      "maximum_drawdown_pct": -1.9679506004771392,
      "maximum_consecutive_losses": 10,
      "total_fees_krw": 805.6381606020087,
      "estimated_slippage_krw": 1007.0395791340421,
      "approx_pre_cost_pnl_krw": -3609.6082065866126,
      "daily_lock_days": [],
      "total_loss_lock_triggered": false,
      "symbol_pnl_krw": {
        "BTCUSDT": -3197.974922261389,
        "ETHUSDT": -900.0,
        "SOLUSDT": -1350.0,
        "XRPUSDT": 25.6889759387323,
        "DOGEUSDT": 0
      },
      "scope": "FOLD_A_OLDEST"
    },
    {
      "timeframe": "1H",
      "plan": "FIXED_3R_ALL",
      "period_start": "2025-07-31T14:00:00+00:00",
      "period_end": "2026-01-27T13:00:00+00:00",
      "bars": 4299,
      "initial_equity_krw": 300000.0,
      "final_equity_krw": 297319.3070892959,
      "net_pnl_krw": -2680.6929107041215,
      "return_pct": -0.8935643035680396,
      "trades": 9,
      "wins": 1,
      "losses": 8,
      "win_rate_pct": 11.11111111111111,
      "profit_factor": 0.43900207716953576,
      "average_win_krw": 2097.7435176856725,
      "average_loss_krw": -597.3045535487172,
      "expectancy_per_trade_krw": -297.85476785600724,
      "expectancy_r": -0.19856984523733814,
      "maximum_drawdown_pct": -1.4204469323211526,
      "maximum_consecutive_losses": 5,
      "total_fees_krw": 762.5749087117428,
      "estimated_slippage_krw": 953.2164648612284,
      "approx_pre_cost_pnl_krw": -964.9015371311502,
      "daily_lock_days": [],
      "total_loss_lock_triggered": false,
      "symbol_pnl_krw": {
        "BTCUSDT": -1950.0000000000084,
        "ETHUSDT": -578.4364283897291,
        "SOLUSDT": 747.7435176856727,
        "XRPUSDT": -450.00000000000006,
        "DOGEUSDT": -450.0
      },
      "scope": "FOLD_B_MIDDLE"
    },
    {
      "timeframe": "1H",
      "plan": "FIXED_3R_ALL",
      "period_start": "2026-01-27T14:00:00+00:00",
      "period_end": "2026-07-26T12:00:00+00:00",
      "bars": 4298,
      "initial_equity_krw": 300000.0,
      "final_equity_krw": 297295.12893039186,
      "net_pnl_krw": -2704.87106960814,
      "return_pct": -0.9016236898693797,
      "trades": 3,
      "wins": 0,
      "losses": 3,
      "win_rate_pct": 0.0,
      "profit_factor": 0.0,
      "average_win_krw": 0.0,
      "average_loss_krw": -901.6236898693746,
      "expectancy_per_trade_krw": -901.6236898693746,
      "expectancy_r": -0.6010824599129164,
      "maximum_drawdown_pct": -0.948952976715433,
      "maximum_consecutive_losses": 3,
      "total_fees_krw": 470.0778150198065,
      "estimated_slippage_krw": 587.593562575442,
      "approx_pre_cost_pnl_krw": -1647.1996920128913,
      "daily_lock_days": [],
      "total_loss_lock_triggered": false,
      "symbol_pnl_krw": {
        "BTCUSDT": -2360.9601412746047,
        "ETHUSDT": 0,
        "SOLUSDT": 0,
        "XRPUSDT": 0,
        "DOGEUSDT": -343.9109283335192
      },
      "scope": "FOLD_C_LATEST"
    }
  ],
  "pass_evaluation": [
    {
      "timeframe": "15m",
      "plan": "EXPECTANCY_2R_3R_5R",
      "conditions": {
        "net_positive": false,
        "profit_factor_at_least_1_30": false,
        "expectancy_r_positive": "False",
        "maximum_drawdown_within_5pct": false,
        "at_least_50_trades": true,
        "at_least_2_positive_folds": false,
        "at_least_3_profitable_symbols": false,
        "largest_profit_symbol_below_60pct": false
      },
      "passed": false,
      "positive_folds": 0,
      "positive_symbols": 1,
      "largest_profit_symbol_share": 1.0
    },
    {
      "timeframe": "15m",
      "plan": "BALANCED_1_5R_2_5R_4R",
      "conditions": {
        "net_positive": false,
        "profit_factor_at_least_1_30": false,
        "expectancy_r_positive": "False",
        "maximum_drawdown_within_5pct": false,
        "at_least_50_trades": true,
        "at_least_2_positive_folds": false,
        "at_least_3_profitable_symbols": false,
        "largest_profit_symbol_below_60pct": false
      },
      "passed": false,
      "positive_folds": 0,
      "positive_symbols": 1,
      "largest_profit_symbol_share": 1.0
    },
    {
      "timeframe": "15m",
      "plan": "FIXED_3R_ALL",
      "conditions": {
        "net_positive": false,
        "profit_factor_at_least_1_30": false,
        "expectancy_r_positive": "False",
        "maximum_drawdown_within_5pct": false,
        "at_least_50_trades": true,
        "at_least_2_positive_folds": false,
        "at_least_3_profitable_symbols": false,
        "largest_profit_symbol_below_60pct": false
      },
      "passed": false,
      "positive_folds": 1,
      "positive_symbols": 1,
      "largest_profit_symbol_share": 1.0
    },
    {
      "timeframe": "1H",
      "plan": "EXPECTANCY_2R_3R_5R",
      "conditions": {
        "net_positive": false,
        "profit_factor_at_least_1_30": false,
        "expectancy_r_positive": "False",
        "maximum_drawdown_within_5pct": true,
        "at_least_50_trades": false,
        "at_least_2_positive_folds": false,
        "at_least_3_profitable_symbols": false,
        "largest_profit_symbol_below_60pct": false
      },
      "passed": false,
      "positive_folds": 0,
      "positive_symbols": 0,
      "largest_profit_symbol_share": 1.0
    },
    {
      "timeframe": "1H",
      "plan": "BALANCED_1_5R_2_5R_4R",
      "conditions": {
        "net_positive": false,
        "profit_factor_at_least_1_30": false,
        "expectancy_r_positive": "False",
        "maximum_drawdown_within_5pct": true,
        "at_least_50_trades": false,
        "at_least_2_positive_folds": false,
        "at_least_3_profitable_symbols": false,
        "largest_profit_symbol_below_60pct": false
      },
      "passed": false,
      "positive_folds": 0,
      "positive_symbols": 0,
      "largest_profit_symbol_share": 1.0
    },
    {
      "timeframe": "1H",
      "plan": "FIXED_3R_ALL",
      "conditions": {
        "net_positive": false,
        "profit_factor_at_least_1_30": false,
        "expectancy_r_positive": "False",
        "maximum_drawdown_within_5pct": true,
        "at_least_50_trades": false,
        "at_least_2_positive_folds": false,
        "at_least_3_profitable_symbols": false,
        "largest_profit_symbol_below_60pct": false
      },
      "passed": false,
      "positive_folds": 0,
      "positive_symbols": 0,
      "largest_profit_symbol_share": 1.0
    }
  ],
  "limitations": [
    "Historical OI, long/short ratios, order-book depth and liquidation streams are not fabricated and are excluded.",
    "KRW-equivalent sizing uses percentage returns and does not require a fabricated historical USD/KRW rate.",
    "Intrabar ambiguity uses stop-first ordering and one non-stop action per candle.",
    "This test compares three predefined exit plans; it does not tune parameters until profitable.",
    "Simulated performance cannot justify live orders without forward shadow validation."
  ]
}
```

## Outcomes
- install: success
- frontend: success
- backend: failure
- python_install: success
- self_test: success
- backtest: success
- finished_at: 2026-07-26T13:35:07Z
