-- Lula's Kitchen (invented): an order has a total, and lines that should add up to it.
create table orders (
  id integer primary key,
  status text not null,
  total_cents integer not null,
  customer_email text not null
);
create table order_lines (
  order_id integer not null,
  line_no integer not null,
  quantity integer not null,
  unit_cents integer not null,
  primary key (order_id, line_no)
);
