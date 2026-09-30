// Keep the HTML entry intentionally dependency-free. On a direct AI Chart
// document, start the user-critical route preloads first, promote those exact
// modulepreload links, then yield one task before adding the much larger App and
// runtime preload graphs. This gives the cold route a real network scheduling
// head start without delaying any non-AI-Chart document.
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
