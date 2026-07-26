# Stage 6 forward shadow verification

- commit: 416e2bb715d0b8a62fba1f8f99a2a8cb0ec3fe57
- started_at: 2026-07-26T12:36:45Z

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
Progress: resolved 650, reused 0, downloaded 13, added 0
Progress: resolved 650, reused 0, downloaded 201, added 12
Progress: resolved 650, reused 0, downloaded 330, added 21
✓ Lockfile passes supply-chain policies (746 entries in 4.5s)
Progress: resolved 650, reused 0, downloaded 496, added 33
Progress: resolved 650, reused 0, downloaded 650, added 650, done
.../esbuild@0.27.3/node_modules/esbuild postinstall$ node install.js
.../esbuild@0.25.12/node_modules/esbuild postinstall$ node install.js
.../esbuild@0.27.3/node_modules/esbuild postinstall: Done
.../esbuild@0.25.12/node_modules/esbuild postinstall: Done

devDependencies:
+ typescript 5.9.3

Done in 7.5s using pnpm v11.17.0
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
[2mdist/public/[22m[2massets/[22m[35mindex-DKqEwLrg.css              [39m[1m[2m 81.57 kB[22m[1m[22m[2m │ gzip:  13.50 kB[22m
[2mdist/public/[22m[2massets/[22m[36mchevron-up-DnnhhXwc.js          [39m[1m[2m  0.30 kB[22m[1m[22m[2m │ gzip:   0.25 kB[22m
[2mdist/public/[22m[2massets/[22m[36mchevron-right-f7Cs72Y3.js       [39m[1m[2m  0.30 kB[22m[1m[22m[2m │ gzip:   0.25 kB[22m
[2mdist/public/[22m[2massets/[22m[36mplus-DC1G5QPy.js                [39m[1m[2m  0.32 kB[22m[1m[22m[2m │ gzip:   0.25 kB[22m
[2mdist/public/[22m[2massets/[22m[36mcircle-check-LYDCVg5i.js        [39m[1m[2m  0.34 kB[22m[1m[22m[2m │ gzip:   0.27 kB[22m
[2mdist/public/[22m[2massets/[22m[36mchart-line-Bol_Ehfm.js          [39m[1m[2m  0.35 kB[22m[1m[22m[2m │ gzip:   0.28 kB[22m
[2mdist/public/[22m[2massets/[22m[36msmartphone-OEx0Xhow.js          [39m[1m[2m  0.37 kB[22m[1m[22m[2m │ gzip:   0.29 kB[22m
[2mdist/public/[22m[2massets/[22m[36mlog-in-DlslS5XA.js              [39m[1m[2m  0.43 kB[22m[1m[22m[2m │ gzip:   0.32 kB[22m
[2mdist/public/[22m[2massets/[22m[36mdownload-CF1IKaGj.js            [39m[1m[2m  0.43 kB[22m[1m[22m[2m │ gzip:   0.32 kB[22m
[2mdist/public/[22m[2massets/[22m[36mtriangle-alert-kprCdeLB.js      [39m[1m[2m  0.43 kB[22m[1m[22m[2m │ gzip:   0.31 kB[22m
[2mdist/public/[22m[2massets/[22m[36mshield-check-FTRxeU-F.js        [39m[1m[2m  0.49 kB[22m[1m[22m[2m │ gzip:   0.35 kB[22m
[2mdist/public/[22m[2massets/[22m[36mrefresh-cw-BFvOoRyG.js          [39m[1m[2m  0.49 kB[22m[1m[22m[2m │ gzip:   0.33 kB[22m
[2mdist/public/[22m[2massets/[22m[36mwallet-cards-CM7_03Re.js        [39m[1m[2m  0.50 kB[22m[1m[22m[2m │ gzip:   0.35 kB[22m
[2mdist/public/[22m[2massets/[22m[36mbot-D3WSrGzL.js                 [39m[1m[2m  0.50 kB[22m[1m[22m[2m │ gzip:   0.33 kB[22m
[2mdist/public/[22m[2massets/[22m[36mshield-alert-a7d19y47.js        [39m[1m[2m  0.52 kB[22m[1m[22m[2m │ gzip:   0.36 kB[22m
[2mdist/public/[22m[2massets/[22m[36muse-stock-data-DsFJHL47.js      [39m[1m[2m  0.59 kB[22m[1m[22m[2m │ gzip:   0.34 kB[22m
[2mdist/public/[22m[2massets/[22m[36mnot-found-DwT783mv.js           [39m[1m[2m  0.63 kB[22m[1m[22m[2m │ gzip:   0.42 kB[22m
[2mdist/public/[22m[2massets/[22m[36mportfolio-fx-D3eTGpG-.js        [39m[1m[2m  0.67 kB[22m[1m[22m[2m │ gzip:   0.46 kB[22m
[2mdist/public/[22m[2massets/[22m[36mcalculator-tk38Vcv-.js          [39m[1m[2m  0.70 kB[22m[1m[22m[2m │ gzip:   0.39 kB[22m
[2mdist/public/[22m[2massets/[22m[36mportfolio-cash-6Orjjnp1.js      [39m[1m[2m  1.00 kB[22m[1m[22m[2m │ gzip:   0.55 kB[22m
[2mdist/public/[22m[2massets/[22m[36masset-switch-CZDDQakC.js        [39m[1m[2m  1.33 kB[22m[1m[22m[2m │ gzip:   0.60 kB[22m
[2mdist/public/[22m[2massets/[22m[36mportfolio-calc-Ow6AIlPB.js      [39m[1m[2m  1.38 kB[22m[1m[22m[2m │ gzip:   0.53 kB[22m
[2mdist/public/[22m[2massets/[22m[36mapp-modal-DG-wm4IK.js           [39m[1m[2m  1.45 kB[22m[1m[22m[2m │ gzip:   0.75 kB[22m
[2mdist/public/[22m[2massets/[22m[36mkey-round-BuRKg1MX.js           [39m[1m[2m  1.45 kB[22m[1m[22m[2m │ gzip:   0.57 kB[22m
[2mdist/public/[22m[2massets/[22m[36mportfolio-holdings-OQT5pJtq.js  [39m[1m[2m  1.65 kB[22m[1m[22m[2m │ gzip:   0.83 kB[22m
[2mdist/public/[22m[2massets/[22m[36mnotifications-DouNyxvR.js       [39m[1m[2m  2.13 kB[22m[1m[22m[2m │ gzip:   1.02 kB[22m
[2mdist/public/[22m[2massets/[22m[36mtech-DBYP2I6b.js                [39m[1m[2m  2.68 kB[22m[1m[22m[2m │ gzip:   1.36 kB[22m
[2mdist/public/[22m[2massets/[22m[36mwatchlist-assets-BpCzQRXr.js    [39m[1m[2m  5.05 kB[22m[1m[22m[2m │ gzip:   2.04 kB[22m
[2mdist/public/[22m[2massets/[22m[36mmarket-analysis-B4LsGf-L.js     [39m[1m[2m  5.68 kB[22m[1m[22m[2m │ gzip:   2.08 kB[22m
[2mdist/public/[22m[2massets/[22m[36mauto-trade-BPWBCB5s.js          [39m[1m[2m  6.42 kB[22m[1m[22m[2m │ gzip:   2.08 kB[22m
[2mdist/public/[22m[2massets/[22m[36masset-evaluation-CLvtX9mh.js    [39m[1m[2m  7.33 kB[22m[1m[22m[2m │ gzip:   2.92 kB[22m
[2mdist/public/[22m[2massets/[22m[36minstall-DDEbrR9O.js             [39m[1m[2m  8.25 kB[22m[1m[22m[2m │ gzip:   3.06 kB[22m
[2mdist/public/[22m[2massets/[22m[36mranking-Fl_NbeAY.js             [39m[1m[2m  8.36 kB[22m[1m[22m[2m │ gzip:   3.24 kB[22m
[2mdist/public/[22m[2massets/[22m[36mrecommendations-B41Scohj.js     [39m[1m[2m  8.59 kB[22m[1m[22m[2m │ gzip:   3.25 kB[22m
[2mdist/public/[22m[2massets/[22m[36mportfolio-cash-K0KhOG1T.js      [39m[1m[2m  9.85 kB[22m[1m[22m[2m │ gzip:   3.69 kB[22m
[2mdist/public/[22m[2massets/[22m[36mfavorite-button-MXF1WFz1.js     [39m[1m[2m  9.95 kB[22m[1m[22m[2m │ gzip:   4.08 kB[22m
[2mdist/public/[22m[2massets/[22m[36mportfolio-plan-iJNJaq5s.js      [39m[1m[2m 11.94 kB[22m[1m[22m[2m │ gzip:   4.11 kB[22m
[2mdist/public/[22m[2massets/[22m[36msignal-scan-b6JlTPWk.js         [39m[1m[2m 12.97 kB[22m[1m[22m[2m │ gzip:   4.53 kB[22m
[2mdist/public/[22m[2massets/[22m[36mportfolio-simulate-CnoU4DyW.js  [39m[1m[2m 15.06 kB[22m[1m[22m[2m │ gzip:   5.11 kB[22m
[2mdist/public/[22m[2massets/[22m[36maccount-C8GQaoAA.js             [39m[1m[2m 16.90 kB[22m[1m[22m[2m │ gzip:   4.57 kB[22m
[2mdist/public/[22m[2massets/[22m[36mwatchlist-DN_inb-b.js           [39m[1m[2m 21.40 kB[22m[1m[22m[2m │ gzip:   6.29 kB[22m
[2mdist/public/[22m[2massets/[22m[36madmin-10Q2EGKM.js               [39m[1m[2m 22.81 kB[22m[1m[22m[2m │ gzip:   5.83 kB[22m
[2mdist/public/[22m[2massets/[22m[36malerts-Bl25k5ht.js              [39m[1m[2m 24.33 kB[22m[1m[22m[2m │ gzip:   6.96 kB[22m
[2mdist/public/[22m[2massets/[22m[36mlearn-q7Jof924.js               [39m[1m[2m 27.18 kB[22m[1m[22m[2m │ gzip:   9.25 kB[22m
[2mdist/public/[22m[2massets/[22m[36mstock-info-Cb2b7Xo1.js          [39m[1m[2m 28.56 kB[22m[1m[22m[2m │ gzip:   8.66 kB[22m
[2mdist/public/[22m[2massets/[22m[36mstocks-CM5c_KLr.js              [39m[1m[2m 29.49 kB[22m[1m[22m[2m │ gzip:   8.94 kB[22m
[2mdist/public/[22m[2massets/[22m[36mmore-xkXxkJQg.js                [39m[1m[2m 42.81 kB[22m[1m[22m[2m │ gzip:  10.74 kB[22m
[2mdist/public/[22m[2massets/[22m[36mportfolio-CcgguMMy.js           [39m[1m[2m 47.44 kB[22m[1m[22m[2m │ gzip:  13.18 kB[22m
[2mdist/public/[22m[2massets/[22m[36mchart-broadcast-DHNHP9h8.js     [39m[1m[2m 74.81 kB[22m[1m[22m[2m │ gzip:  21.91 kB[22m
[2mdist/public/[22m[2massets/[22m[36mchart-relay-CtvqxFre.js         [39m[1m[2m117.89 kB[22m[1m[22m[2m │ gzip:  32.90 kB[22m
[2mdist/public/[22m[2massets/[22m[36mscanner-CezX5d31.js             [39m[1m[2m173.16 kB[22m[1m[22m[2m │ gzip:  45.35 kB[22m
[2mdist/public/[22m[2massets/[22m[36mindex-RzjaogWb.js               [39m[1m[33m767.89 kB[39m[22m[2m │ gzip: 241.03 kB[22m
[33m
(!) Some chunks are larger than 500 kB after minification. Consider:
- Using dynamic import() to code-split the application
- Use build.rollupOptions.output.manualChunks to improve chunking: https://rollupjs.org/configuration-options/#output-manualchunks
- Adjust chunk size limit for this warning via build.chunkSizeWarningLimit.[39m
[32m✓ built in 4.97s[39m
```
## Full backend typecheck
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
## Stage-six targeted typecheck
- exit_code: 0
```text
```
## API server bundle
- exit_code: 0
```text
$ node ./build.mjs
▲ [WARNING] Import "getFinancials" will always be undefined because there is no matching export in "src/providers/sec-edgar.ts" [import-is-undefined]

    src/services/financial.service.ts:106:8:
      106 │     sec.getFinancials(entry.ticker),
          ╵         ~~~~~~~~~~~~~

1 warning

  dist/index.mjs      823.6kb
  dist/index.mjs.map    1.6mb

⚡ Done in 62ms
[api-server] built dist/index.mjs
```
## Pure strategy smoke test
- exit_code: 1
```text

  ../../../../../../tmp/stage6-forward.mjs  1.1mb ⚠️

⚡ Done in 40ms
file:///tmp/stage6-forward.mjs:11
  throw Error('Dynamic require of "' + x + '" is not supported');
        ^

Error: Dynamic require of "fs" is not supported
    at file:///tmp/stage6-forward.mjs:11:9
    at ../node_modules/.pnpm/adm-zip@0.5.18/node_modules/adm-zip/util/utils.js (file:///tmp/stage6-forward.mjs:13714:19)
    at __require2 (file:///tmp/stage6-forward.mjs:17:50)
    at ../node_modules/.pnpm/adm-zip@0.5.18/node_modules/adm-zip/util/index.js (file:///tmp/stage6-forward.mjs:14062:22)
    at __require2 (file:///tmp/stage6-forward.mjs:17:50)
    at ../node_modules/.pnpm/adm-zip@0.5.18/node_modules/adm-zip/adm-zip.js (file:///tmp/stage6-forward.mjs:15345:17)
    at __require2 (file:///tmp/stage6-forward.mjs:17:50)
    at file:///tmp/stage6-forward.mjs:26276:30
    at ModuleJob.run (node:internal/modules/esm/module_job:343:25)
    at process.processTicksAndRejections (node:internal/process/task_queues:103:5)

Node.js v22.23.1
```
## Public data and shadow evaluation smoke test
- exit_code: 1
```text

  ../../../../../../tmp/stage6-context.mjs  17.5kb

⚡ Done in 3ms

  ../../../../../../tmp/stage6-forward-public.mjs  1.1mb ⚠️

⚡ Done in 48ms
file:///tmp/stage6-forward-public.mjs:11
  throw Error('Dynamic require of "' + x + '" is not supported');
        ^

Error: Dynamic require of "fs" is not supported
    at file:///tmp/stage6-forward-public.mjs:11:9
    at ../node_modules/.pnpm/adm-zip@0.5.18/node_modules/adm-zip/util/utils.js (file:///tmp/stage6-forward-public.mjs:13714:19)
    at __require2 (file:///tmp/stage6-forward-public.mjs:17:50)
    at ../node_modules/.pnpm/adm-zip@0.5.18/node_modules/adm-zip/util/index.js (file:///tmp/stage6-forward-public.mjs:14062:22)
    at __require2 (file:///tmp/stage6-forward-public.mjs:17:50)
    at ../node_modules/.pnpm/adm-zip@0.5.18/node_modules/adm-zip/adm-zip.js (file:///tmp/stage6-forward-public.mjs:15345:17)
    at __require2 (file:///tmp/stage6-forward-public.mjs:17:50)
    at file:///tmp/stage6-forward-public.mjs:26276:30
    at ModuleJob.run (node:internal/modules/esm/module_job:343:25)
    at process.processTicksAndRejections (node:internal/process/task_queues:103:5)

Node.js v22.23.1
```

## Outcomes
- install: success
- frontend: success
- full_typecheck: failure
- targeted: success
- server_build: success
- strategy: failure
- public_smoke: failure
- finished_at: 2026-07-26T12:37:14Z
