// Keep the HTML entry intentionally dependency-free. A direct AI Chart document
// has a stricter cold-start path: finish fetching/evaluating the small route
// module and the chart renderer before starting the much larger application
// graph. This avoids browser request-queue contention while preserving the
// normal App/runtime parallel load on every other route.
const directAiChartRoute = window.location.pathname.endsWith('/ai-chart');
const aiChartCriticalPreload = directAiChartRoute
	? Promise.all([
			import('@/pages/ai-chart'),
			import('@/components/unified-analysis-chart'),
		]).then(() => undefined, () => undefined)
	: Promise.resolve();

void aiChartCriticalPreload.then(async () => {
	const [{ default: App }, { mountApp }] = await Promise.all([
		import('./App'),
		import('./app-runtime'),
	]);
	mountApp(App);
});
