-- Lula's Kitchen (invented): orders, and payments written by the card processor's webhook.
-- There is no foreign key between them, which is exactly why the rule is worth checking.
create table orders (
  id integer primary key,
  status text not null,
  total_cents integer not null,
  customer_email text not null,
  placed_at timestamptz not null
);
create table payments (
  id integer primary key,
  order_id integer not null,
  amount_cents integer not null,
  captured_at timestamptz
);
