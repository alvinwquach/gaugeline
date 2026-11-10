select o.id as order_id,
       o.total_cents,
       o.placed_at
from orders o
left join payments p on p.order_id = o.id
where o.status = 'paid'
  and p.id is null
order by o.placed_at, o.id
