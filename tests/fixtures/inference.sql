-- No declared foreign keys at all: relationships must be guessed and marked as guesses.
CREATE TABLE customers (id int PRIMARY KEY, name text);
CREATE TABLE categories (id int PRIMARY KEY, parent_id int, title text);
CREATE TABLE products (id int PRIMARY KEY, category_id int, sku varchar(20));
CREATE TABLE orders (id int PRIMARY KEY, customer_id int NOT NULL, billing_customer_id int, placed_at date);
CREATE TABLE order_items (id int PRIMARY KEY, order_id int NOT NULL, product_id int NOT NULL, qty int);
CREATE TABLE stores (StoreCode char(4) PRIMARY KEY, city text);
CREATE TABLE stock (StoreCode char(4) NOT NULL, product_id int NOT NULL, on_hand int, PRIMARY KEY (StoreCode, product_id));
CREATE TABLE audit_log (id int PRIMARY KEY, actor_id int, entity_id int, payload text);
CREATE TABLE coupons (id int PRIMARY KEY, customer_id varchar(30));
