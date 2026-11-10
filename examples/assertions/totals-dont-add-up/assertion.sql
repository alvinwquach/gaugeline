select o.id as order_id,
       o.total_cents,
       sum(l.quantity * l.unit_cents) as lines_cents
from orders o
join order_lines l on l.order_id = o.id
group by o.id, o.total_cents
having o.total_cents <> sum(l.quantity * l.unit_cents)
order by o.id
