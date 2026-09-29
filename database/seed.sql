BEGIN;
INSERT INTO users(name,email,password_hash,role) VALUES
('Alex Morgan','admin@cafepos.local','$2b$12$Lce2aB9H96SltUcMgMthK.ApovTqFYyOGccNLdxn.IFd3HwEhSHMK','admin'),
('Sokha','cashier@cafepos.local','$2b$12$AdgBlqsqGepA/iNIBZ.tbeTHQbRv.PEsb77y6IG9r.Kjfc4j7iWMK','cashier')
ON CONFLICT(email) DO NOTHING;
INSERT INTO categories(name) VALUES ('Coffee'),('Tea'),('Non-Coffee'),('Food'),('Dessert') ON CONFLICT DO NOTHING;
INSERT INTO settings(id,cafe_name,address,phone) VALUES(1,'Brew & Bean','123 Riverside Street, Phnom Penh','+855 12 345 678') ON CONFLICT DO NOTHING;
INSERT INTO products(name,price,category_id,image_url)
SELECT v.name,v.price,c.id,v.image FROM (VALUES
 ('Americano',2.50,'Coffee','/images/americano.jpg'),
 ('Cappuccino',3.00,'Coffee','/images/cappuccino.jpg'),
 ('Latte',3.00,'Coffee','/images/latte.jpg'),
 ('Mocha',3.50,'Coffee','/images/mocha.jpg'),
 ('Matcha Latte',3.50,'Tea','/images/matcha.jpg'),
 ('Thai Tea',3.00,'Tea','/images/thai-tea.jpg'),
 ('Chocolate',3.00,'Non-Coffee','/images/chocolate.jpg'),
 ('Lemon Tea',2.50,'Tea','/images/lemon-tea.jpg'),
 ('Peach Soda',3.00,'Non-Coffee','/images/peach-soda.jpg'),
 ('Strawberry Soda',3.00,'Non-Coffee','/images/strawberry-soda.jpg'),
 ('Croissant',2.50,'Food','/images/croissant.jpg'),
 ('Blueberry Muffin',3.00,'Dessert','/images/muffin.jpg'),
 ('Cheesecake',4.00,'Dessert','/images/cheesecake.jpg'),
 ('Chocolate Cake',4.00,'Dessert','/images/chocolate-cake.jpg'),
 ('Cookies',2.00,'Dessert','/images/cookies.jpg')
) AS v(name,price,category,image) JOIN categories c ON c.name=v.category
WHERE NOT EXISTS(SELECT 1 FROM products p WHERE p.name=v.name);
COMMIT;
