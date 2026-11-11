-- Minimal nachgebildete Supabase-Umgebung (Rollen, auth, storage, realtime) für die Datenbanktests
do $r$ begin create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; create role owner login nosuperuser password 'moquiz-test'; exception when duplicate_object then null; end $r$;

alter role owner password 'moquiz-test';
grant anon, authenticated to owner;
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
grant usage on schema auth to anon, authenticated, owner;
grant select, references on auth.users to owner;
grant execute on function auth.uid() to anon, authenticated, owner;
create schema storage authorization owner;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
alter table storage.buckets owner to owner; alter table storage.objects owner to owner;
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'),1)-1] $$;
create publication supabase_realtime;
alter publication supabase_realtime owner to owner;
alter schema public owner to owner;
do $g$ begin execute format('grant create on database %I to owner', current_database()); end $g$;
-- wie bei Supabase: neue Objekte in public automatisch für anon/authenticated freigegeben
alter default privileges for role owner in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role owner in schema public grant all on functions to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
insert into auth.users values ('11111111-1111-1111-1111-111111111111','a@x'),('22222222-2222-2222-2222-222222222222','b@x');
