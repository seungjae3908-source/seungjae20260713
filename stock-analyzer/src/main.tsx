// Keep the HTML entry intentionally dependency-free. On a direct AI Chart
// document, settle the user-critical page module before adding the wider App and
// runtime graphs. The chart renderer remains behind the page's React.lazy
// boundary so its loading state can paint before that heavier graph is usable.
const directAiChartRoute = window.location.pathname.endsWith('/ai-chart');
const aiChartCriticalPreload = directAiChartRoute
	? import('@/pages/ai-chart').then(() => undefined, () => undefined)
	: Promise.resolve();

void aiChartCriticalPreload.then(async () => {
	const [{ default: App }, { mountApp }] = await Promise.all([
		import('./App'),
		import('./app-runtime'),
	]);
	mountApp(App);
});
