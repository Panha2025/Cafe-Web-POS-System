import {
  getCachedCatalog,
  getCachedLease,
  getDeviceIdentity,
  getDeviceKey,
  getMeta,
  putMeta,
  deleteDeviceKey,
  saveDeviceKey,
  savePendingDeviceKey,
  saveVerifiedCatalog,
  saveVerifiedLease,
} from './database';
import { cacheCatalogAssets, isLeaseUsable, verifySignedEnvelope } from './catalog';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();
const toBase64 = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer)));
const toHex = (buffer) =>
  [...new Uint8Array(buffer)].map((value) => value.toString(16).padStart(2, '0')).join('');
let currentToken;

export class PosDeviceError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'PosDeviceError';
    this.status = status;
  }
}

async function posRequest(path, { token, ...options } = {}) {
  let response;
  try {
    response = await fetch(`/api/pos${path}`, {
      cache: 'no-store',
      credentials: 'omit',
      ...options,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    });
  } catch {
    throw new PosDeviceError('POS device service is unreachable.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new PosDeviceError(data.error || 'POS device request failed.', response.status);
  return data;
}

async function sign(privateKey, message) {
  return toBase64(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      privateKey,
      encoder.encode(message),
    ),
  );
}

export async function enrollThisDevice(pairingCode) {
  const [deviceId] = String(pairingCode).split('.');
  if (!UUID.test(deviceId)) throw new Error('Pairing code is invalid.');
  if (!globalThis.crypto?.subtle)
    throw new Error('Secure browser cryptography is unavailable. Use HTTPS to enroll this POS.');
  const credentialId = crypto.randomUUID();
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
    'verify',
  ]);
  if (keyPair.privateKey.extractable)
    throw new Error('Browser did not create a protected device key.');
  const publicKeySpki = toBase64(await crypto.subtle.exportKey('spki', keyPair.publicKey));
  const result = await posRequest('/enroll', {
    method: 'POST',
    body: JSON.stringify({
      pairing_code: pairingCode,
      credential_id: credentialId,
      public_key_spki: publicKeySpki,
    }),
  });
  if (result.device_id !== deviceId || result.credential_id !== credentialId)
    throw new Error('Enrollment response does not match this device key.');
  await saveDeviceKey({ deviceId, credentialId, keyPair, state: 'active' });
  currentToken = null;
  return { deviceId, credentialId };
}

export async function getDeviceToken({ force = false } = {}) {
  if (!force && currentToken && currentToken.expiresAt > Date.now() + 30_000)
    return currentToken.value;
  const identity = await getDeviceIdentity();
  if (!identity || identity.state === 'revoked')
    throw new PosDeviceError('This POS device is not enrolled or has been revoked.', 401);
  const keyRecord = await getDeviceKey(identity.credential_id);
  if (!keyRecord?.key_pair?.privateKey || keyRecord.key_pair.privateKey.extractable)
    throw new PosDeviceError('Protected POS device key is missing. Enroll this device again.');
  const challenge = await posRequest('/challenge', {
    method: 'POST',
    body: JSON.stringify({ device_id: identity.device_id, credential_id: identity.credential_id }),
  });
  const message = `pos-device-auth-v1\n${identity.device_id}\n${identity.credential_id}\n${challenge.challenge}`;
  const signature = await sign(keyRecord.key_pair.privateKey, message);
  const session = await posRequest('/session', {
    method: 'POST',
    body: JSON.stringify({
      device_id: identity.device_id,
      credential_id: identity.credential_id,
      challenge: challenge.challenge,
      signature,
    }),
  });
  currentToken = {
    value: session.access_token,
    expiresAt: Date.now() + session.expires_in_seconds * 1000,
  };
  return currentToken.value;
}

export async function deviceApi(path, options = {}) {
  const token = options.token || (await getDeviceToken());
  try {
    return await posRequest(path, { ...options, token });
  } catch (error) {
    if (options.token || ![401, 403].includes(error.status)) throw error;
    currentToken = null;
    const replacement = await getDeviceToken({ force: true });
    return posRequest(path, { ...options, token: replacement });
  }
}

export async function refreshDeviceCatalog() {
  const identity = await getDeviceIdentity();
  if (!identity) return { device: 'unregistered', catalog: 'missing', lease: 'missing' };
  const token = await getDeviceToken();
  const bootstrap = await posRequest('/bootstrap', { token });
  const payload = await verifySignedEnvelope(bootstrap.catalog, 'catalog');
  await saveVerifiedCatalog(bootstrap.catalog, payload);
  await cacheCatalogAssets(payload);
  await putMeta('lastServerTime', bootstrap.server_time);
  const cachedLease = await getCachedLease();
  if (cachedLease) {
    try {
      const oldPayload = await verifySignedEnvelope(cachedLease.envelope, 'lease');
      const oldStatus = isLeaseUsable(oldPayload, {
        deviceId: identity.device_id,
        credentialId: identity.credential_id,
        catalogVersion: payload.catalog_version,
      });
      if (oldStatus.valid && oldStatus.expiresAt - Date.now() > 6 * 60 * 60 * 1000)
        return {
          device: 'active',
          catalog: 'verified',
          lease: 'valid',
          payload,
          catalogEnvelope: bootstrap.catalog,
          leasePayload: oldPayload,
          offlineSales: oldPayload.capabilities.includes('orders:cash:offline'),
        };
    } catch {
      // A bad or rotated cached lease is replaced below after the online catalog has been checked.
    }
  }
  const leaseEnvelope = await posRequest('/lease', {
    token,
    method: 'POST',
    body: JSON.stringify({ catalog_version: String(payload.catalog_version) }),
  });
  const lease = await verifySignedEnvelope(leaseEnvelope, 'lease');
  const usable = isLeaseUsable(lease, {
    deviceId: identity.device_id,
    credentialId: identity.credential_id,
    catalogVersion: payload.catalog_version,
  });
  if (!usable.valid) throw new Error('Server returned a lease bound to different POS data.');
  await saveVerifiedLease(leaseEnvelope, lease);
  return {
    device: 'active',
    catalog: 'verified',
    lease: 'valid',
    payload,
    catalogEnvelope: bootstrap.catalog,
    leasePayload: lease,
    offlineSales: lease.capabilities.includes('orders:cash:offline'),
  };
}

export async function readOfflineFoundation() {
  const identity = await getDeviceIdentity();
  if (!identity)
    return { device: 'unregistered', catalog: 'missing', lease: 'missing', payload: null };
  if (identity.state === 'revoked')
    return { device: 'revoked', catalog: 'missing', lease: 'missing', payload: null };
  const cachedCatalog = await getCachedCatalog();
  let payload = null;
  let catalogStatus = 'missing';
  if (cachedCatalog) {
    try {
      payload = await verifySignedEnvelope(cachedCatalog.envelope, 'catalog');
      catalogStatus = 'verified';
    } catch {
      catalogStatus = 'invalid';
    }
  }
  const cachedLease = await getCachedLease();
  const keyRecord = await getDeviceKey(identity.credential_id);
  const credentialAvailable = Boolean(
    keyRecord?.key_pair?.privateKey && !keyRecord.key_pair.privateKey.extractable,
  );
  let leaseStatus = cachedLease ? 'expired' : 'missing';
  let leasePayload = null;
  if (cachedLease) {
    try {
      leasePayload = await verifySignedEnvelope(cachedLease.envelope, 'lease');
      const usable = isLeaseUsable(leasePayload, {
        deviceId: identity.device_id,
        credentialId: identity.credential_id,
        catalogVersion: payload?.catalog_version,
      });
      leaseStatus = usable.valid ? 'valid' : usable.reason === 'expired' ? 'expired' : 'invalid';
      if (usable.valid && usable.expiresAt - Date.now() < 2 * 60 * 60 * 1000)
        leaseStatus = 'expiring';
    } catch {
      leaseStatus = 'invalid';
    }
  }
  if (payload && catalogStatus === 'verified' && ['expired', 'missing'].includes(leaseStatus))
    catalogStatus = 'stale';
  const lastServerTime = await getLastServerTime();
  const rollbackDetected =
    lastServerTime && Date.now() + 5 * 60 * 1000 < Date.parse(lastServerTime);
  if (rollbackDetected && leaseStatus !== 'missing') leaseStatus = 'invalid';
  return {
    device: identity.state === 'active' ? 'active' : 'unknown',
    catalog: catalogStatus,
    lease: leaseStatus,
    payload,
    catalogEnvelope: cachedCatalog?.envelope || null,
    leasePayload,
    offlineSales: Boolean(
      identity.state === 'active' &&
      credentialAvailable &&
      ['valid', 'expiring'].includes(leaseStatus) &&
      leasePayload?.capabilities?.includes('orders:cash:offline'),
    ),
    rollbackDetected: Boolean(rollbackDetected),
  };
}

export async function getOfflineSaleAuthorization({ now = Date.now() } = {}) {
  const identity = await getDeviceIdentity();
  if (!identity || identity.state !== 'active') throw new Error('Register this POS device first.');
  const [cachedCatalog, cachedLease, keyRecord] = await Promise.all([
    getCachedCatalog(),
    getCachedLease(),
    getDeviceKey(identity.credential_id),
  ]);
  if (!keyRecord?.key_pair?.privateKey || keyRecord.key_pair.privateKey.extractable)
    throw new Error(
      'The protected POS device credential is missing. Ask an administrator to re-enroll it.',
    );
  if (!cachedCatalog || !cachedLease)
    throw new Error('A verified menu and offline lease are required.');
  const [catalog, lease] = await Promise.all([
    verifySignedEnvelope(cachedCatalog.envelope, 'catalog'),
    verifySignedEnvelope(cachedLease.envelope, 'lease'),
  ]);
  const lastServerTime = await getLastServerTime();
  if (lastServerTime && now + 5 * 60 * 1000 < Date.parse(lastServerTime))
    throw new Error(
      'The device clock moved backwards. Reconnect before saving offline cash sales.',
    );
  const usable = isLeaseUsable(lease, {
    deviceId: identity.device_id,
    credentialId: identity.credential_id,
    catalogVersion: catalog.catalog_version,
    now,
    requiredCapabilities: ['catalog:read', 'orders:cash:offline'],
  });
  if (!usable.valid) throw new Error('The offline cash authorization is unavailable or expired.');
  return { identity, catalog, catalogEnvelope: cachedCatalog.envelope, lease };
}

async function getLastServerTime() {
  return getMeta('lastServerTime');
}

export async function rotateThisDeviceKey() {
  const identity = await getDeviceIdentity();
  if (!identity) throw new Error('This browser has no enrolled POS device.');
  const oldKey = await getDeviceKey(identity.credential_id);
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
    'verify',
  ]);
  const credentialId = crypto.randomUUID();
  const publicKeySpki = toBase64(await crypto.subtle.exportKey('spki', keyPair.publicKey));
  const digest = toHex(
    await crypto.subtle.digest(
      'SHA-256',
      Uint8Array.from(atob(publicKeySpki), (c) => c.charCodeAt(0)),
    ),
  );
  const challenge = await deviceApi('/challenge', {
    method: 'POST',
    body: JSON.stringify({ device_id: identity.device_id, credential_id: identity.credential_id }),
  });
  const message = `pos-device-key-rotation-v1\n${identity.device_id}\n${identity.credential_id}\n${challenge.challenge}\n${digest}`;
  const signature = await sign(oldKey.key_pair.privateKey, message);
  await savePendingDeviceKey({ deviceId: identity.device_id, credentialId, keyPair });
  let rotated;
  try {
    rotated = await deviceApi('/rotate-key', {
      method: 'POST',
      body: JSON.stringify({
        challenge: challenge.challenge,
        signature,
        new_credential_id: credentialId,
        new_public_key_spki: publicKeySpki,
      }),
    });
    await saveDeviceKey({ deviceId: identity.device_id, credentialId, keyPair, state: 'active' });
  } catch (error) {
    await deleteDeviceKey(credentialId);
    throw error;
  }
  await deleteDeviceKey(identity.credential_id);
  currentToken = null;
  await refreshDeviceCatalog();
  return rotated;
}
