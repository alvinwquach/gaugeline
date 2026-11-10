-- Back to back is fine: a range does not include its end.
insert into private_events (id, room, guest_name, guest_email, starts_at, ends_at) values
  (1, 'Loft',  'Okafor party',  'okafor@example.test', '2026-12-05 19:00+00', '2026-12-05 23:00+00'),
  (2, 'Loft',  'Ng birthday',   'ng@example.test',     '2026-12-05 23:00+00', '2026-12-06 02:00+00'),
  (3, 'Patio', 'Silva wedding', 'silva@example.test',  '2026-12-05 20:00+00', '2026-12-05 23:30+00');
