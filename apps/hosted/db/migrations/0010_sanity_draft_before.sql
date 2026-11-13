-- X71: a Sanity draft names the digest of each field's published value (`before`), so the writer can refuse
-- to create the draft when the published value has changed since the fix was proposed. The shape check is
-- replaced as a whole (create or replace keeps the grants and the trigger that calls it). Nothing stored
-- changes: no sanity_draft was produced before this row, and a draft or an edit is checked when it is
-- written or decided, by the app (apps/hosted/inbox/kinds.ts) and by this function.

create or replace function private.draft_payload_problem(p_kind text, p_payload jsonb) returns text
language plpgsql immutable set search_path = ''
as $$
declare
  v_keys text[];
  v_item jsonb;
  v_entry record;
  v_problem text;
  v_count int;
  v_number numeric;
  v_paths text[] := '{}';
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    return 'payload must be an object';
  end if;
  select coalesce(array_agg(k order by k), '{}') into v_keys from jsonb_object_keys(p_payload) k;

  if p_kind = 'email' then
    if v_keys <> array['body', 'subject'] then return 'payload must have exactly subject and body'; end if;
    return coalesce(private.draft_text_problem(p_payload -> 'subject', 'payload.subject', 1, 200, false),
                    private.draft_text_problem(p_payload -> 'body', 'payload.body', 0, 20000, true));

  elsif p_kind = 'pull_request' then
    if v_keys <> array['body', 'files', 'title'] then
      return 'payload must have exactly title, body and files';
    end if;
    v_problem := coalesce(private.draft_text_problem(p_payload -> 'title', 'payload.title', 1, 200, false),
                          private.draft_text_problem(p_payload -> 'body', 'payload.body', 0, 20000, true));
    if v_problem is not null then return v_problem; end if;
    if jsonb_typeof(p_payload -> 'files') <> 'array' then return 'payload.files must be an array'; end if;
    v_count := jsonb_array_length(p_payload -> 'files');
    if v_count < 1 or v_count > 20 then return 'payload.files must hold 1 to 20 files'; end if;
    for v_item in select * from jsonb_array_elements(p_payload -> 'files') loop
      if jsonb_typeof(v_item) <> 'object' or
         (select coalesce(array_agg(k order by k), '{}') from jsonb_object_keys(v_item) k)
           <> array['content', 'path'] then
        return 'each file must have exactly path and content';
      end if;
      if jsonb_typeof(v_item -> 'path') <> 'string' or not private.draft_path_ok(v_item ->> 'path') then
        return 'payload.files.path is not an allowed repository path';
      end if;
      if jsonb_typeof(v_item -> 'content') <> 'string' or length(v_item ->> 'content') > 100000 then
        return 'payload.files.content must be a string of at most 100000 characters';
      end if;
      v_paths := v_paths || (v_item ->> 'path');
    end loop;
    -- Two paths that differ only by case collide on a case-insensitive checkout. Paths are plain ASCII, so
    -- lower() is the same here as toLowerCase in kinds.ts, whatever the database's locale.
    if (select count(distinct lower(x)) from unnest(v_paths) x) <> v_count then
      return 'payload.files names a path twice (case aside)';
    end if;
    return null;

  elsif p_kind = 'sanity_draft' then
    if v_keys <> array['before', 'documentId', 'documentType', 'set'] then
      return 'payload must have exactly documentId, documentType, set and before';
    end if;
    if jsonb_typeof(p_payload -> 'documentId') <> 'string'
       or (p_payload ->> 'documentId') !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' then
      return 'payload.documentId is not a plain document id';
    end if;
    if jsonb_typeof(p_payload -> 'documentType') <> 'string'
       or (p_payload ->> 'documentType') !~ '^[A-Za-z][A-Za-z0-9_]{0,63}$' then
      return 'payload.documentType is not a document type';
    end if;
    if jsonb_typeof(p_payload -> 'set') <> 'object' then return 'payload.set must be an object'; end if;
    v_count := (select count(*) from jsonb_object_keys(p_payload -> 'set'));
    if v_count < 1 or v_count > 20 then return 'payload.set must hold 1 to 20 fields'; end if;
    for v_entry in select key, value from jsonb_each(p_payload -> 'set') loop
      -- No leading underscore: _id, _type, _rev and the rest are the content system's own fields.
      if v_entry.key !~ '^[A-Za-z][A-Za-z0-9_]{0,63}$' then
        return 'payload.set has a field name that is not a plain name';
      end if;
      case jsonb_typeof(v_entry.value)
        when 'string' then
          v_problem := private.draft_text_problem(v_entry.value, 'payload.set value', 0, 2000, true);
          if v_problem is not null then return v_problem; end if;
        when 'number' then
          -- The range in which JSON and jsonb print a number alike, and a value a double holds exactly as
          -- far as 15 significant digits (kinds.ts plainNumber): jsonb keeps every digit, JSON.parse in
          -- the writer does not, so a value that changes on the round trip through float8 is refused.
          -- The range is checked first, so the cast cannot overflow.
          v_number := (v_entry.value #>> '{}')::numeric;
          if v_number <> 0 then
            if abs(v_number) < 0.000001 or abs(v_number) >= 1e15 then
              return 'payload.set has a number out of range';
            end if;
            if v_number::float8::numeric <> v_number then
              return 'payload.set has a number with more than 15 significant digits';
            end if;
          end if;
        when 'boolean' then null;
        when 'null' then null;
        else return 'payload.set values must be text, numbers, true, false or null';
      end case;
    end loop;
    -- X71: before holds one SHA-256 digest (lower-case hex) per field in set, and no other field, so the
    -- writer can refuse a draft whose published value changed since it was proposed.
    if jsonb_typeof(p_payload -> 'before') <> 'object' then
      return 'payload.before must be an object';
    end if;
    if (select coalesce(array_agg(k order by k), '{}') from jsonb_object_keys(p_payload -> 'before') k)
       <> (select coalesce(array_agg(k order by k), '{}') from jsonb_object_keys(p_payload -> 'set') k) then
      return 'payload.before must name the same fields as payload.set';
    end if;
    for v_entry in select key, value from jsonb_each(p_payload -> 'before') loop
      if jsonb_typeof(v_entry.value) <> 'string' or (v_entry.value #>> '{}') !~ '^[0-9a-f]{64}$' then
        return 'payload.before values must be SHA-256 digests in lower-case hex';
      end if;
    end loop;
    return null;
  end if;
  return 'kind ' || coalesce(p_kind, 'null') || ' is not registered';
end
$$;
revoke all on function private.draft_payload_problem(text, jsonb) from public;
