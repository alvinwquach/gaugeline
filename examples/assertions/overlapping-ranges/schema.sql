-- The BUCK Tavern (invented): private events in two rooms.
create table private_events (
  id integer primary key,
  room text not null,
  guest_name text not null,
  guest_email text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null
);
