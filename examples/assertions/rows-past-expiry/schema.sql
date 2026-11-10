-- The BUCK Tavern (invented): a table is held for a guest for 30 minutes.
-- A job should close the hold when it runs out.
create table table_holds (
  id integer primary key,
  guest_name text not null,
  party_size integer not null,
  status text not null,
  expires_at timestamptz not null
);
