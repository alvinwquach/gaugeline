select a.id as booking_id,
       b.id as clashes_with,
       a.room,
       a.starts_at
from private_events a
join private_events b
  on a.room = b.room
 and a.id < b.id
 and tstzrange(a.starts_at, a.ends_at) && tstzrange(b.starts_at, b.ends_at)
order by a.starts_at, a.id
