import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

const rawPort = process.env.PORT;
const port = rawPort ? Number(rawPort) : 5173;

if (rawPort && (Number.isNaN(port) || port <= 0)) {
	throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH ?? "/";

export default defineConfig({
	base: basePath,

	plugins: [
		react(),
		tailwindcss(),
		runtimeErrorOverlay(),

		VitePWA({
			registerType: "autoUpdate",
			disable: process.env.NODE_ENV !== "production",

			includeAssets: [
				"favicon.svg",
				"robots.txt",
				"icons/apple-touch-icon.png",
			],

			manifest: {
				name: "AI 주식 분석",
				short_name: "AI주식",
				description:
					"실시간 AI 주식 분석 · 호재/악재 알림 · 저평가주 발굴",
				lang: "ko",
				theme_color: "#0b1220",
				background_color: "#0b1220",
				display: "standalone",
				orientation: "portrait",
				start_url: ".",
				scope: ".",

				icons: [
					{
						src: "icons/icon-192.png",
						sizes: "192x192",
						type: "image/png",
					},
					{
						src: "icons/icon-512.png",
						sizes: "512x512",
						type: "image/png",
					},
					{
						src: "icons/maskable-512.png",
						sizes: "512x512",
						type: "image/png",
						purpose: "maskable",
					},
				],
			},

			workbox: {
				globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
				navigateFallbackDenylist: [/^\/api/],

				runtimeCaching: [
					{
						urlPattern: ({ url }) =>
							url.pathname.includes("/api/"),

						handler: "NetworkFirst",

						options: {
							cacheName: "api-cache",
							networkTimeoutSeconds: 8,

							expiration: {
								maxEntries: 200,
								maxAgeSeconds: 60 * 60 * 24,
							},

							cacheableResponse: {
								statuses: [0, 200],
							},
						},
					},
					{
						urlPattern: ({ request }) =>
							request.destination === "font",

						handler: "CacheFirst",

						options: {
							cacheName: "font-cache",

							expiration: {
								maxEntries: 20,
								maxAgeSeconds: 60 * 60 * 24 * 30,
							},
						},
					},
				],
			},
		}),
	],

	resolve: {
		alias: {
			"@": path.resolve(import.meta.dirname, "src"),

			"@assets": path.resolve(
				import.meta.dirname,
				"..",
				"attached_assets",
			),
		},

		dedupe: ["react", "react-dom"],
	},

	root: path.resolve(import.meta.dirname),

	build: {
		outDir: path.resolve(
			import.meta.dirname,
			"dist/public",
		),

		emptyOutDir: true,
	},

	server: {
		port,
		strictPort: true,
		host: "0.0.0.0",
		allowedHosts: true,

		fs: {
			strict: true,
		},
	},

	preview: {
		port,
		host: "0.0.0.0",
		allowedHosts: true,
	},
});