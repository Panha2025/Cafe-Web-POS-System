export const POS_DATABASE_NAME = 'cafe-pos';
export const POS_DATABASE_VERSION = 3;

let databasePromise;

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () =>
      reject(transaction.error || new Error('IndexedDB transaction failed.'));
  });
}

export function openPosDatabase(version = POS_DATABASE_VERSION) {
  if (!('indexedDB' in globalThis)) return Promise.reject(new Error('IndexedDB is unavailable.'));
  if (version === POS_DATABASE_VERSION && databasePromise) return databasePromise;
  const opening = new Promise((resolve, reject) => {
    const request = indexedDB.open(POS_DATABASE_NAME, version);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      const tx = request.transaction;
      if (event.oldVersion < 1) {
        db.createObjectStore('meta', { keyPath: 'key' });
        db.createObjectStore('catalogs', { keyPath: 'version' });
        db.createObjectStore('deviceKeys', { keyPath: 'credential_id' });
        db.createObjectStore('leases', { keyPath: 'lease_id' });
        db.createObjectStore('outbox', { keyPath: 'request_id' });
        db.createObjectStore('syncResults', { keyPath: 'request_id' });
      }
      if (event.oldVersion < 2) {
        const outbox = tx.objectStore('outbox');
        if (!outbox.indexNames.contains('state')) outbox.createIndex('state', 'state');
        if (!outbox.indexNames.contains('device_sequence'))
          outbox.createIndex('device_sequence', 'device_sequence');
        if (!outbox.indexNames.contains('created_at'))
          outbox.createIndex('created_at', 'created_at');
        const results = tx.objectStore('syncResults');
        if (!results.indexNames.contains('received_at'))
          results.createIndex('received_at', 'received_at');
      }
      if (event.oldVersion < 3) {
        const outbox = tx.objectStore('outbox');
        if (!outbox.indexNames.contains('next_attempt_at'))
          outbox.createIndex('next_attempt_at', 'next_attempt_at');
      }
    };
    request.onblocked = () =>
      reject(new Error('Close other POS tabs to finish the local database update.'));
    request.onerror = () =>
      reject(request.error || new Error('Could not open the POS local database.'));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        databasePromise = null;
      };
      resolve(db);
    };
  });
  if (version === POS_DATABASE_VERSION) databasePromise = opening;
  return opening;
}

export async function getMeta(key) {
  const db = await openPosDatabase();
  const tx = db.transaction('meta', 'readonly');
  const value = await requestValue(tx.objectStore('meta').get(key));
  return value?.value;
}

export async function putMeta(key, value) {
  const db = await openPosDatabase();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({ key, value });
  await transactionDone(tx);
}

export async function getDeviceIdentity() {
  return (await getMeta('deviceIdentity')) || null;
}

export async function saveDeviceKey({ deviceId, credentialId, keyPair, state = 'pending' }) {
  const db = await openPosDatabase();
  const tx = db.transaction(['deviceKeys', 'meta'], 'readwrite');
  tx.objectStore('deviceKeys').put({
    credential_id: credentialId,
    device_id: deviceId,
    key_pair: keyPair,
    state,
    updated_at: new Date().toISOString(),
  });
  tx.objectStore('meta').put({
    key: 'deviceIdentity',
    value: { device_id: deviceId, credential_id: credentialId, state },
  });
  await transactionDone(tx);
}

export async function savePendingDeviceKey({ deviceId, credentialId, keyPair }) {
  const db = await openPosDatabase();
  const tx = db.transaction('deviceKeys', 'readwrite');
  tx.objectStore('deviceKeys').put({
    credential_id: credentialId,
    device_id: deviceId,
    key_pair: keyPair,
    state: 'pending',
    updated_at: new Date().toISOString(),
  });
  await transactionDone(tx);
}

export async function getDeviceKey(credentialId) {
  const db = await openPosDatabase();
  const tx = db.transaction('deviceKeys', 'readonly');
  return requestValue(tx.objectStore('deviceKeys').get(credentialId));
}

export async function deleteDeviceKey(credentialId) {
  const db = await openPosDatabase();
  const tx = db.transaction('deviceKeys', 'readwrite');
  tx.objectStore('deviceKeys').delete(credentialId);
  await transactionDone(tx);
}

export async function setDeviceState(state) {
  const identity = await getDeviceIdentity();
  if (identity) await putMeta('deviceIdentity', { ...identity, state });
}

export async function saveVerifiedCatalog(envelope, payload) {
  const db = await openPosDatabase();
  const tx = db.transaction(['catalogs', 'meta'], 'readwrite');
  tx.objectStore('catalogs').put({
    version: String(payload.catalog_version),
    envelope,
    payload,
    verified_at: new Date().toISOString(),
  });
  tx.objectStore('meta').put({
    key: 'activeCatalogVersion',
    value: String(payload.catalog_version),
  });
  await transactionDone(tx);
}

export async function getCachedCatalog(version) {
  const active = version === undefined ? await getMeta('activeCatalogVersion') : null;
  const requested = version === undefined ? active : String(version);
  if (!requested) return null;
  const db = await openPosDatabase();
  const tx = db.transaction('catalogs', 'readonly');
  return requestValue(tx.objectStore('catalogs').get(String(requested)));
}

export async function saveVerifiedLease(envelope, payload) {
  const db = await openPosDatabase();
  const tx = db.transaction(['leases', 'meta'], 'readwrite');
  tx.objectStore('leases').put({
    lease_id: payload.lease_id,
    envelope,
    payload,
    verified_at: new Date().toISOString(),
  });
  tx.objectStore('meta').put({ key: 'activeLeaseId', value: payload.lease_id });
  await transactionDone(tx);
}

export async function getCachedLease() {
  const id = await getMeta('activeLeaseId');
  if (!id) return null;
  const db = await openPosDatabase();
  const tx = db.transaction('leases', 'readonly');
  return requestValue(tx.objectStore('leases').get(id));
}

export async function countFutureOutboxRecords() {
  const db = await openPosDatabase();
  const tx = db.transaction('outbox', 'readonly');
  const records = await requestValue(tx.objectStore('outbox').getAll());
  return records.filter((record) => !['synced', 'rejected'].includes(record.state)).length;
}

export async function enqueueOfflineOrder(createOrder) {
  const db = await openPosDatabase();
  const tx = db.transaction(['meta', 'outbox'], 'readwrite');
  const meta = tx.objectStore('meta');
  const request = meta.get('lastDeviceOrderSequence');
  let saved;
  request.onsuccess = () => {
    const sequence = Number(request.result?.value || 0) + 1;
    saved = createOrder(sequence);
    meta.put({ key: 'lastDeviceOrderSequence', value: sequence });
    tx.objectStore('outbox').add(saved);
  };
  await transactionDone(tx);
  return saved;
}

export async function listOutboxOrders() {
  const db = await openPosDatabase();
  const tx = db.transaction('outbox', 'readonly');
  const records = await requestValue(tx.objectStore('outbox').getAll());
  return records.sort((a, b) => a.device_sequence - b.device_sequence);
}

export async function updateOutboxOrder(requestId, patch) {
  const db = await openPosDatabase();
  const tx = db.transaction('outbox', 'readwrite');
  const store = tx.objectStore('outbox');
  const request = store.get(requestId);
  let updated;
  request.onsuccess = () => {
    if (!request.result) return;
    updated = { ...request.result, ...patch, updated_at: new Date().toISOString() };
    store.put(updated);
  };
  await transactionDone(tx);
  return updated || null;
}

export async function saveSyncResult(result) {
  const db = await openPosDatabase();
  const tx = db.transaction(['syncResults', 'meta'], 'readwrite');
  tx.objectStore('syncResults').put({ ...result, received_at: new Date().toISOString() });
  if (result.state === 'synced')
    tx.objectStore('meta').put({ key: 'lastSuccessfulSync', value: new Date().toISOString() });
  await transactionDone(tx);
}

export async function getLastSuccessfulSync() {
  return (await getMeta('lastSuccessfulSync')) || null;
}

export async function requestPersistentStorage() {
  if (!navigator.storage?.persist) return { available: false, granted: false };
  try {
    const granted = await navigator.storage.persist();
    return { available: true, granted };
  } catch {
    return { available: true, granted: false };
  }
}

export async function closePosDatabase() {
  const db = await databasePromise?.catch(() => null);
  db?.close();
  databasePromise = null;
}
