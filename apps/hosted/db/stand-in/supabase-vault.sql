-- STAND-IN FOR SUPABASE VAULT. TEST HARNESS AND LOCAL STACK ONLY. NOT A MIGRATION.
-- NEVER RUN THIS ON A SUPABASE PROJECT, AND NEVER STORE A REAL SECRET IN IT.
--
-- Supabase Vault is the supabase_vault extension; it does not exist in plain Postgres 16. This file makes
-- the same names with the same signatures, copied from the extension's source (github.com/supabase/vault,
-- sql/supabase_vault--0.3.0.sql and --0.3.1--0.3.2.sql), so migration 0006 runs unchanged in tests:
--   table vault.secrets (id, name, description, secret, key_id, nonce, created_at, updated_at)
--   view  vault.decrypted_secrets (the same columns plus decrypted_secret)
--   vault.create_secret(new_secret, new_name, new_description, new_key_id) returns uuid
--   vault.update_secret(secret_id, new_secret, new_name, new_description, new_key_id) returns void
-- The real extension encrypts with libsodium under a key SQL cannot read. This stand-in only scrambles:
-- XOR with a SHA-256 keystream from a fixed TEST key that is printed right here. It is reversible by
-- design and protects nothing; it exists so the tests can show that the table never holds plaintext.

create schema if not exists vault;
revoke all on schema vault from public;

create or replace function vault._standin_xor(message bytea, nonce bytea, id uuid) returns bytea
language plpgsql immutable set search_path = pg_catalog, pg_temp
as $$
declare
  out bytea := message;
  stream bytea := ''::bytea;
  block int := 0;
begin
  while length(stream) < length(message) loop
    stream := stream || sha256(convert_to('gaugeline-vault-stand-in-TEST-KEY', 'UTF8')
      || nonce || convert_to(id::text || ':' || block::text, 'UTF8'));
    block := block + 1;
  end loop;
  for i in 0 .. length(message) - 1 loop
    out := set_byte(out, i, get_byte(message, i) # get_byte(stream, i));
  end loop;
  return out;
end
$$;

create table if not exists vault.secrets (
  id uuid primary key default gen_random_uuid(),
  name text,
  description text not null default '',
  secret text not null,
  key_id uuid,
  nonce bytea default sha256(convert_to(gen_random_uuid()::text, 'UTF8')),
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp
);
create unique index if not exists secrets_name_idx on vault.secrets (name) where name is not null;

create or replace view vault.decrypted_secrets as
select s.id, s.name, s.description, s.secret,
  convert_from(vault._standin_xor(decode(s.secret, 'base64'), s.nonce, s.id), 'UTF8') as decrypted_secret,
  s.key_id, s.nonce, s.created_at, s.updated_at
from vault.secrets s;

create or replace function vault.create_secret(
  new_secret text, new_name text = null, new_description text = '', new_key_id uuid = null
) returns uuid
security definer language plpgsql set search_path = pg_catalog, pg_temp
as $$
declare
  v_id uuid := gen_random_uuid();
  v_nonce bytea := sha256(convert_to(gen_random_uuid()::text, 'UTF8'));
begin
  -- Unlike the real function (which inserts the plaintext and then updates it), the stand-in never
  -- writes the plaintext to the table, not even inside the transaction.
  insert into vault.secrets (id, name, description, secret, nonce)
  values (v_id, new_name, new_description,
          encode(vault._standin_xor(convert_to(new_secret, 'UTF8'), v_nonce, v_id), 'base64'), v_nonce);
  return v_id;
end
$$;

create or replace function vault.update_secret(
  secret_id uuid, new_secret text = null, new_name text = null, new_description text = null,
  new_key_id uuid = null
) returns void
security definer language plpgsql set search_path = pg_catalog, pg_temp
as $$
begin
  update vault.secrets s
  set secret = case when new_secret is null then s.secret
                    else encode(vault._standin_xor(convert_to(new_secret, 'UTF8'), s.nonce, s.id), 'base64') end,
      name = coalesce(new_name, s.name),
      description = coalesce(new_description, s.description),
      updated_at = now()
  where s.id = secret_id;
end
$$;

-- As the extension does: nothing for PUBLIC.
revoke all on all tables in schema vault from public;
revoke all on function vault._standin_xor(bytea, bytea, uuid), vault.create_secret(text, text, text, uuid),
  vault.update_secret(uuid, text, text, text, uuid) from public;
-- Pessimistic on purpose: assume the platform gives its API roles Vault access (whether a real project
-- does is not known from here), so the tests prove migration 0006 takes it back.
grant usage on schema vault to anon, authenticated, service_role;
grant select on vault.secrets, vault.decrypted_secrets to anon, authenticated, service_role;
grant execute on function vault.create_secret(text, text, text, uuid),
  vault.update_secret(uuid, text, text, text, uuid) to anon, authenticated, service_role;
