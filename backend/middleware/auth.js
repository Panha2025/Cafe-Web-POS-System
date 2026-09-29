import jwt from 'jsonwebtoken';
import { pool } from '../config/db.js';
import { HttpError } from '../utils/errors.js';
export async function authenticate(req, res, next) {
  let payload;
  try {
    payload = jwt.verify(req.cookies.cafe_session || '', process.env.JWT_SECRET, {
      algorithms: ['HS256'],
    });
  } catch {
    throw new HttpError(401, 'Please sign in to continue.');
  }
  if (payload.token_use || payload.aud)
    throw new HttpError(401, 'Please sign in with a cashier or administrator account.');
  const { rows } = await pool.query('SELECT id,name,email,role FROM users WHERE id=$1', [
    payload.sub,
  ]);
  if (!rows[0]) throw new HttpError(401, 'Your account is no longer available.');
  req.user = rows[0];
  next();
}
export function admin(req, res, next) {
  if (req.user.role !== 'admin')
    throw new HttpError(403, 'Only an administrator can perform this action.');
  next();
}
