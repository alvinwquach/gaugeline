insert into orders (id, status, total_cents, customer_email, placed_at) values
  (1, 'paid',    2400, 'ada@example.test',   '2026-12-01 18:00+00'),
  (2, 'paid',    1800, 'grace@example.test', '2026-12-01 18:30+00'),
  (3, 'pending', 3100, 'alan@example.test',  '2026-12-01 19:00+00');
insert into payments (id, order_id, amount_cents, captured_at) values
  (1, 1, 2400, '2026-12-01 18:01+00'),
  (2, 2, 1800, '2026-12-01 18:31+00');
