-- Bring The Shreds (invented): a skate shop's catalogue, imported from a supplier's sheet.
create table products (
  id integer primary key,
  slug text not null,
  name text not null,
  stripe_price_id text,
  active boolean not null default true
);
