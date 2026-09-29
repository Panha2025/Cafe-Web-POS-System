BEGIN;
CREATE TABLE IF NOT EXISTS users (
 id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, email VARCHAR(254) UNIQUE NOT NULL,
 password_hash TEXT NOT NULL, role VARCHAR(10) NOT NULL CHECK(role IN ('admin','cashier')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS categories (id SERIAL PRIMARY KEY, name VARCHAR(80) UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS products (
 id SERIAL PRIMARY KEY, name VARCHAR(120) NOT NULL, price NUMERIC(12,2) NOT NULL CHECK(price>=0),
 category_id INTEGER NOT NULL REFERENCES categories(id), image_url TEXT,
 available BOOLEAN NOT NULL DEFAULT true, deleted_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS settings (
 id INTEGER PRIMARY KEY CHECK(id=1), cafe_name VARCHAR(120) NOT NULL DEFAULT 'Brew & Bean',
 logo_url TEXT, address TEXT NOT NULL DEFAULT '', phone VARCHAR(40) NOT NULL DEFAULT '',
 currency VARCHAR(3) NOT NULL DEFAULT 'USD', tax_percentage NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK(tax_percentage BETWEEN 0 AND 100),
 khqr_url TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS orders (
 id BIGSERIAL PRIMARY KEY, order_number TEXT UNIQUE NOT NULL,
 request_id UUID UNIQUE NOT NULL, cashier_id INTEGER NOT NULL REFERENCES users(id),
 subtotal NUMERIC(12,2) NOT NULL CHECK(subtotal>=0), discount NUMERIC(12,2) NOT NULL CHECK(discount>=0 AND discount<=subtotal),
 tax NUMERIC(12,2) NOT NULL CHECK(tax>=0), tax_percentage NUMERIC(5,2) NOT NULL,
 total NUMERIC(12,2) NOT NULL CHECK(total=subtotal-discount+tax),
 currency VARCHAR(3) NOT NULL, receipt_settings JSONB NOT NULL,
 status VARCHAR(20) NOT NULL DEFAULT 'paid' CHECK(status='paid'), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS order_items (
 id BIGSERIAL PRIMARY KEY, order_id BIGINT NOT NULL REFERENCES orders(id), product_id INTEGER NOT NULL REFERENCES products(id),
 product_name VARCHAR(120) NOT NULL, image_url TEXT, quantity INTEGER NOT NULL CHECK(quantity>0),
 unit_price NUMERIC(12,2) NOT NULL CHECK(unit_price>=0), subtotal NUMERIC(12,2) NOT NULL CHECK(subtotal=unit_price*quantity)
);
CREATE TABLE IF NOT EXISTS payments (
 id BIGSERIAL PRIMARY KEY, order_id BIGINT UNIQUE NOT NULL REFERENCES orders(id),
 method VARCHAR(10) NOT NULL CHECK(method IN ('cash','khqr','card')), status VARCHAR(20) NOT NULL DEFAULT 'paid' CHECK(status='paid'),
 amount NUMERIC(12,2) NOT NULL CHECK(amount>=0), cash_received NUMERIC(12,2), change_amount NUMERIC(12,2),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK((method='cash' AND cash_received>=amount AND change_amount=cash_received-amount) OR (method<>'cash' AND cash_received IS NULL AND change_amount IS NULL))
);
CREATE INDEX IF NOT EXISTS orders_created_idx ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items(order_id);
COMMIT;
