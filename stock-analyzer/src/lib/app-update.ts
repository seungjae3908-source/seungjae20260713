export const APP_UPDATE_AVAILABLE_EVENT = 'stock-app:update-available';

export function announceAppUpdateAvailable() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(APP_UPDATE_AVAILABLE_EVENT));
}
