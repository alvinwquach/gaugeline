insert into products (id, slug, name, stripe_price_id, active) values
  (1, 'logo-tee',   'Logo tee',        'price_tee_01',  true),
  (2, 'wax-bar',    'Rail wax bar',    'price_wax_01',  true),
  -- An old copy is switched off, so it does not count.
  (3, 'logo-tee',   'Logo tee (old)',  'price_tee_00',  false);
