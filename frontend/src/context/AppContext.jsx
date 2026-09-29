import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from '../services/api';
import { requestPersistentStorage } from '../offline/database';
import { applyWaitingServiceWorker } from '../offline/pwa';
import { PosDeviceError, readOfflineFoundation, refreshDeviceCatalog } from '../offline/device';
import { setDeviceState } from '../offline/database';
import { readOutboxStatus, recoverOutboxAfterRestart, synchronizeOutbox } from '../offline/orders';

const Context = createContext();
const initialPosStatus = {
  network: typeof navigator === 'undefined' || navigator.onLine,
  server: 'checking',
  catalog: 'missing',
  device: 'unregistered',
  lease: 'missing',
  storage: 'checking',
  updateWaiting: false,
  clockRollback: false,
  deviceError: '',
  offlineSales: false,
};

async function probeServer() {
  if (!navigator.onLine) return false;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch('/api/health', {
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timeout);
  }
}

export function AppProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState(null);
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [offlineCatalog, setOfflineCatalog] = useState(null);
  const [notice, setNotice] = useState(null);
  const [posStatus, setPosStatus] = useState(initialPosStatus);
  const [outboxStatus, setOutboxStatus] = useState({
    orders: [],
    pending: 0,
    syncing: false,
    needsReview: 0,
    rejected: 0,
    lastSuccessfulSync: null,
    syncErrors: [],
  });
  const notify = useCallback(
    (message, type = 'success') => setNotice({ message, type, id: Date.now() }),
    [],
  );

  const refresh = useCallback(async () => {
    try {
      const [nextSettings, nextProducts, nextCategories] = await Promise.all([
        api('/settings'),
        api('/products'),
        api('/categories'),
      ]);
      setSettings(nextSettings);
      setProducts(nextProducts);
      setCategories(nextCategories);
      setPosStatus((status) => ({ ...status, network: navigator.onLine, server: 'reachable' }));
    } catch (error) {
      const reachable = await probeServer();
      setPosStatus((status) => ({
        ...status,
        network: navigator.onLine,
        server: reachable ? 'reachable' : 'unreachable',
      }));
      throw error;
    }
  }, []);

  const ensureLiveServer = useCallback(async () => {
    const reachable = await probeServer();
    setPosStatus((status) => ({
      ...status,
      network: navigator.onLine,
      server: reachable ? 'reachable' : navigator.onLine ? 'unreachable' : 'offline',
    }));
    if (!reachable)
      throw new Error('Checkout requires a live café server. Reconnect and try again.');
    return true;
  }, []);

  const refreshOutboxStatus = useCallback(async () => {
    const next = await readOutboxStatus();
    setOutboxStatus(next);
    return next;
  }, []);

  const syncOutbox = useCallback(
    async (force = false) => {
      const result = await synchronizeOutbox({ force });
      await refreshOutboxStatus();
      return result;
    },
    [refreshOutboxStatus],
  );

  const loadOfflineState = useCallback(async () => {
    try {
      const [foundation, persistence] = await Promise.all([
        readOfflineFoundation(),
        requestPersistentStorage(),
      ]);
      setOfflineCatalog(foundation.payload || null);
      if (foundation.payload) {
        setSettings({
          ...foundation.payload.settings,
          khqr_url: null,
          tax_percentage: foundation.payload.settings.tax_percentage,
        });
        setCategories(foundation.payload.categories);
        setProducts(
          foundation.payload.products.map((product) => ({
            ...product,
            category: product.category || '',
          })),
        );
      }
      setPosStatus((status) => ({
        ...status,
        catalog: foundation.catalog,
        device: foundation.device,
        lease: foundation.lease,
        storage: persistence.available && persistence.granted ? 'available' : 'unavailable',
        clockRollback: foundation.rollbackDetected,
        offlineSales: foundation.offlineSales,
      }));
      await refreshOutboxStatus();
      return foundation;
    } catch {
      setOfflineCatalog(null);
      setPosStatus((status) => ({
        ...status,
        catalog: 'invalid',
        lease: 'invalid',
        storage: 'unavailable',
      }));
      return null;
    }
  }, [refreshOutboxStatus]);

  const refreshDeviceFoundation = useCallback(async () => {
    try {
      const foundation = await refreshDeviceCatalog();
      if (foundation.payload) setOfflineCatalog(foundation.payload);
      setPosStatus((status) => ({
        ...status,
        catalog: foundation.catalog,
        device: foundation.device,
        lease: foundation.lease,
        offlineSales: Boolean(foundation.offlineSales),
        deviceError: '',
        clockRollback: false,
      }));
      return foundation;
    } catch (error) {
      if (error instanceof PosDeviceError && [401, 403].includes(error.status)) {
        await setDeviceState('revoked');
        setPosStatus((status) => ({ ...status, device: 'revoked', deviceError: error.message }));
      } else {
        setPosStatus((status) => ({
          ...status,
          deviceError: error.message,
          catalog: /signature|digest|catalog payload|trusted by/i.test(error.message)
            ? 'invalid'
            : status.catalog,
        }));
        await loadOfflineState();
      }
      return null;
    }
  }, [loadOfflineState]);

  const applyUpdate = useCallback(async () => {
    const applied = await applyWaitingServiceWorker();
    if (!applied) setPosStatus((status) => ({ ...status, updateWaiting: false }));
    return applied;
  }, []);

  useEffect(() => {
    let mounted = true;
    const boot = async () => {
      await Promise.all([
        loadOfflineState(),
        recoverOutboxAfterRestart()
          .then(() => refreshOutboxStatus())
          .catch(() => {}),
      ]);
      const reachable = await probeServer();
      if (!mounted) return;
      setPosStatus((status) => ({
        ...status,
        network: navigator.onLine,
        server: reachable ? 'reachable' : navigator.onLine ? 'unreachable' : 'offline',
      }));
      try {
        const current = await api('/auth/me');
        if (mounted) setUser(current);
      } catch {
        if (mounted) setUser(null);
      } finally {
        if (mounted) setLoading(false);
      }
      if (reachable && mounted) {
        await refreshDeviceFoundation();
        await syncOutbox(true).catch(() => {});
      }
    };
    const onOffline = () => {
      setPosStatus((status) => ({ ...status, network: false, server: 'offline' }));
      void loadOfflineState();
    };
    const onOnline = async () => {
      setPosStatus((status) => ({ ...status, network: true, server: 'checking' }));
      const reachable = await probeServer();
      setPosStatus((status) => ({
        ...status,
        network: navigator.onLine,
        server: reachable ? 'reachable' : 'unreachable',
      }));
      if (reachable) {
        await refreshDeviceFoundation();
        await syncOutbox(true).catch(() => {});
      }
    };
    const onFocus = async () => {
      if (!(await probeServer())) return;
      await refreshDeviceFoundation();
      await syncOutbox(true).catch(() => {});
    };
    const onUpdateWaiting = () => setPosStatus((status) => ({ ...status, updateWaiting: true }));
    const onOutboxUpdate = () => void refreshOutboxStatus().catch(() => {});
    const onSessionExpired = () => {
      setUser(null);
      notify('Your session expired. Please sign in again.', 'error');
    };
    void boot();
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    window.addEventListener('pos-pwa-update-waiting', onUpdateWaiting);
    window.addEventListener('pos-outbox-updated', onOutboxUpdate);
    window.addEventListener('session-expired', onSessionExpired);
    const statusTimer = window.setInterval(async () => {
      const reachable = await probeServer();
      setPosStatus((status) => ({
        ...status,
        network: navigator.onLine,
        server: reachable ? 'reachable' : navigator.onLine ? 'unreachable' : 'offline',
      }));
      if (reachable) {
        await refreshDeviceFoundation();
        await syncOutbox().catch(() => {});
      } else await loadOfflineState();
    }, 30_000);
    window.addEventListener('focus', onFocus);
    return () => {
      mounted = false;
      window.clearInterval(statusTimer);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('pos-pwa-update-waiting', onUpdateWaiting);
      window.removeEventListener('pos-outbox-updated', onOutboxUpdate);
      window.removeEventListener('session-expired', onSessionExpired);
      window.removeEventListener('focus', onFocus);
    };
  }, [loadOfflineState, notify, refreshDeviceFoundation, refreshOutboxStatus, syncOutbox]);

  useEffect(() => {
    if (!user) {
      if (!offlineCatalog) {
        setSettings(null);
        setProducts([]);
        setCategories([]);
      }
      return;
    }
    const update = () => refresh().catch((error) => notify(error.message, 'error'));
    update();
    const timer = setInterval(update, 15000);
    window.addEventListener('focus', update);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', update);
    };
  }, [user, offlineCatalog, refresh, notify]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  return (
    <Context.Provider
      value={{
        user,
        setUser,
        loading,
        settings,
        products,
        categories,
        offlineCatalog,
        posStatus,
        outboxStatus,
        refresh,
        ensureLiveServer,
        refreshDeviceFoundation,
        applyUpdate,
        refreshOutboxStatus,
        syncOutbox,
        notify,
      }}
    >
      {children}
      {notice && (
        <div role="status" className={`toast ${notice.type}`}>
          <span>{notice.message}</span>
          <button aria-label="Dismiss notification" onClick={() => setNotice(null)}>
            ×
          </button>
        </div>
      )}
    </Context.Provider>
  );
}

export const useApp = () => useContext(Context);
