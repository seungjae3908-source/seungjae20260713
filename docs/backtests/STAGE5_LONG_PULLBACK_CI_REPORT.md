# Stage 5 CI verification report

- started_at: 2026-07-26T10:47:00Z
- commit: ae47a1b229805b22cc6b8fda1861dc6da16a08a1

## Enable pnpm
- exit_code: 0
```text
```
## Install workspace
- exit_code: 0
```text
! Corepack is about to download https://registry.npmjs.org/pnpm/-/pnpm-11.17.0.tgz
Scope: all 8 workspace projects
? Verifying lockfile against supply-chain policies (746 entries)...
Lockfile is up to date, resolution step is skipped
Progress: resolved 1, reused 0, downloaded 0, added 0
Packages: +650
++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
Progress: resolved 650, reused 0, downloaded 146, added 8
Progress: resolved 650, reused 0, downloaded 344, added 24
Progress: resolved 650, reused 0, downloaded 480, added 36
Progress: resolved 650, reused 0, downloaded 650, added 650, done
✓ Lockfile passes supply-chain policies (746 entries in 4.2s)
.../esbuild@0.27.3/node_modules/esbuild postinstall$ node install.js
.../esbuild@0.25.12/node_modules/esbuild postinstall$ node install.js
.../esbuild@0.27.3/node_modules/esbuild postinstall: Done
.../esbuild@0.25.12/node_modules/esbuild postinstall: Done

devDependencies:
+ typescript 5.9.3

Done in 5.6s using pnpm v11.17.0
```
## Frontend build
- exit_code: 0
```text
$ vite build --config vite.config.ts
[36mvite v6.4.3 [32mbuilding for production...[36m[39m
transforming...
[32m✓[39m 1804 modules transformed.
rendering chunks...
computing gzip size...
[2mdist/public/[22m[32mindex.html                             [39m[1m[2m  4.91 kB[22m[1m[22m[2m │ gzip:   1.98 kB[22m
[2mdist/public/[22m[2massets/[22m[35mindex-BNrjzLmB.css              [39m[1m[2m 81.41 kB[22m[1m[22m[2m │ gzip:  13.47 kB[22m
[2mdist/public/[22m[2massets/[22m[36mchevron-up-Davl_BBH.js          [39m[1m[2m  0.30 kB[22m[1m[22m[2m │ gzip:   0.25 kB[22m
[2mdist/public/[22m[2massets/[22m[36mchevron-right-D5o3NOZj.js       [39m[1m[2m  0.30 kB[22m[1m[22m[2m │ gzip:   0.25 kB[22m
[2mdist/public/[22m[2massets/[22m[36mplus-CS50aYR4.js                [39m[1m[2m  0.32 kB[22m[1m[22m[2m │ gzip:   0.25 kB[22m
[2mdist/public/[22m[2massets/[22m[36mcircle-check-BZWJOiUP.js        [39m[1m[2m  0.34 kB[22m[1m[22m[2m │ gzip:   0.27 kB[22m
[2mdist/public/[22m[2massets/[22m[36mchart-line-DoJOeXsD.js          [39m[1m[2m  0.35 kB[22m[1m[22m[2m │ gzip:   0.28 kB[22m
[2mdist/public/[22m[2massets/[22m[36msmartphone-BRp17x0R.js          [39m[1m[2m  0.37 kB[22m[1m[22m[2m │ gzip:   0.29 kB[22m
[2mdist/public/[22m[2massets/[22m[36mlog-in-CsDFLmYr.js              [39m[1m[2m  0.43 kB[22m[1m[22m[2m │ gzip:   0.32 kB[22m
[2mdist/public/[22m[2massets/[22m[36mdownload-cJUBng1N.js            [39m[1m[2m  0.43 kB[22m[1m[22m[2m │ gzip:   0.32 kB[22m
[2mdist/public/[22m[2massets/[22m[36mtriangle-alert-BvHlCVOy.js      [39m[1m[2m  0.43 kB[22m[1m[22m[2m │ gzip:   0.31 kB[22m
[2mdist/public/[22m[2massets/[22m[36mshield-check-Heu5xDLd.js        [39m[1m[2m  0.49 kB[22m[1m[22m[2m │ gzip:   0.35 kB[22m
[2mdist/public/[22m[2massets/[22m[36mrefresh-cw-CrMNMY2w.js          [39m[1m[2m  0.49 kB[22m[1m[22m[2m │ gzip:   0.33 kB[22m
[2mdist/public/[22m[2massets/[22m[36mwallet-cards-93rcv-ub.js        [39m[1m[2m  0.50 kB[22m[1m[22m[2m │ gzip:   0.36 kB[22m
[2mdist/public/[22m[2massets/[22m[36mbot-BFuooubB.js                 [39m[1m[2m  0.50 kB[22m[1m[22m[2m │ gzip:   0.33 kB[22m
[2mdist/public/[22m[2massets/[22m[36mshield-alert-BrvwdXI3.js        [39m[1m[2m  0.52 kB[22m[1m[22m[2m │ gzip:   0.36 kB[22m
[2mdist/public/[22m[2massets/[22m[36muse-stock-data-CSr3Geq9.js      [39m[1m[2m  0.59 kB[22m[1m[22m[2m │ gzip:   0.34 kB[22m
[2mdist/public/[22m[2massets/[22m[36mnot-found-D95eh0tQ.js           [39m[1m[2m  0.63 kB[22m[1m[22m[2m │ gzip:   0.42 kB[22m
[2mdist/public/[22m[2massets/[22m[36mportfolio-fx-CPgDuqdX.js        [39m[1m[2m  0.67 kB[22m[1m[22m[2m │ gzip:   0.46 kB[22m
[2mdist/public/[22m[2massets/[22m[36mcalculator-D7mXi_EY.js          [39m[1m[2m  0.70 kB[22m[1m[22m[2m │ gzip:   0.39 kB[22m
[2mdist/public/[22m[2massets/[22m[36mportfolio-cash-DoVkQl1v.js      [39m[1m[2m  1.00 kB[22m[1m[22m[2m │ gzip:   0.56 kB[22m
[2mdist/public/[22m[2massets/[22m[36masset-switch-ClA0jB7s.js        [39m[1m[2m  1.33 kB[22m[1m[22m[2m │ gzip:   0.60 kB[22m
[2mdist/public/[22m[2massets/[22m[36mportfolio-calc-Ow6AIlPB.js      [39m[1m[2m  1.38 kB[22m[1m[22m[2m │ gzip:   0.53 kB[22m
[2mdist/public/[22m[2massets/[22m[36mapp-modal-DkEuKI_r.js           [39m[1m[2m  1.45 kB[22m[1m[22m[2m │ gzip:   0.75 kB[22m
[2mdist/public/[22m[2massets/[22m[36mkey-round-C2-tOaHb.js           [39m[1m[2m  1.45 kB[22m[1m[22m[2m │ gzip:   0.57 kB[22m
[2mdist/public/[22m[2massets/[22m[36mportfolio-holdings-B-24-BGy.js  [39m[1m[2m  1.65 kB[22m[1m[22m[2m │ gzip:   0.84 kB[22m
[2mdist/public/[22m[2massets/[22m[36mnotifications-DouNyxvR.js       [39m[1m[2m  2.13 kB[22m[1m[22m[2m │ gzip:   1.02 kB[22m
[2mdist/public/[22m[2massets/[22m[36mtech-BxKRy4GC.js                [39m[1m[2m  2.68 kB[22m[1m[22m[2m │ gzip:   1.37 kB[22m
[2mdist/public/[22m[2massets/[22m[36mwatchlist-assets-i_SHRcuq.js    [39m[1m[2m  5.05 kB[22m[1m[22m[2m │ gzip:   2.04 kB[22m
[2mdist/public/[22m[2massets/[22m[36mmarket-analysis-CqW0G3Mh.js     [39m[1m[2m  5.81 kB[22m[1m[22m[2m │ gzip:   2.12 kB[22m
[2mdist/public/[22m[2massets/[22m[36mauto-trade-HGdX4NTW.js          [39m[1m[2m  6.25 kB[22m[1m[22m[2m │ gzip:   2.01 kB[22m
[2mdist/public/[22m[2massets/[22m[36masset-evaluation-D4NaHGf8.js    [39m[1m[2m  7.33 kB[22m[1m[22m[2m │ gzip:   2.92 kB[22m
[2mdist/public/[22m[2massets/[22m[36minstall-5jk2r1zc.js             [39m[1m[2m  8.25 kB[22m[1m[22m[2m │ gzip:   3.06 kB[22m
[2mdist/public/[22m[2massets/[22m[36mranking-DzN_YruV.js             [39m[1m[2m  8.36 kB[22m[1m[22m[2m │ gzip:   3.25 kB[22m
[2mdist/public/[22m[2massets/[22m[36mrecommendations-D25xXejX.js     [39m[1m[2m  8.59 kB[22m[1m[22m[2m │ gzip:   3.26 kB[22m
[2mdist/public/[22m[2massets/[22m[36mportfolio-cash-Ce71jy22.js      [39m[1m[2m  9.62 kB[22m[1m[22m[2m │ gzip:   3.58 kB[22m
[2mdist/public/[22m[2massets/[22m[36mfavorite-button-wsacISxu.js     [39m[1m[2m  9.95 kB[22m[1m[22m[2m │ gzip:   4.08 kB[22m
[2mdist/public/[22m[2massets/[22m[36mportfolio-plan-D54IpznD.js      [39m[1m[2m 11.71 kB[22m[1m[22m[2m │ gzip:   4.00 kB[22m
[2mdist/public/[22m[2massets/[22m[36msignal-scan-YhPvWOpW.js         [39m[1m[2m 12.97 kB[22m[1m[22m[2m │ gzip:   4.53 kB[22m
[2mdist/public/[22m[2massets/[22m[36mportfolio-simulate-mNTb-2Rw.js  [39m[1m[2m 14.82 kB[22m[1m[22m[2m │ gzip:   4.99 kB[22m
[2mdist/public/[22m[2massets/[22m[36maccount-DVG3zLoj.js             [39m[1m[2m 16.90 kB[22m[1m[22m[2m │ gzip:   4.57 kB[22m
[2mdist/public/[22m[2massets/[22m[36mwatchlist-B6BGlEwY.js           [39m[1m[2m 21.40 kB[22m[1m[22m[2m │ gzip:   6.29 kB[22m
[2mdist/public/[22m[2massets/[22m[36madmin-BT15zJRm.js               [39m[1m[2m 22.81 kB[22m[1m[22m[2m │ gzip:   5.84 kB[22m
[2mdist/public/[22m[2massets/[22m[36malerts-CmxfODND.js              [39m[1m[2m 24.33 kB[22m[1m[22m[2m │ gzip:   6.96 kB[22m
[2mdist/public/[22m[2massets/[22m[36mlearn-Ds4JvJ2N.js               [39m[1m[2m 27.18 kB[22m[1m[22m[2m │ gzip:   9.25 kB[22m
[2mdist/public/[22m[2massets/[22m[36mstock-info-Bs9PY5CY.js          [39m[1m[2m 28.22 kB[22m[1m[22m[2m │ gzip:   8.53 kB[22m
[2mdist/public/[22m[2massets/[22m[36mstocks-CQqxHpkn.js              [39m[1m[2m 29.58 kB[22m[1m[22m[2m │ gzip:   8.97 kB[22m
[2mdist/public/[22m[2massets/[22m[36mmore-CreKy9Qa.js                [39m[1m[2m 42.81 kB[22m[1m[22m[2m │ gzip:  10.74 kB[22m
[2mdist/public/[22m[2massets/[22m[36mportfolio-Dt1-sygo.js           [39m[1m[2m 46.73 kB[22m[1m[22m[2m │ gzip:  13.19 kB[22m
[2mdist/public/[22m[2massets/[22m[36mchart-broadcast-UmrTiGj9.js     [39m[1m[2m 74.81 kB[22m[1m[22m[2m │ gzip:  21.91 kB[22m
[2mdist/public/[22m[2massets/[22m[36mchart-relay-DZVMX4Lh.js         [39m[1m[2m117.89 kB[22m[1m[22m[2m │ gzip:  32.90 kB[22m
[2mdist/public/[22m[2massets/[22m[36mscanner-BS8_vb5-.js             [39m[1m[2m173.16 kB[22m[1m[22m[2m │ gzip:  45.35 kB[22m
[2mdist/public/[22m[2massets/[22m[36mindex-W_G51z4Y.js               [39m[1m[33m767.69 kB[39m[22m[2m │ gzip: 240.94 kB[22m
[33m
(!) Some chunks are larger than 500 kB after minification. Consider:
- Using dynamic import() to code-split the application
- Use build.rollupOptions.output.manualChunks to improve chunking: https://rollupjs.org/configuration-options/#output-manualchunks
- Adjust chunk size limit for this warning via build.chunkSizeWarningLimit.[39m
[32m✓ built in 4.27s[39m
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
## Collector policy and public API smoke test
- exit_code: 1
```text
undefined
[ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL] Command "esbuild" not found
```
## Stage-five backtest
- exit_code: 1
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
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 16.7/16.7 MB 22.4 MB/s  0:00:00
Downloading pandas-3.0.5-cp312-cp312-manylinux_2_24_x86_64.manylinux_2_28_x86_64.whl (11.0 MB)
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 11.0/11.0 MB 67.9 MB/s  0:00:00
Downloading requests-2.34.2-py3-none-any.whl (73 kB)
Downloading charset_normalizer-3.4.9-cp312-cp312-manylinux2014_x86_64.manylinux_2_17_x86_64.manylinux_2_28_x86_64.whl (224 kB)
Downloading idna-3.18-py3-none-any.whl (65 kB)
Downloading urllib3-2.7.0-py3-none-any.whl (131 kB)
Downloading certifi-2026.7.22-py3-none-any.whl (136 kB)
Downloading python_dateutil-2.9.0.post0-py2.py3-none-any.whl (229 kB)
Downloading six-1.17.0-py2.py3-none-any.whl (11 kB)
Installing collected packages: urllib3, six, numpy, idna, charset_normalizer, certifi, requests, python-dateutil, pandas

Successfully installed certifi-2026.7.22 charset_normalizer-3.4.9 idna-3.18 numpy-2.5.1 pandas-3.0.5 python-dateutil-2.9.0.post0 requests-2.34.2 six-1.17.0 urllib3-2.7.0
Traceback (most recent call last):
  File "/home/runner/work/seungjae20260713/seungjae20260713/tools/backtest/long_pullback_retest_backtest.py", line 346, in <module>
    main()
  File "/home/runner/work/seungjae20260713/seungjae20260713/tools/backtest/long_pullback_retest_backtest.py", line 317, in main
    funding = stage4.fetch_funding(session, symbol, start_ms, end_ms)
              ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "/tmp/funding_veto_long_short_backtest.py", line 166, in fetch_funding
    raise RuntimeError(f"{symbol}: no funding history in requested window")
RuntimeError: BTCUSDT: no funding history in requested window
```

## Step outcomes
- pnpm: success
- install: success
- frontend: success
- backend: failure
- smoke: failure
- backtest: failure
- finished_at: 2026-07-26T10:47:57Z
