-- The wax bar was imported twice, and both copies are on sale.
insert into products (id, slug, name, stripe_price_id, active) values
  (1, 'logo-tee', 'Logo tee',     'price_tee_01', true),
  (2, 'wax-bar',  'Rail wax bar', 'price_wax_01', true),
  (3, 'wax-bar',  'Rail wax bar', 'price_wax_02', true);
