# Stage 5 API server build report

- started_from: ed3486f5a71ca3465ab368a59ef6e8fb6e4f9910
- exit_code: 0
- finished_at: 2026-07-26T11:07:49Z

```text
! Corepack is about to download https://registry.npmjs.org/pnpm/-/pnpm-11.17.0.tgz
Scope: all 8 workspace projects
? Verifying lockfile against supply-chain policies (746 entries)...
Lockfile is up to date, resolution step is skipped
Progress: resolved 1, reused 0, downloaded 0, added 0
Packages: +650
++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
Progress: resolved 650, reused 0, downloaded 0, added 0
Progress: resolved 650, reused 0, downloaded 15, added 0
Progress: resolved 650, reused 0, downloaded 214, added 12
Progress: resolved 650, reused 0, downloaded 348, added 24
✓ Lockfile passes supply-chain policies (746 entries in 4.6s)
Progress: resolved 650, reused 0, downloaded 650, added 122
Progress: resolved 650, reused 0, downloaded 650, added 650, done
.../esbuild@0.27.3/node_modules/esbuild postinstall$ node install.js
.../esbuild@0.25.12/node_modules/esbuild postinstall$ node install.js
.../esbuild@0.27.3/node_modules/esbuild postinstall: Done
.../esbuild@0.25.12/node_modules/esbuild postinstall: Done

devDependencies:
+ typescript 5.9.3

Done in 7.5s using pnpm v11.17.0
$ node ./build.mjs
▲ [WARNING] Import "getFinancials" will always be undefined because there is no matching export in "src/providers/sec-edgar.ts" [import-is-undefined]

    src/services/financial.service.ts:106:8:
      106 │     sec.getFinancials(entry.ticker),
          ╵         ~~~~~~~~~~~~~

1 warning

  dist/index.mjs      787.0kb
  dist/index.mjs.map    1.5mb

⚡ Done in 54ms
[api-server] built dist/index.mjs
```
