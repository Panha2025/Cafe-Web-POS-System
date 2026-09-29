import { z } from 'zod';
export const money = z.coerce
  .number()
  .finite()
  .min(0)
  .max(100000)
  .refine(
    (n) => Math.abs(n * 100 - Math.round(n * 100)) < 0.000001,
    'Use at most two decimal places.',
  );
export const productSchema = z.object({
  name: z.string().trim().min(1, 'Product name is required.').max(120),
  price: money,
  category_id: z.coerce.number().int().positive(),
  available: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => v === true || v === 'true'),
});
export const orderSchema = z.object({
  request_id: z.uuid(),
  items: z
    .array(
      z.object({
        product_id: z.number().int().positive(),
        quantity: z.number().int().min(1).max(999),
        expected_price: money,
      }),
    )
    .min(1, 'Add at least one item to the order.')
    .max(100),
  discount: money.default(0),
  expected_total: money,
  payment_method: z.enum(['cash', 'khqr', 'card']),
  cash_received: money.optional(),
  confirmed: z.literal(true),
});
export const settingsSchema = z.object({
  cafe_name: z.string().trim().min(1).max(120),
  address: z.string().trim().max(500),
  phone: z.string().trim().max(40),
  currency: z.enum(['USD', 'KHR', 'EUR', 'GBP', 'THB']),
  tax_percentage: money.refine((n) => n <= 100, 'Tax must be between 0 and 100%.'),
});
export const cents = (n) => Math.round(Number(n) * 100);
export const amount = (n) => (n / 100).toFixed(2);
