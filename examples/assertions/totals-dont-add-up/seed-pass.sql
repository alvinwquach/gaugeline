insert into orders (id, status, total_cents, customer_email) values
  (1, 'paid', 2400, 'ada@example.test'),
  (2, 'paid', 1800, 'grace@example.test');
insert into order_lines (order_id, line_no, quantity, unit_cents) values
  (1, 1, 2, 900),
  (1, 2, 1, 600),
  (2, 1, 3, 600);
