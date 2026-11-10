-- The seeds use times relative to now, so they never go stale.
insert into table_holds (id, guest_name, party_size, status, expires_at) values
  (1, 'Okafor party', 6, 'open',    now() + interval '20 minutes'),
  (2, 'Ng birthday',  8, 'expired', now() - interval '3 days'),
  (3, 'Silva table',  2, 'open',    now() - interval '5 minutes');
