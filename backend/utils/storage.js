import multer from 'multer';
import sharp from 'sharp';
import { put } from '@vercel/blob';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { HttpError } from './errors.js';
export const uploadDirectory = fileURLToPath(new URL('../uploads/', import.meta.url));
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 2, fields: 12 },
  fileFilter(req, file, cb) {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    cb(
      allowed.includes(file.mimetype)
        ? null
        : new HttpError(400, 'Upload a JPG, JPEG, PNG, or WEBP image.'),
      allowed.includes(file.mimetype),
    );
  },
});
// Keep local uploads on disk for development and use durable Blob storage on Vercel.
export async function storeImage(file) {
  if (!file) return undefined;
  let image;
  try {
    const meta = await sharp(file.buffer, { limitInputPixels: 25000000 }).metadata();
    if (!['jpeg', 'png', 'webp'].includes(meta.format)) throw new Error('Unsupported image');
    image = await sharp(file.buffer, { limitInputPixels: 25000000 })
      .rotate()
      .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 90 })
      .toBuffer();
  } catch {
    throw new HttpError(
      400,
      'The image could not be read. Choose a valid JPG, PNG, or WEBP file (up to 5 MB).',
    );
  }
  const name = `${randomUUID()}.webp`;
  if (process.env.VERCEL) {
    if (!process.env.BLOB_READ_WRITE_TOKEN)
      throw new HttpError(503, 'Image storage is not configured. Contact an administrator.');
    try {
      const blob = await put(`product-images/${name}`, image, {
        access: 'public',
        addRandomSuffix: false,
        contentType: 'image/webp',
        cacheControlMaxAge: 31536000,
      });
      return blob.url;
    } catch {
      throw new HttpError(503, 'Image storage is temporarily unavailable. Please try again.');
    }
  }
  await mkdir(uploadDirectory, { recursive: true });
  await writeFile(`${uploadDirectory}/${name}`, image);
  return `/uploads/${name}`;
}
