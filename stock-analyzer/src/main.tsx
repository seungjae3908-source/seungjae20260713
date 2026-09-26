// Keep the HTML entry intentionally dependency-free. On a direct AI Chart
// document, give the route chunk first request priority before starting the much
// larger application graph. The app/runtime imports still begin in the same task,
// but the user-critical chart request enters the browser queue first.
if (window.location.pathname.endsWith('/ai-chart')) {
	void import('@/pages/ai-chart').catch(() => undefined);
}
const appModulePromise = import('./App');
const runtimeModulePromise = import('./app-runtime');

void Promise.all([appModulePromise, runtimeModulePromise]).then(([{ default: App }, { mountApp }]) => {
	mountApp(App);
});
