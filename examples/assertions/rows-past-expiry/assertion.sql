select id as hold_id,
       party_size,
       expires_at
from table_holds
where status = 'open'
  and expires_at < now() - interval '15 minutes'
order by expires_at, id
