import './config/env.js';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { pool } from './config/db.js';
import { trustedProxyHops } from './config/env.js';
import { authenticate, admin } from './middleware/auth.js';
import { uploadDirectory } from './utils/storage.js';
import auth from './routes/auth.js';
import products from './routes/products.js';
import settings from './routes/settings.js';
import orders from './routes/orders.js';
import reports from './routes/reports.js';
import devices from './routes/devices.js';
import pos from './routes/pos.js';
export const app = express();
app.disable('x-powered-by');
if (trustedProxyHops > 0) app.set('trust proxy', trustedProxyHops);
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        'img-src': ["'self'", 'data:', 'blob:', 'https://images.unsplash.com'],
        'upgrade-insecure-requests': null,
      },
    },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  }),
);
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (
    !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
    req.headers.origin &&
    req.headers.origin !== process.env.APP_ORIGIN
  )
    return res.status(403).json({ error: 'This request came from an untrusted origin.' });
  next();
});
app.get('/api/health', async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok', database: 'PostgreSQL' });
});
app.use('/api/auth', auth);
app.use('/api/products', authenticate, products);
app.get('/api/categories', authenticate, async (req, res) =>
  res.json((await pool.query('SELECT * FROM categories ORDER BY id')).rows),
);
app.use('/api/orders', authenticate, orders);
app.use('/api/settings', authenticate, settings);
app.use('/api/reports', authenticate, admin, reports);
app.use('/api/devices', authenticate, admin, devices);
app.use('/api/pos', pos);
app.use('/uploads', express.static(uploadDirectory, { maxAge: '30d', immutable: true }));
app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found.' }));
const dist = fileURLToPath(new URL('../frontend/dist/', import.meta.url));
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get('/{*path}', (req, res) => res.sendFile(`${dist}/index.html`));
}
app.use((error, req, res, next) => {
  console.error(`${req.method} ${req.path}:`, error.message);
  if (error instanceof ZodError)
    return res
      .status(400)
      .json({ error: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' ') });
  if (error.code === 'LIMIT_FILE_SIZE')
    return res.status(400).json({ error: 'Image must be 5 MB or smaller.' });
  if (error.name === 'MulterError')
    return res
      .status(400)
      .json({ error: 'Image upload failed. Check the file fields and try again.' });
  if (['22P02', '22008', '22007', '23503'].includes(error.code))
    return res.status(400).json({ error: 'Invalid value. Please check your entries.' });
  if (
    ['ECONNREFUSED', '57P01', 'ENOTFOUND'].includes(error.code) ||
    /Connection terminated|connection timeout/i.test(error.message)
  )
    return res.status(503).json({
      error: 'Database connection failed. Please check that PostgreSQL is running and try again.',
    });
  res.status(error.status || 500).json({
    error:
      error.status && error.status < 500
        ? error.message
        : 'Something went wrong while saving or loading data. Please try again.',
  });
});
const server = app.listen(Number(process.env.PORT || 4000), process.env.HOST || '127.0.0.1', () =>
  console.log(
    `Café POS API running at http://${process.env.HOST || '127.0.0.1'}:${process.env.PORT || 4000}`,
  ),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () =>
    server.close(async () => {
      await pool.end();
      process.exit(0);
    }),
  );
