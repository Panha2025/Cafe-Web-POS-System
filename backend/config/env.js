import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });
if (!process.env.DATABASE_URL)
  throw new Error('DATABASE_URL is missing. Run npm run setup and configure .env.');
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)
  throw new Error('JWT_SECRET must contain at least 32 characters. Run npm run setup.');
export const production = process.env.NODE_ENV === 'production';
export const timezone = process.env.BUSINESS_TIMEZONE || 'Asia/Phnom_Penh';
export const catalogSigningKeyId = process.env.POS_CATALOG_SIGNING_KEY_ID || '';
export const catalogSigningPrivateKeyPath = process.env.POS_CATALOG_SIGNING_PRIVATE_KEY_PATH || '';
const configuredLeaseHours = Number(process.env.POS_CATALOG_LEASE_HOURS || 24);
export const catalogLeaseHours =
  Number.isInteger(configuredLeaseHours) && configuredLeaseHours >= 1 && configuredLeaseHours <= 72
    ? configuredLeaseHours
    : null;
const configuredProxyHops = Number(process.env.POS_TRUST_PROXY_HOPS || 0);
export const trustedProxyHops =
  Number.isInteger(configuredProxyHops) && configuredProxyHops >= 0 && configuredProxyHops <= 5
    ? configuredProxyHops
    : 0;
