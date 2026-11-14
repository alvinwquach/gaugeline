-- The Ng birthday starts an hour before the Okafor party ends, in the same room.
insert into private_events (id, room, guest_name, guest_email, starts_at, ends_at) values
  (1, 'Loft',  'Okafor party',  'okafor@example.test', '2026-12-05 19:00+00', '2026-12-05 23:00+00'),
  (2, 'Loft',  'Ng birthday',   'ng@example.test',     '2026-12-05 22:00+00', '2026-12-06 01:00+00'),
  (3, 'Patio', 'Silva wedding', 'silva@example.test',  '2026-12-05 20:00+00', '2026-12-05 23:30+00');
