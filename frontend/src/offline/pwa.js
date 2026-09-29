import { countFutureOutboxRecords } from './database';

let registration;
let hadController = false;

export async function registerPosServiceWorker() {
  if (
    import.meta.env.MODE !== 'production' ||
    !('serviceWorker' in navigator) ||
    !globalThis.isSecureContext
  )
    return;
  hadController = Boolean(navigator.serviceWorker.controller);
  try {
    registration = await navigator.serviceWorker.register('/service-worker.js', { scope: '/' });
    const notifyWaiting = () => {
      if (registration?.waiting) window.dispatchEvent(new Event('pos-pwa-update-waiting'));
    };
    registration.addEventListener('updatefound', () => {
      const installing = registration.installing;
      installing?.addEventListener('statechange', () => {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) notifyWaiting();
      });
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) window.location.reload();
      hadController = true;
    });
    notifyWaiting();
    window.setInterval(() => registration?.update().catch(() => {}), 60 * 60 * 1000);
  } catch {
    window.dispatchEvent(new CustomEvent('pos-pwa-registration-error'));
  }
}

export async function applyWaitingServiceWorker() {
  const pending = await countFutureOutboxRecords();
  if (pending > 0)
    throw new Error(
      'An app update is waiting. Preserve and sync local records before applying it.',
    );
  const waiting = registration?.waiting;
  if (!waiting) return false;
  waiting.postMessage({ type: 'ACTIVATE_APPROVED_UPDATE' });
  return true;
}
