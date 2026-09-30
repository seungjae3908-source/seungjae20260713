// Keep the HTML entry intentionally dependency-free. On a direct AI Chart
// document, begin the user-critical page preload before the wider App and runtime
// graphs, but do not block authenticated bootstrap on that network work. The chart
// renderer remains behind the page's React.lazy boundary so its loading state can
// paint before that heavier graph is usable.
const directAiChartRoute = window.location.pathname.endsWith('/ai-chart');
const aiChartCriticalPreload = directAiChartRoute
	? import('@/pages/ai-chart').then(() => undefined, () => undefined)
	: Promise.resolve();

void aiChartCriticalPreload;

void (async () => {
	const [{ default: App }, { mountApp }] = await Promise.all([
		import('./App'),
		import('./app-runtime'),
	]);
	mountApp(App);
})();
