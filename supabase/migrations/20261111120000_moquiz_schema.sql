-- =====================================================================
-- MOQUIZ Datenbank (Supabase / Postgres)
--
-- Aufbau
--   public.rooms, public.teams   lesbar für alle (Realtime-Updates)
--   private.*                    Quiz-Inhalte, Antworten, Geheimnisse
--                                (nicht über die API erreichbar)
--   public.<funktionen>          einzige Schnittstelle für die App (RPC)
--
-- Zugriffsmodell
--   Host:   host_secret (bei create_room erzeugt), Raum gehört einem Konto
--   Teams:  team_token (bei join_room erzeugt), kein Konto nötig
--   Quiz:   gehören dem angemeldeten Konto (auth.uid())
-- =====================================================================

create schema if not exists private;
revoke all on schema private from public;
do $$ begin
  execute 'revoke all on schema private from anon, authenticated';
exception when undefined_object then null; end $$;

-- ---------------------------------------------------------------------
-- Quiz-Inhalte
-- ---------------------------------------------------------------------
create table private.quiz_sets (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users(id) on delete cascade,
  title       text not null check (char_length(title) between 1 and 120),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index quiz_sets_owner_idx on private.quiz_sets (owner_id, updated_at desc);

create table private.quiz_categories (
  id           uuid primary key default gen_random_uuid(),
  quiz_set_id  uuid not null references private.quiz_sets(id) on delete cascade,
  title        text not null check (char_length(title) between 1 and 80),
  position     int  not null
);
create index quiz_categories_set_idx on private.quiz_categories (quiz_set_id, position);

create table private.quiz_questions (
  id                uuid primary key default gen_random_uuid(),
  category_id       uuid not null references private.quiz_categories(id) on delete cascade,
  position          int  not null,
  points            int  not null default 100 check (points between 0 and 100000),
  prompt            text not null default '' check (char_length(prompt) <= 2000),
  correct_answer    text not null default '' check (char_length(correct_answer) <= 500),
  image_url         text check (image_url is null or char_length(image_url) <= 1000),
  question_type     text not null default 'all' check (question_type in ('all', 'team', 'buzzer')),
  duration_seconds  int  not null default 30 check (duration_seconds between 5 and 600)
);
create index quiz_questions_category_idx on private.quiz_questions (category_id, position);

-- ---------------------------------------------------------------------
-- Räume und Teams (öffentlich lesbar, ohne Geheimnisse)
-- ---------------------------------------------------------------------
create table public.rooms (
  id                        uuid primary key default gen_random_uuid(),
  code                      text not null unique check (code ~ '^[A-Z0-9]{4}$'),
  phase                     text not null default 'lobby' check (phase in ('lobby', 'board', 'question', 'buzzer', 'results')),
  quiz_set_id               uuid references private.quiz_sets(id) on delete set null,
  active_question_id        uuid references private.quiz_questions(id) on delete set null,
  active_team_id            uuid,
  question_ends_at          timestamptz,
  question_paused           boolean not null default false,
  paused_remaining_seconds  int,
  question_revealed         boolean not null default false,
  buzzer_open               boolean not null default false,
  buzzer_round              int not null default 0,
  buzzer_winner_team_id     uuid,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);
create index rooms_quiz_set_idx on public.rooms (quiz_set_id);
create index rooms_active_question_idx on public.rooms (active_question_id);
create index rooms_created_idx on public.rooms (created_at);

create table public.teams (
  id         uuid primary key default gen_random_uuid(),
  room_id    uuid not null references public.rooms(id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 40),
  score      int  not null default 0,
  joined_at  timestamptz not null default now()
);
create unique index teams_room_name_uidx on public.teams (room_id, lower(name));
create index teams_room_joined_idx on public.teams (room_id, joined_at);

alter table public.rooms
  add constraint rooms_active_team_fk foreign key (active_team_id) references public.teams(id) on delete set null,
  add constraint rooms_buzzer_winner_fk foreign key (buzzer_winner_team_id) references public.teams(id) on delete set null;
create index rooms_active_team_idx on public.rooms (active_team_id);
create index rooms_buzzer_winner_idx on public.rooms (buzzer_winner_team_id);

-- ---------------------------------------------------------------------
-- Private Spieldaten
-- ---------------------------------------------------------------------
create table private.room_hosts (
  room_id      uuid primary key references public.rooms(id) on delete cascade,
  owner_id     uuid not null references auth.users(id) on delete cascade,
  host_secret  text not null
);
create index room_hosts_owner_idx on private.room_hosts (owner_id);

create table private.team_tokens (
  team_id  uuid primary key references public.teams(id) on delete cascade,
  room_id  uuid not null references public.rooms(id) on delete cascade,
  token    text not null unique
);
create index team_tokens_room_idx on private.team_tokens (room_id);

create table private.submissions (
  room_id         uuid not null references public.rooms(id) on delete cascade,
  question_id     uuid not null references private.quiz_questions(id) on delete cascade,
  team_id         uuid not null references public.teams(id) on delete cascade,
  answer_text     text check (answer_text is null or char_length(answer_text) <= 1000),
  submitted_at    timestamptz,
  points_awarded  int not null default 0,
  graded_at       timestamptz,
  primary key (room_id, question_id, team_id)
);
create index submissions_question_idx on private.submissions (question_id);
create index submissions_team_idx on private.submissions (team_id);

create table private.used_questions (
  room_id      uuid not null references public.rooms(id) on delete cascade,
  question_id  uuid not null references private.quiz_questions(id) on delete cascade,
  used_at      timestamptz not null default now(),
  primary key (room_id, question_id)
);
create index used_questions_question_idx on private.used_questions (question_id);

create table private.buzzes (
  room_id      uuid not null references public.rooms(id) on delete cascade,
  question_id  uuid not null references private.quiz_questions(id) on delete cascade,
  team_id      uuid not null references public.teams(id) on delete cascade,
  buzzed_at    timestamptz not null default now(),
  primary key (room_id, question_id, team_id)
);
create index buzzes_question_idx on private.buzzes (question_id);
create index buzzes_team_idx on private.buzzes (team_id);

-- ---------------------------------------------------------------------
-- Zugriffsrechte und Row Level Security
-- ---------------------------------------------------------------------
alter table public.rooms enable row level security;
alter table public.teams enable row level security;
alter table private.quiz_sets enable row level security;
alter table private.quiz_categories enable row level security;
alter table private.quiz_questions enable row level security;
alter table private.room_hosts enable row level security;
alter table private.team_tokens enable row level security;
alter table private.submissions enable row level security;
alter table private.used_questions enable row level security;
alter table private.buzzes enable row level security;

revoke all on public.rooms, public.teams from public, anon, authenticated;
grant select on public.rooms, public.teams to anon, authenticated;

-- Räume und Teams sind Spielzustand ohne Geheimnisse: lesen ja, schreiben nur über Funktionen
create policy "Räume lesen" on public.rooms for select to anon, authenticated using (true);
create policy "Teams lesen" on public.teams for select to anon, authenticated using (true);

-- Live-Updates für die App
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'rooms') then
      alter publication supabase_realtime add table public.rooms;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'teams') then
      alter publication supabase_realtime add table public.teams;
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Hilfsfunktionen (privat)
-- ---------------------------------------------------------------------
create function private.random_code() returns text
language sql volatile set search_path = '' as $$
  select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random() * 32)::int, 1), '')
  from generate_series(1, 4);
$$;

create function private.random_secret() returns text
language sql volatile set search_path = '' as $$
  select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
$$;

-- Raum für den Host (prüft das Host-Geheimnis)
create function private.host_room(p_code text, p_host_secret text) returns public.rooms
language plpgsql stable set search_path = '' as $$
declare r public.rooms;
begin
  select ro.* into r
  from public.rooms ro join private.room_hosts h on h.room_id = ro.id
  where ro.code = upper(trim(coalesce(p_code, ''))) and h.host_secret = coalesce(p_host_secret, '');
  if not found then raise exception 'Kein Zugriff auf diesen Raum.' using errcode = '42501'; end if;
  return r;
end $$;

-- Raum und Team für ein Team (prüft das Team-Token)
create function private.team_room(p_code text, p_team_token text, out r public.rooms, out team_id uuid)
language plpgsql stable set search_path = '' as $$
declare v_room uuid;
begin
  select t.team_id, t.room_id into team_id, v_room
  from private.team_tokens t join public.rooms ro on ro.id = t.room_id
  where ro.code = upper(trim(coalesce(p_code, ''))) and t.token = coalesce(p_team_token, '');
  if not found then raise exception 'Euer Team ist nicht mehr in diesem Raum. Bitte neu beitreten.' using errcode = '42501'; end if;
  select * into r from public.rooms where id = v_room;
end $$;

create function private.active_question(r public.rooms) returns private.quiz_questions
language plpgsql stable set search_path = '' as $$
declare q private.quiz_questions;
begin
  if r.active_question_id is null then raise exception 'Gerade läuft keine Frage.'; end if;
  select * into q from private.quiz_questions where id = r.active_question_id;
  if not found then raise exception 'Die Frage wurde inzwischen gelöscht.'; end if;
  return q;
end $$;

create function private.touch_room(p_room_id uuid) returns void
language sql volatile set search_path = '' as $$
  update public.rooms set updated_at = now() where id = p_room_id;
$$;

revoke all on all functions in schema private from public;

-- ---------------------------------------------------------------------
-- Konto: Quiz verwalten
-- ---------------------------------------------------------------------
create function public.list_my_quiz_sets() returns table (id uuid, title text)
language sql stable security definer set search_path = '' as $$
  select s.id, s.title from private.quiz_sets s
  where s.owner_id = (select auth.uid())
  order by s.updated_at desc;
$$;

create function public.create_quiz_set(p_title text) returns table (quiz_set_id uuid)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare uid uuid := auth.uid(); v_title text := trim(coalesce(p_title, '')); v_id uuid;
begin
  if uid is null then raise exception 'Bitte zuerst anmelden.'; end if;
  if v_title = '' then raise exception 'Bitte einen Titel eingeben.'; end if;
  if (select count(*) from private.quiz_sets where owner_id = uid) >= 200 then raise exception 'Du hast bereits 200 Quiz gespeichert.'; end if;
  insert into private.quiz_sets (owner_id, title) values (uid, left(v_title, 120)) returning id into v_id;
  return query select v_id;
end $$;

create function public.get_quiz_set_for_edit(p_quiz_set_id uuid, p_owner_secret text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s private.quiz_sets;
begin
  select * into s from private.quiz_sets where id = p_quiz_set_id and owner_id = auth.uid();
  if not found then raise exception 'Quiz nicht gefunden.'; end if;
  return jsonb_build_object(
    'id', s.id, 'title', s.title,
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id, 'title', c.title, 'position', c.position,
        'questions', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', q.id, 'position', q.position, 'points', q.points, 'prompt', q.prompt,
            'correct_answer', q.correct_answer, 'image_url', q.image_url,
            'question_type', q.question_type, 'duration_seconds', q.duration_seconds) order by q.position)
          from private.quiz_questions q where q.category_id = c.id), '[]'::jsonb)) order by c.position)
      from private.quiz_categories c where c.quiz_set_id = s.id), '[]'::jsonb));
end $$;

create function public.save_quiz_set(p_quiz_set_id uuid, p_owner_secret text, p_title text, p_board jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_title text := trim(coalesce(p_title, ''));
  cat jsonb; ci bigint; q jsonb; qi bigint; v_cat uuid; v_type text; v_img text;
begin
  perform 1 from private.quiz_sets where id = p_quiz_set_id and owner_id = auth.uid() for update;
  if not found then raise exception 'Quiz nicht gefunden.'; end if;
  if v_title = '' then raise exception 'Bitte einen Titel eingeben.'; end if;
  if jsonb_typeof(p_board) <> 'array' then raise exception 'Ungültige Quizdaten.'; end if;
  if jsonb_array_length(p_board) > 20 then raise exception 'Ein Quiz kann höchstens 20 Kategorien haben.'; end if;

  update private.quiz_sets set title = left(v_title, 120), updated_at = now() where id = p_quiz_set_id;
  delete from private.quiz_categories where quiz_set_id = p_quiz_set_id;

  for cat, ci in select value, ordinality from jsonb_array_elements(p_board) with ordinality loop
    if jsonb_typeof(cat->'questions') = 'array' and jsonb_array_length(cat->'questions') > 20 then
      raise exception 'Eine Kategorie kann höchstens 20 Fragen haben.';
    end if;
    insert into private.quiz_categories (quiz_set_id, title, position)
    values (p_quiz_set_id, left(coalesce(nullif(trim(cat->>'title'), ''), 'Kategorie ' || ci), 80), ci)
    returning id into v_cat;
    for q, qi in select value, ordinality from jsonb_array_elements(coalesce(cat->'questions', '[]'::jsonb)) with ordinality loop
      v_type := coalesce(q->>'question_type', 'all');
      if v_type not in ('all', 'team', 'buzzer') then v_type := 'all'; end if;
      v_img := nullif(trim(coalesce(q->>'image_url', '')), '');
      if v_img is not null and v_img !~ '^https://' then v_img := null; end if;
      insert into private.quiz_questions (category_id, position, points, prompt, correct_answer, image_url, question_type, duration_seconds)
      values (
        v_cat, qi,
        least(100000, greatest(0, coalesce((q->>'points')::numeric, 100)::int)),
        left(coalesce(q->>'prompt', ''), 2000),
        left(coalesce(q->>'correct_answer', ''), 500),
        left(v_img, 1000),
        v_type,
        least(600, greatest(5, coalesce((q->>'duration_seconds')::numeric, 30)::int))
      );
    end loop;
  end loop;
end $$;

create function public.delete_quiz_set(p_quiz_set_id uuid, p_owner_secret text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from private.quiz_sets where id = p_quiz_set_id and owner_id = auth.uid();
  if not found then raise exception 'Quiz nicht gefunden.'; end if;
end $$;

-- Übernahme alter, kontoloser Quiz aus der früheren Version: in dieser Datenbank nicht nötig
create function public.claim_legacy_quiz_set(p_quiz_set_id uuid, p_owner_secret text) returns boolean
language sql stable security definer set search_path = '' as $$ select false; $$;

-- ---------------------------------------------------------------------
-- Host: Raum und Spielablauf
-- ---------------------------------------------------------------------
create function public.create_room() returns table (room_id uuid, code text, host_secret text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare uid uuid := auth.uid(); v_code text; v_room uuid; v_secret text; tries int := 0;
begin
  if uid is null then raise exception 'Bitte zuerst anmelden.'; end if;
  -- alte Räume aufräumen
  delete from public.rooms where created_at < now() - interval '3 days';
  if (select count(*) from private.room_hosts h join public.rooms ro on ro.id = h.room_id
      where h.owner_id = uid and ro.created_at > now() - interval '1 hour') >= 30 then
    raise exception 'Zu viele neue Räume in kurzer Zeit. Bitte später nochmals versuchen.';
  end if;
  loop
    v_code := private.random_code();
    begin
      insert into public.rooms (code) values (v_code) returning id into v_room;
      exit;
    exception when unique_violation then
      tries := tries + 1;
      if tries > 30 then raise exception 'Kein freier Raumcode gefunden. Bitte nochmals versuchen.'; end if;
    end;
  end loop;
  v_secret := private.random_secret();
  insert into private.room_hosts (room_id, owner_id, host_secret) values (v_room, uid, v_secret);
  return query select v_room, v_code, v_secret;
end $$;

create function public.host_select_quiz(p_code text, p_host_secret text, p_quiz_set_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.rooms := private.host_room(p_code, p_host_secret);
begin
  if p_quiz_set_id is not null and not exists (
    select 1 from private.quiz_sets s join private.room_hosts h on h.owner_id = s.owner_id
    where s.id = p_quiz_set_id and h.room_id = r.id) then
    raise exception 'Quiz nicht gefunden.';
  end if;
  update public.rooms set
    quiz_set_id = p_quiz_set_id,
    phase = case when p_quiz_set_id is null then 'lobby' else 'board' end,
    active_question_id = null, active_team_id = null, question_ends_at = null,
    question_paused = false, paused_remaining_seconds = null, question_revealed = false,
    buzzer_open = false, buzzer_round = 0, buzzer_winner_team_id = null, updated_at = now()
  where id = r.id;
end $$;

create function public.host_get_board(p_code text, p_host_secret text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r public.rooms := private.host_room(p_code, p_host_secret);
begin
  return jsonb_build_object('categories', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', c.id, 'quiz_set_id', c.quiz_set_id, 'title', c.title, 'position', c.position,
      'questions', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', q.id, 'category_id', q.category_id, 'position', q.position, 'points', q.points,
          'prompt', q.prompt, 'image_url', q.image_url, 'question_type', q.question_type,
          'duration_seconds', q.duration_seconds) order by q.position)
        from private.quiz_questions q where q.category_id = c.id), '[]'::jsonb)) order by c.position)
    from private.quiz_categories c where c.quiz_set_id = r.quiz_set_id), '[]'::jsonb));
end $$;

create function public.host_get_used_questions(p_code text, p_host_secret text) returns table (question_id uuid)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare r public.rooms := private.host_room(p_code, p_host_secret);
begin
  return query select u.question_id from private.used_questions u where u.room_id = r.id;
end $$;

create function public.host_start_question(p_code text, p_host_secret text, p_question_id uuid, p_team_id uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.rooms := private.host_room(p_code, p_host_secret); q private.quiz_questions;
begin
  select qq.* into q from private.quiz_questions qq join private.quiz_categories c on c.id = qq.category_id
  where qq.id = p_question_id and c.quiz_set_id = r.quiz_set_id;
  if not found then raise exception 'Frage nicht gefunden.'; end if;
  if q.question_type = 'team' and not exists (select 1 from public.teams where id = p_team_id and room_id = r.id) then
    raise exception 'Bitte ein Team für diese Frage auswählen.';
  end if;
  delete from private.submissions where room_id = r.id and question_id = q.id;
  delete from private.buzzes where room_id = r.id and question_id = q.id;
  insert into private.used_questions (room_id, question_id) values (r.id, q.id) on conflict do nothing;
  update public.rooms set
    active_question_id = q.id,
    active_team_id = case when q.question_type = 'team' then p_team_id end,
    phase = case when q.question_type = 'buzzer' then 'buzzer' else 'question' end,
    question_ends_at = case when q.question_type = 'buzzer' then null else now() + make_interval(secs => q.duration_seconds) end,
    question_paused = false, paused_remaining_seconds = null, question_revealed = false,
    buzzer_open = (q.question_type = 'buzzer'),
    buzzer_round = case when q.question_type = 'buzzer' then 1 else 0 end,
    buzzer_winner_team_id = null, updated_at = now()
  where id = r.id;
end $$;

create function public.host_finish_question(p_code text, p_host_secret text) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.rooms := private.host_room(p_code, p_host_secret);
begin
  update public.rooms set
    active_question_id = null, active_team_id = null,
    phase = case when quiz_set_id is null then 'lobby' else 'board' end,
    question_ends_at = null, question_paused = false, paused_remaining_seconds = null,
    question_revealed = false, buzzer_open = false, buzzer_winner_team_id = null, updated_at = now()
  where id = r.id;
end $$;

create function public.host_close_buzzer(p_code text, p_host_secret text) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.rooms := private.host_room(p_code, p_host_secret);
begin
  if r.phase <> 'buzzer' then raise exception 'Gerade läuft keine Buzzer-Frage.'; end if;
  update public.rooms set buzzer_open = false, updated_at = now() where id = r.id;
end $$;

create function public.host_reopen_buzzer(p_code text, p_host_secret text) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.rooms := private.host_room(p_code, p_host_secret);
begin
  if r.phase <> 'buzzer' then raise exception 'Gerade läuft keine Buzzer-Frage.'; end if;
  update public.rooms set
    buzzer_open = true, buzzer_winner_team_id = null, buzzer_round = buzzer_round + 1,
    question_ends_at = null, question_paused = false, paused_remaining_seconds = null, updated_at = now()
  where id = r.id;
end $$;

create function public.host_get_question_details(p_code text, p_host_secret text, p_question_id uuid) returns table (correct_answer text)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare r public.rooms := private.host_room(p_code, p_host_secret);
begin
  return query
    select q.correct_answer from private.quiz_questions q join private.quiz_categories c on c.id = q.category_id
    where q.id = p_question_id and c.quiz_set_id = r.quiz_set_id;
end $$;

create function public.host_get_submissions(p_code text, p_host_secret text)
returns table (team_id uuid, answer_text text, submitted_at timestamptz, points_awarded int)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare r public.rooms := private.host_room(p_code, p_host_secret);
begin
  return query
    select s.team_id, s.answer_text, s.submitted_at, s.points_awarded from private.submissions s
    where s.room_id = r.id and s.question_id = r.active_question_id
    order by s.submitted_at nulls last;
end $$;

create function public.host_reveal_answers(p_code text, p_host_secret text) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.rooms := private.host_room(p_code, p_host_secret);
begin
  if r.active_question_id is null then raise exception 'Gerade läuft keine Frage.'; end if;
  update public.rooms set question_revealed = true, updated_at = now() where id = r.id;
end $$;

create function public.host_add_time(p_code text, p_host_secret text, p_seconds int) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.rooms := private.host_room(p_code, p_host_secret); s int := least(300, greatest(1, coalesce(p_seconds, 10)));
begin
  if r.active_question_id is null then raise exception 'Gerade läuft keine Frage.'; end if;
  if r.question_paused then
    update public.rooms set paused_remaining_seconds = coalesce(paused_remaining_seconds, 0) + s, updated_at = now() where id = r.id;
  elsif r.question_ends_at is not null then
    update public.rooms set question_ends_at = greatest(question_ends_at, now()) + make_interval(secs => s), updated_at = now() where id = r.id;
  end if;
end $$;

create function public.host_toggle_pause(p_code text, p_host_secret text) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.rooms := private.host_room(p_code, p_host_secret);
begin
  if r.active_question_id is null then raise exception 'Gerade läuft keine Frage.'; end if;
  if r.question_paused then
    update public.rooms set question_paused = false, paused_remaining_seconds = null,
      question_ends_at = now() + make_interval(secs => coalesce(r.paused_remaining_seconds, 0)), updated_at = now()
    where id = r.id;
  elsif r.question_ends_at is not null then
    update public.rooms set question_paused = true,
      paused_remaining_seconds = greatest(0, ceil(extract(epoch from (r.question_ends_at - now())))::int), updated_at = now()
    where id = r.id;
  end if;
end $$;

create function public.host_grade_submission(p_code text, p_host_secret text, p_team_id uuid, p_delta int) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.rooms := private.host_room(p_code, p_host_secret); d int := least(100000, greatest(-100000, coalesce(p_delta, 0))); old int;
begin
  if r.active_question_id is null then raise exception 'Gerade läuft keine Frage.'; end if;
  if not exists (select 1 from public.teams where id = p_team_id and room_id = r.id) then raise exception 'Team nicht gefunden.'; end if;
  select points_awarded into old from private.submissions
  where room_id = r.id and question_id = r.active_question_id and team_id = p_team_id for update;
  old := coalesce(old, 0);
  insert into private.submissions (room_id, question_id, team_id, points_awarded, graded_at)
  values (r.id, r.active_question_id, p_team_id, d, now())
  on conflict (room_id, question_id, team_id) do update set points_awarded = excluded.points_awarded, graded_at = excluded.graded_at;
  update public.teams set score = score + (d - old) where id = p_team_id;
  perform private.touch_room(r.id);
end $$;

create function public.host_award_points(p_code text, p_host_secret text, p_team_id uuid, p_delta int) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.rooms := private.host_room(p_code, p_host_secret); d int := least(100000, greatest(-100000, coalesce(p_delta, 0)));
begin
  update public.teams set score = score + d where id = p_team_id and room_id = r.id;
  if not found then raise exception 'Team nicht gefunden.'; end if;
end $$;

-- ---------------------------------------------------------------------
-- Teams: beitreten, buzzern, antworten
-- ---------------------------------------------------------------------
create function public.join_room(p_code text, p_name text) returns table (room_id uuid, team_id uuid, team_token text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare v_room uuid; v_name text := regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g'); v_team uuid; v_token text;
begin
  select id into v_room from public.rooms where code = upper(trim(coalesce(p_code, '')));
  if not found then raise exception 'Raum nicht gefunden. Prüfe den Code.'; end if;
  if v_name = '' then raise exception 'Bitte einen Teamnamen eingeben.'; end if;
  if char_length(v_name) > 40 then raise exception 'Der Teamname ist zu lang.'; end if;
  if (select count(*) from public.teams where room_id = v_room) >= 60 then raise exception 'Dieser Raum ist voll.'; end if;
  begin
    insert into public.teams (room_id, name) values (v_room, v_name) returning id into v_team;
  exception when unique_violation then
    raise exception 'Dieser Teamname ist schon vergeben.';
  end;
  v_token := private.random_secret();
  insert into private.team_tokens (team_id, room_id, token) values (v_team, v_room, v_token);
  return query select v_room, v_team, v_token;
end $$;

create function public.player_get_active_question(p_code text, p_team_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare ctx record; q private.quiz_questions; v_cat text;
begin
  select * into ctx from private.team_room(p_code, p_team_token);
  if (ctx.r).active_question_id is null then return null; end if;
  select * into q from private.quiz_questions where id = (ctx.r).active_question_id;
  if not found then return null; end if;
  select title into v_cat from private.quiz_categories where id = q.category_id;
  return jsonb_build_object(
    'id', q.id, 'category_id', q.category_id, 'category_title', v_cat, 'prompt', q.prompt,
    'image_url', q.image_url, 'points', q.points, 'question_type', q.question_type,
    'duration_seconds', q.duration_seconds,
    'has_buzzed', exists (select 1 from private.buzzes b where b.room_id = (ctx.r).id and b.question_id = q.id and b.team_id = ctx.team_id));
end $$;

create function public.buzz(p_code text, p_team_token text) returns void
language plpgsql security definer set search_path = '' as $$
declare ctx record; q private.quiz_questions;
begin
  select * into ctx from private.team_room(p_code, p_team_token);
  if (ctx.r).phase <> 'buzzer' or (ctx.r).active_question_id is null then raise exception 'Gerade läuft keine Buzzer-Frage.'; end if;
  if exists (select 1 from private.buzzes where room_id = (ctx.r).id and question_id = (ctx.r).active_question_id and team_id = ctx.team_id) then
    raise exception 'Ihr habt bei dieser Frage schon gebuzzert.';
  end if;
  if not (ctx.r).buzzer_open then raise exception 'Der Buzzer ist gerade gesperrt.'; end if;
  q := private.active_question(ctx.r);
  update public.rooms set
    buzzer_winner_team_id = ctx.team_id, buzzer_open = false,
    question_ends_at = now() + make_interval(secs => q.duration_seconds),
    question_paused = false, paused_remaining_seconds = null, updated_at = now()
  where id = (ctx.r).id and buzzer_open and buzzer_winner_team_id is null and active_question_id = q.id;
  if not found then raise exception 'Zu spät, ein anderes Team war schneller.'; end if;
  insert into private.buzzes (room_id, question_id, team_id) values ((ctx.r).id, q.id, ctx.team_id) on conflict do nothing;
end $$;

create function public.submit_answer(p_code text, p_team_token text, p_answer text) returns void
language plpgsql security definer set search_path = '' as $$
declare ctx record; q private.quiz_questions; n int;
begin
  select * into ctx from private.team_room(p_code, p_team_token);
  q := private.active_question(ctx.r);
  if q.question_type = 'team' and (ctx.r).active_team_id is distinct from ctx.team_id then
    raise exception 'Diese Frage geht an ein anderes Team.';
  end if;
  if q.question_type = 'buzzer' and (ctx.r).buzzer_winner_team_id is distinct from ctx.team_id then
    raise exception 'Nur das Team, das zuerst gebuzzert hat, darf antworten.';
  end if;
  if (ctx.r).question_revealed then raise exception 'Die Antworten wurden bereits aufgedeckt.'; end if;
  if not (ctx.r).question_paused and (ctx.r).question_ends_at is not null and now() > (ctx.r).question_ends_at + interval '5 seconds' then
    raise exception 'Die Zeit ist abgelaufen.';
  end if;
  insert into private.submissions (room_id, question_id, team_id, answer_text, submitted_at)
  values ((ctx.r).id, q.id, ctx.team_id, left(coalesce(p_answer, ''), 1000), now())
  on conflict (room_id, question_id, team_id) do update
    set answer_text = excluded.answer_text, submitted_at = excluded.submitted_at
    where private.submissions.submitted_at is null;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'Ihr habt schon geantwortet.'; end if;
  perform private.touch_room((ctx.r).id);
end $$;

create function public.get_my_submission(p_code text, p_team_token text)
returns table (answer_text text, submitted_at timestamptz, points_awarded int)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare ctx record;
begin
  select * into ctx from private.team_room(p_code, p_team_token);
  return query
    select s.answer_text, s.submitted_at, s.points_awarded from private.submissions s
    where s.room_id = (ctx.r).id and s.question_id = (ctx.r).active_question_id
      and s.team_id = ctx.team_id and s.submitted_at is not null;
end $$;

-- ---------------------------------------------------------------------
-- Ausführungsrechte: nur diese Funktionen sind von aussen aufrufbar
-- ---------------------------------------------------------------------
revoke all on all functions in schema public from public;
do $$ begin
  execute 'revoke all on all functions in schema public from anon, authenticated';
exception when undefined_object then null; end $$;

grant execute on function
  public.list_my_quiz_sets(), public.create_quiz_set(text), public.get_quiz_set_for_edit(uuid, text),
  public.save_quiz_set(uuid, text, text, jsonb), public.delete_quiz_set(uuid, text),
  public.claim_legacy_quiz_set(uuid, text), public.create_room()
to authenticated;

grant execute on function
  public.host_select_quiz(text, text, uuid), public.host_get_board(text, text), public.host_get_used_questions(text, text),
  public.host_start_question(text, text, uuid, uuid), public.host_finish_question(text, text),
  public.host_close_buzzer(text, text), public.host_reopen_buzzer(text, text),
  public.host_get_question_details(text, text, uuid), public.host_get_submissions(text, text),
  public.host_reveal_answers(text, text), public.host_add_time(text, text, int), public.host_toggle_pause(text, text),
  public.host_grade_submission(text, text, uuid, int), public.host_award_points(text, text, uuid, int),
  public.join_room(text, text), public.player_get_active_question(text, text), public.buzz(text, text),
  public.submit_answer(text, text, text), public.get_my_submission(text, text)
to anon, authenticated;

-- ---------------------------------------------------------------------
-- Bilder zu Fragen (Supabase Storage)
-- ---------------------------------------------------------------------
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('quiz-question-images', 'quiz-question-images', true, 8388608, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
    on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

    execute $p$create policy "Quizbilder hochladen (eigener Ordner)" on storage.objects for insert to authenticated
      with check (bucket_id = 'quiz-question-images' and (storage.foldername(name))[1] = (select auth.uid())::text)$p$;
    execute $p$create policy "Quizbilder verwalten (eigener Ordner)" on storage.objects for update to authenticated
      using (bucket_id = 'quiz-question-images' and (storage.foldername(name))[1] = (select auth.uid())::text)$p$;
    execute $p$create policy "Quizbilder löschen (eigener Ordner)" on storage.objects for delete to authenticated
      using (bucket_id = 'quiz-question-images' and (storage.foldername(name))[1] = (select auth.uid())::text)$p$;
  end if;
end $$;
