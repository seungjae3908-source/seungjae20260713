export const APP_UPDATE_AVAILABLE_EVENT = 'stock-app:update-available';

let updateAvailable = false;

export function isAppUpdateAvailable() {
  return updateAvailable;
}

export function announceAppUpdateAvailable() {
  updateAvailable = true;
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(APP_UPDATE_AVAILABLE_EVENT));
}
