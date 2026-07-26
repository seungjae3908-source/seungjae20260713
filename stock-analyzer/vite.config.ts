import path from 'path';
import { createRequire } from 'node:module';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';
import { membershipUiRoutingPatch } from './membership-ui-routing-patch';
import { chartRelayFeaturePatch } from './chart-relay-feature-patch';
import { chartRelayAutoOrderPatch } from './chart-relay-auto-order-patch';
import { chartRelaySpotAutoSupportPatch } from './chart-relay-spot-auto-support-patch';
import { chartRelayFocusedMarketPatch } from './chart-relay-focused-market-patch';
import { chartRelaySignalArrowPatch } from './chart-relay-signal-arrow-patch';
import { chartRelayMobileUiCleanupPatch } from './chart-relay-mobile-ui-cleanup-patch';
import { chartRelayInboxLayoutPatch } from './chart-relay-inbox-layout-patch';
import { chartRelayMobileControlRowPatch } from './chart-relay-mobile-control-row-patch';
import { signalScanPlanPatch } from './signal-scan-plan-patch';
import { focusedPageLayoutPatch } from './focused-page-layout-patch';
import { tradingHomeGlobalUiPatch } from './trading-home-global-ui-patch';
import { settingsPopupSectionsPatch } from './settings-popup-sections-patch';
import { settingsUniformExtraPatch } from './settings-uniform-extra-patch';
import { requestedUiFixesPatch } from './requested-ui-fixes-patch';
import { stockInfoFeedOnlyPatch } from './stock-info-feed-only-patch';
import { stocksCategoryLayoutPatch } from './stocks-category-layout-patch';
import { sixRequestedFixesPatch } from './six-requested-fixes-patch';
import { currentRequestBatchPatch } from './current-request-batch-patch';
import { feedFiveMorePatch } from './feed-five-more-patch';
import { portfolioManwonInputPatch } from './portfolio-manwon-input-patch';
import { newPagesTypeSafetyPatch } from './new-pages-type-safety-patch';
import { krwTenThousandUnitPatch } from './krw-ten-thousand-unit-patch';
import { detailContentStatusPatch } from './detail-content-status-patch';
import { detailSectionPopupPatch } from './detail-section-popup-patch';
import { globalDetailsPopupPatch } from './global-details-popup-patch';

const require = createRequire(import.meta.url);
const lightweightChartsEntry = require.resolve('lightweight-charts');

const rawPort = process.env.PORT;
const port = rawPort ? Number(rawPort) : 5173;

if (rawPort && (Number.isNaN(port) || port <= 0)) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base: basePath,

  plugins: [
    membershipUiRoutingPatch(),
    chartRelayFeaturePatch(),
    chartRelayAutoOrderPatch(),
    chartRelaySpotAutoSupportPatch(),
    chartRelayFocusedMarketPatch(),
    chartRelaySignalArrowPatch(),
    chartRelayMobileUiCleanupPatch(),
    chartRelayInboxLayoutPatch(),
    chartRelayMobileControlRowPatch(),
    signalScanPlanPatch(),
    focusedPageLayoutPatch(),
    tradingHomeGlobalUiPatch(),
    settingsPopupSectionsPatch(),
    settingsUniformExtraPatch(),
    requestedUiFixesPatch(),
    stockInfoFeedOnlyPatch(),
    stocksCategoryLayoutPatch(),
    sixRequestedFixesPatch(),
    currentRequestBatchPatch(),
    feedFiveMorePatch(),
    portfolioManwonInputPatch(),
    newPagesTypeSafetyPatch(),
    krwTenThousandUnitPatch(),
    detailContentStatusPatch(),
    detailSectionPopupPatch(),
    globalDetailsPopupPatch(),
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),

    ...(process.env.NODE_ENV !== 'production' &&
    process.env.REPL_ID !== undefined &&
    process.env.ENABLE_REPLIT_EDITOR_PLUGINS === 'true'
      ? [
          await import('@replit/vite-plugin-cartographer').then((module) =>
            module.cartographer({
              root: path.resolve(import.meta.dirname, '..'),
            }),
          ),

          await import('@replit/vite-plugin-dev-banner').then((module) =>
            module.devBanner(),
          ),
        ]
      : []),
  ],

  resolve: {
    alias: [
      {
        find: /^lightweight-charts-original$/,
        replacement: lightweightChartsEntry,
      },
      {
        find: /^lightweight-charts$/,
        replacement: path.resolve(
          import.meta.dirname,
          'src/lib/lightweight-charts-relay-patch.ts',
        ),
      },
      {
        find: '@',
        replacement: path.resolve(import.meta.dirname, 'src'),
      },
      {
        find: '@assets',
        replacement: path.resolve(
          import.meta.dirname,
          '..',
          '..',
          'attached_assets',
        ),
      },
    ],

    dedupe: ['react', 'react-dom'],
  },

  root: path.resolve(import.meta.dirname),

  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
  },

  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,

    proxy: {
      '/api': {
        target:
          process.env.API_SERVER_URL ??
          'http://127.0.0.1:8080',

        changeOrigin: true,
        ws: true,
      },
    },

    fs: {
      strict: true,
    },
  },

  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
  },
});
