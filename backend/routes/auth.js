import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { pool } from '../config/db.js';
import { production } from '../config/env.js';
import { authenticate } from '../middleware/auth.js';
import { HttpError } from '../utils/errors.js';
const router = Router();
const cookie = { httpOnly: true, secure: production, sameSite: 'strict', path: '/' };
router.post(
  '/login',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  }),
  async (req, res) => {
    const { email, password } = z
      .object({ email: z.email(), password: z.string().min(1).max(128) })
      .parse(req.body);
    const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [
      email.toLowerCase().trim(),
    ]);
    const user = rows[0];
    const valid = await bcrypt.compare(
      password,
      user?.password_hash || '$2b$12$KbQiJXGK5hXz1byFCyVNs.5YeNYMVGKXTF1Ej8ByA2PuPoqn1iF4S',
    );
    if (!user || !valid) throw new HttpError(401, 'Incorrect email or password.');
    const token = jwt.sign({}, process.env.JWT_SECRET, {
      subject: String(user.id),
      expiresIn: '12h',
      algorithm: 'HS256',
    });
    res.cookie('cafe_session', token, { ...cookie, maxAge: 12 * 60 * 60 * 1000 });
    res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
  },
);
router.get(
  '/me',
  (req, res, next) => (req.cookies.cafe_session ? next() : res.json(null)),
  authenticate,
  (req, res) => res.json(req.user),
);
router.post('/logout', (req, res) => {
  res.clearCookie('cafe_session', cookie);
  res.json({ ok: true });
});
export default router;
