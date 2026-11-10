-- Order 2 was charged 1800, but its lines add up to 2400: the quantity was edited afterwards.
insert into orders (id, status, total_cents, customer_email) values
  (1, 'paid', 2400, 'ada@example.test'),
  (2, 'paid', 1800, 'grace@example.test');
insert into order_lines (order_id, line_no, quantity, unit_cents) values
  (1, 1, 2, 900),
  (1, 2, 1, 600),
  (2, 1, 4, 600);
