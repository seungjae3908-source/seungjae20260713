// Keep the HTML entry intentionally dependency-free. The production entry used
// to include the full React/auth/runtime graph, so a direct AI Chart document
// could not even request its route chunk until that large entry had downloaded
// and executed. Start the app graph first, then the route in the same task. Both
// requests now begin as soon as this tiny bootstrap executes.
const appModulePromise = import('./App');
if (window.location.pathname.endsWith('/ai-chart')) {
	void import('@/pages/ai-chart').catch(() => undefined);
}
const runtimeModulePromise = import('./app-runtime');

void Promise.all([appModulePromise, runtimeModulePromise]).then(([{ default: App }, { mountApp }]) => {
	mountApp(App);
});
