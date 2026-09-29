function loadPublicKeyRing() {
  try {
    const value = (import.meta.env || {}).VITE_POS_CATALOG_PUBLIC_KEYS || '{}';
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const publicKeyRing = loadPublicKeyRing();
const toHex = (bytes) =>
  [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
const decodeBase64 = (value) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
const bytes = (value) => new TextEncoder().encode(value);
const hasExactKeys = (value, keys) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

export function parseCatalogPayload(payloadText) {
  const payload = JSON.parse(payloadText);
  if (
    !hasExactKeys(payload, [
      'schema_version',
      'catalog_version',
      'created_at',
      'settings',
      'categories',
      'products',
    ]) ||
    payload.schema_version !== 1
  )
    throw new Error('Catalog payload has an unsupported format.');
  if (!/^\d{1,18}$/.test(String(payload.catalog_version)))
    throw new Error('Catalog version is invalid.');
  const settingKeys = ['cafe_name', 'address', 'phone', 'currency', 'tax_percentage', 'logo_url'];
  if (
    !hasExactKeys(payload.settings, settingKeys) ||
    !Number.isFinite(Number(payload.settings.tax_percentage))
  )
    throw new Error('Catalog settings are invalid.');
  if (!Array.isArray(payload.categories) || !Array.isArray(payload.products))
    throw new Error('Catalog product data is invalid.');
  for (const category of payload.categories) {
    if (
      !hasExactKeys(category, ['id', 'name']) ||
      !Number.isSafeInteger(category.id) ||
      typeof category.name !== 'string'
    )
      throw new Error('Catalog contains an invalid category.');
  }
  for (const product of payload.products) {
    if (
      !hasExactKeys(product, [
        'id',
        'name',
        'price',
        'category_id',
        'category',
        'available',
        'image_url',
        'updated_at',
        'deleted_at',
      ]) ||
      !Number.isSafeInteger(product.id) ||
      !Number.isFinite(product.price) ||
      product.price < 0 ||
      !Number.isSafeInteger(product.category_id) ||
      typeof product.name !== 'string' ||
      typeof product.available !== 'boolean' ||
      typeof product.image_url !== 'string' ||
      !product.image_url.startsWith('/') ||
      product.image_url.startsWith('//')
    )
      throw new Error('Catalog contains an invalid product.');
  }
  return payload;
}

export async function verifySignedEnvelope(envelope, expectedType, keyRing = publicKeyRing) {
  const envelopeKeys =
    expectedType === 'catalog'
      ? ['type', 'version', 'key_id', 'digest', 'signature', 'payload_text']
      : ['type', 'key_id', 'digest', 'signature', 'payload_text'];
  if (
    !hasExactKeys(envelope, envelopeKeys) ||
    envelope.type !== expectedType ||
    typeof envelope.key_id !== 'string' ||
    typeof envelope.digest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(envelope.digest) ||
    typeof envelope.signature !== 'string' ||
    typeof envelope.payload_text !== 'string'
  )
    throw new Error(`${expectedType} signature envelope is invalid.`);
  const encodedKey = keyRing[envelope.key_id];
  if (typeof encodedKey !== 'string')
    throw new Error(`Signing key ${envelope.key_id} is not trusted by this app version.`);
  const digest = toHex(await crypto.subtle.digest('SHA-256', bytes(envelope.payload_text)));
  if (digest !== envelope.digest) throw new Error(`${expectedType} digest verification failed.`);
  const signatureInput = bytes(
    `${expectedType}\n${envelope.key_id}\n${digest}\n${envelope.payload_text}`,
  );
  const publicKey = await crypto.subtle.importKey(
    'spki',
    decodeBase64(encodedKey),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    decodeBase64(envelope.signature),
    signatureInput,
  );
  if (!valid) throw new Error(`${expectedType} signature verification failed.`);
  const payload = JSON.parse(envelope.payload_text);
  if (expectedType === 'catalog') {
    const catalog = parseCatalogPayload(envelope.payload_text);
    if (String(envelope.version) !== String(catalog.catalog_version))
      throw new Error('Catalog version does not match its signed payload.');
    return catalog;
  }
  if (expectedType === 'lease') {
    if (
      !hasExactKeys(payload, [
        'schema_version',
        'lease_id',
        'device_id',
        'credential_id',
        'catalog_version',
        'issued_at',
        'expires_at',
        'capabilities',
      ]) ||
      payload.schema_version !== 1 ||
      !payload.lease_id ||
      !payload.device_id ||
      !payload.credential_id ||
      !/^\d{1,18}$/.test(String(payload.catalog_version)) ||
      !Array.isArray(payload.capabilities) ||
      !(
        (payload.capabilities.length === 1 && payload.capabilities[0] === 'catalog:read') ||
        (payload.capabilities.length === 2 &&
          payload.capabilities[0] === 'catalog:read' &&
          payload.capabilities[1] === 'orders:cash:offline')
      ) ||
      !Number.isFinite(Date.parse(payload.issued_at)) ||
      !Number.isFinite(Date.parse(payload.expires_at)) ||
      Date.parse(payload.expires_at) <= Date.parse(payload.issued_at)
    )
      throw new Error('Offline lease claims are invalid.');
    return payload;
  }
  throw new Error('Unsupported signed payload type.');
}

export async function cacheCatalogAssets(payload) {
  if (!('caches' in globalThis)) return { cached: 0, failed: 0 };
  const urls = [
    payload.settings?.logo_url,
    ...(payload.products || []).map((product) => product.image_url),
  ].filter((url) => typeof url === 'string' && url.startsWith('/uploads/'));
  const unique = [...new Set(urls)];
  const cache = await caches.open('pos-catalog-assets-v1');
  let cached = 0;
  let failed = 0;
  for (const path of unique) {
    try {
      const url = new URL(path, location.origin);
      if (url.origin !== location.origin || !url.pathname.startsWith('/uploads/'))
        throw new Error('Asset URL is outside the POS origin.');
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok || !response.headers.get('content-type')?.startsWith('image/'))
        throw new Error('Catalog image could not be cached.');
      const blob = await response.blob();
      if (blob.size > 5 * 1024 * 1024) throw new Error('Catalog image is too large to cache.');
      await cache.put(url, new Response(blob, { status: 200, headers: response.headers }));
      cached += 1;
    } catch {
      failed += 1;
    }
  }
  return { cached, failed };
}

export function isLeaseUsable(
  payload,
  {
    deviceId,
    credentialId,
    catalogVersion,
    now = Date.now(),
    requiredCapabilities = ['catalog:read'],
  },
) {
  if (
    payload.device_id !== deviceId ||
    payload.credential_id !== credentialId ||
    String(payload.catalog_version) !== String(catalogVersion) ||
    !Array.isArray(payload.capabilities) ||
    !requiredCapabilities.every((capability) => payload.capabilities.includes(capability)) ||
    payload.capabilities.some(
      (capability) => !['catalog:read', 'orders:cash:offline'].includes(capability),
    )
  )
    return { valid: false, reason: 'lease_binding_mismatch' };
  const issuedAt = Date.parse(payload.issued_at);
  const expiresAt = Date.parse(payload.expires_at);
  if (issuedAt > now + 5 * 60 * 1000) return { valid: false, reason: 'clock_ahead' };
  if (expiresAt <= now) return { valid: false, reason: 'expired' };
  return { valid: true, reason: 'valid', expiresAt };
}
