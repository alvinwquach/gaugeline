-- Hold 2 ran out two days ago and is still open, so the table looks taken.
insert into table_holds (id, guest_name, party_size, status, expires_at) values
  (1, 'Okafor party', 6, 'open',    now() + interval '20 minutes'),
  (2, 'Ng birthday',  8, 'open',    now() - interval '2 days'),
  (3, 'Silva table',  2, 'expired', now() - interval '5 minutes');
