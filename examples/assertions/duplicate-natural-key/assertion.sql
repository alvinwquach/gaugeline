select slug,
       count(*) as copies,
       min(id) as first_id
from products
where active
group by slug
having count(*) > 1
order by slug
