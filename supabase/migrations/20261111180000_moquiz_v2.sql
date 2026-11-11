-- =====================================================================
-- MOQUIZ Datenbank, Version 2
--   Audiofragen, Einsatz-Joker, 50:50-Joker, Spielrückblick
-- =====================================================================

-- ---------------------------------------------------------------------
-- Audio zu Fragen
-- ---------------------------------------------------------------------
alter table private.quiz_questions
  add column audio_url text check (audio_url is null or (char_length(audio_url) <= 1000 and audio_url ~ '^https://'));

-- ---------------------------------------------------------------------
-- Joker (einmal pro Spiel und Team)
--   joker_state: available = noch frei, armed = für die nächste Frage gesetzt, used = eingesetzt
--   Der Einsatz ist für alle sichtbar (Beamer zeigt ihn an), das 50:50-Ergebnis bleibt privat.
-- ---------------------------------------------------------------------
alter table public.teams
  add column joker_state text not null default 'available' check (joker_state in ('available', 'armed', 'used')),
  add column joker_amount int check (joker_amount is null or joker_amount >= 0),
  add column joker_question_id uuid references private.quiz_questions(id) on delete set null,
  add column fifty_used boolean not null default false;
create index teams_joker_question_idx on public.teams (joker_question_id);

create table private.joker_uses (
  room_id      uuid not null references public.rooms(id) on delete cascade,
  team_id      uuid not null references public.teams(id) on delete cascade,
  question_id  uuid not null references private.quiz_questions(id) on delete cascade,
  kind         text not null check (kind in ('fifty')),
  hidden       text[] not null default '{}',
  created_at   timestamptz not null default now(),
  primary key (room_id, team_id, question_id, kind)
);
create index joker_uses_team_idx on private.joker_uses (team_id);
create index joker_uses_question_idx on private.joker_uses (question_id);
alter table private.joker_uses enable row level security;

-- ---------------------------------------------------------------------
-- Quiz speichern und laden: zusätzlich audio_url
-- ---------------------------------------------------------------------
create or replace function public.get_quiz_set_for_edit(p_quiz_set_id uuid, p_owner_secret text default null) returns jsonb
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
            'correct_answer', q.correct_answer, 'image_url', q.image_url, 'audio_url', q.audio_url,
            'question_type', q.question_type, 'duration_seconds', q.duration_seconds) order by q.position)
          from private.quiz_questions q where q.category_id = c.id), '[]'::jsonb)) order by c.position)
      from private.quiz_categories c where c.quiz_set_id = s.id), '[]'::jsonb));
end $$;

create or replace function public.save_quiz_set(p_quiz_set_id uuid, p_owner_secret text, p_title text, p_board jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_title text := trim(coalesce(p_title, ''));
  cat jsonb; ci bigint; q jsonb; qi bigint; v_cat uuid; v_type text; v_img text; v_audio text;
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
      if v_img is not null and (v_img !~ '^https://' or char_length(v_img) > 1000) then v_img := null; end if;
      v_audio := nullif(trim(coalesce(q->>'audio_url', '')), '');
      if v_audio is not null and (v_audio !~ '^https://' or char_length(v_audio) > 1000) then v_audio := null; end if;
      insert into private.quiz_questions (category_id, position, points, prompt, correct_answer, image_url, audio_url, question_type, duration_seconds)
      values (
        v_cat, qi,
        least(100000, greatest(0, coalesce((q->>'points')::numeric, 100)::int)),
        left(coalesce(q->>'prompt', ''), 2000),
        left(coalesce(q->>'correct_answer', ''), 500),
        v_img, v_audio, v_type,
        least(600, greatest(5, coalesce((q->>'duration_seconds')::numeric, 30)::int))
      );
    end loop;
  end loop;
end $$;

create or replace function public.host_get_board(p_code text, p_host_secret text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r public.rooms := private.host_room(p_code, p_host_secret);
begin
  return jsonb_build_object('categories', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', c.id, 'quiz_set_id', c.quiz_set_id, 'title', c.title, 'position', c.position,
      'questions', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', q.id, 'category_id', q.category_id, 'position', q.position, 'points', q.points,
          'prompt', q.prompt, 'image_url', q.image_url, 'audio_url', q.audio_url, 'question_type', q.question_type,
          'duration_seconds', q.duration_seconds) order by q.position)
        from private.quiz_questions q where q.category_id = c.id), '[]'::jsonb)) order by c.position)
    from private.quiz_categories c where c.quiz_set_id = r.quiz_set_id), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------
-- Frage starten: setzt bereitstehende Einsatz-Joker ein
--   p_no_joker = true für die Finalrunde (dort gibt es bereits einen Einsatz)
-- ---------------------------------------------------------------------
drop function public.host_start_question(text, text, uuid, uuid);
create function public.host_start_question(p_code text, p_host_secret text, p_question_id uuid, p_team_id uuid default null, p_no_joker boolean default false) returns void
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
  delete from private.joker_uses where room_id = r.id and question_id = q.id;
  insert into private.used_questions (room_id, question_id) values (r.id, q.id) on conflict do nothing;
  -- Einsatz-Joker gilt für Teams, die antworten dürfen (bei Buzzer-Fragen erst beim Buzzern)
  if not coalesce(p_no_joker, false) and q.question_type <> 'buzzer' then
    update public.teams set joker_state = 'used', joker_question_id = q.id,
      joker_amount = greatest(0, least(coalesce(joker_amount, 0), score))
    where room_id = r.id and joker_state = 'armed'
      and (q.question_type = 'all' or (q.question_type = 'team' and id = p_team_id));
  end if;
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

create or replace function public.buzz(p_code text, p_team_token text) returns void
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
  update public.teams set joker_state = 'used', joker_question_id = q.id,
    joker_amount = greatest(0, least(coalesce(joker_amount, 0), score))
  where id = ctx.team_id and joker_state = 'armed';
end $$;

-- ---------------------------------------------------------------------
-- Einsatz-Joker setzen und zurücknehmen (nur zwischen den Fragen)
-- ---------------------------------------------------------------------
create function public.player_arm_joker(p_code text, p_team_token text, p_amount int) returns void
language plpgsql security definer set search_path = '' as $$
declare ctx record; t public.teams;
begin
  select * into ctx from private.team_room(p_code, p_team_token);
  if (ctx.r).active_question_id is not null then raise exception 'Den Joker könnt ihr nur zwischen den Fragen setzen.'; end if;
  if (ctx.r).quiz_set_id is null then raise exception 'Das Quiz hat noch nicht begonnen.'; end if;
  select * into t from public.teams where id = ctx.team_id for update;
  if t.joker_state = 'used' then raise exception 'Ihr habt euren Joker schon eingesetzt.'; end if;
  if t.score <= 0 then raise exception 'Für den Joker braucht ihr zuerst Punkte.'; end if;
  if coalesce(p_amount, 0) < 1 or p_amount > t.score then raise exception 'Der Einsatz muss zwischen 1 und % Punkten liegen.', t.score; end if;
  update public.teams set joker_state = 'armed', joker_amount = p_amount, joker_question_id = null where id = t.id;
end $$;

create function public.player_disarm_joker(p_code text, p_team_token text) returns void
language plpgsql security definer set search_path = '' as $$
declare ctx record;
begin
  select * into ctx from private.team_room(p_code, p_team_token);
  if (ctx.r).active_question_id is not null then raise exception 'Den Joker könnt ihr nur zwischen den Fragen zurücknehmen.'; end if;
  update public.teams set joker_state = 'available', joker_amount = null, joker_question_id = null
  where id = ctx.team_id and joker_state = 'armed';
  if not found then raise exception 'Der Joker ist nicht gesetzt oder schon eingesetzt.'; end if;
end $$;

-- ---------------------------------------------------------------------
-- 50:50-Joker: blendet bei Multiple Choice falsche Antworten aus, bis zwei übrig bleiben
-- ---------------------------------------------------------------------
create function public.player_use_fifty(p_code text, p_team_token text) returns text[]
language plpgsql security definer set search_path = '' as $$
declare ctx record; q private.quiz_questions; letters text[]; correct text; hidden text[];
begin
  select * into ctx from private.team_room(p_code, p_team_token);
  q := private.active_question(ctx.r);
  if exists (select 1 from public.teams where id = ctx.team_id and fifty_used) then raise exception 'Ihr habt den 50:50-Joker schon eingesetzt.'; end if;
  if q.question_type = 'team' and (ctx.r).active_team_id is distinct from ctx.team_id then raise exception 'Diese Frage geht an ein anderes Team.'; end if;
  if q.question_type = 'buzzer' and (ctx.r).buzzer_winner_team_id is distinct from ctx.team_id then raise exception 'Nur das Team, das zuerst gebuzzert hat, darf antworten.'; end if;
  if (ctx.r).question_revealed then raise exception 'Die Antworten wurden bereits aufgedeckt.'; end if;
  if exists (select 1 from private.submissions where room_id = (ctx.r).id and question_id = q.id and team_id = ctx.team_id and submitted_at is not null) then
    raise exception 'Ihr habt schon geantwortet.';
  end if;
  select array_agg(m[1] order by m[1]) into letters from regexp_matches(q.prompt, '^\s*([A-F])\)\s+\S', 'gn') as m;
  correct := upper(substring(q.correct_answer from '^\s*([A-Fa-f])\)'));
  if coalesce(array_length(letters, 1), 0) < 3 or correct is null or not (correct = any(letters)) then
    raise exception 'Der 50:50-Joker geht nur bei Multiple-Choice-Fragen mit mindestens drei Antworten.';
  end if;
  select array_agg(l) into hidden from (
    select l from unnest(letters) as l where l <> correct order by random() limit array_length(letters, 1) - 2
  ) x;
  insert into private.joker_uses (room_id, team_id, question_id, kind, hidden) values ((ctx.r).id, ctx.team_id, q.id, 'fifty', hidden);
  update public.teams set fifty_used = true where id = ctx.team_id;
  return hidden;
end $$;

create or replace function public.player_get_active_question(p_code text, p_team_token text) returns jsonb
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
    'image_url', q.image_url, 'has_audio', q.audio_url is not null, 'points', q.points, 'question_type', q.question_type,
    'duration_seconds', q.duration_seconds,
    'has_buzzed', exists (select 1 from private.buzzes b where b.room_id = (ctx.r).id and b.question_id = q.id and b.team_id = ctx.team_id),
    'fifty_hidden', coalesce((select to_jsonb(j.hidden) from private.joker_uses j
      where j.room_id = (ctx.r).id and j.question_id = q.id and j.team_id = ctx.team_id and j.kind = 'fifty'), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------
-- Rückblick: Daten für Punkteverlauf und Auszeichnungen
-- ---------------------------------------------------------------------
create function public.host_get_game_stats(p_code text, p_host_secret text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r public.rooms := private.host_room(p_code, p_host_secret);
begin
  return jsonb_build_object(
    'questions', coalesce((
      select jsonb_agg(jsonb_build_object('id', u.question_id, 'used_at', u.used_at, 'points', q.points,
        'category', c.title, 'question_type', q.question_type) order by u.used_at)
      from private.used_questions u
      join private.quiz_questions q on q.id = u.question_id
      join private.quiz_categories c on c.id = q.category_id
      where u.room_id = r.id), '[]'::jsonb),
    'results', coalesce((
      select jsonb_agg(jsonb_build_object('team_id', s.team_id, 'question_id', s.question_id,
        'points_awarded', s.points_awarded, 'submitted_at', s.submitted_at, 'graded', s.graded_at is not null))
      from private.submissions s where s.room_id = r.id), '[]'::jsonb),
    'buzzes', coalesce((
      select jsonb_agg(jsonb_build_object('team_id', b.team_id, 'question_id', b.question_id,
        'ms', round(extract(epoch from (b.buzzed_at - u.used_at)) * 1000)))
      from private.buzzes b join private.used_questions u on u.room_id = b.room_id and u.question_id = b.question_id
      where b.room_id = r.id), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------
-- Rechte für neue und geänderte Funktionen
-- ---------------------------------------------------------------------
revoke all on function
  public.host_start_question(text, text, uuid, uuid, boolean), public.player_arm_joker(text, text, int),
  public.player_disarm_joker(text, text), public.player_use_fifty(text, text), public.host_get_game_stats(text, text)
from public;
do $$ begin
  execute 'revoke all on function public.host_start_question(text, text, uuid, uuid, boolean), public.player_arm_joker(text, text, int), public.player_disarm_joker(text, text), public.player_use_fifty(text, text), public.host_get_game_stats(text, text) from anon, authenticated';
exception when undefined_object then null; end $$;
grant execute on function
  public.host_start_question(text, text, uuid, uuid, boolean), public.player_arm_joker(text, text, int),
  public.player_disarm_joker(text, text), public.player_use_fifty(text, text), public.host_get_game_stats(text, text)
to anon, authenticated;

-- ---------------------------------------------------------------------
-- Speicher: Audio-Dateien zulassen (bis 15 MB)
-- ---------------------------------------------------------------------
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    update storage.buckets set
      file_size_limit = 15728640,
      allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/gif',
        'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/webm']
    where id = 'quiz-question-images';
  end if;
end $$;
