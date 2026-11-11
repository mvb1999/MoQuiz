"""Funktionstests der MOQUIZ-Datenbank mit Supabase-ähnlichen Rollen."""
import json, os, sys, psycopg

# Verbindung über die üblichen Umgebungsvariablen (PGHOST, PGPORT, PGPASSWORD); siehe run.sh
HOST, PORT = os.environ.get('PGHOST', 'localhost'), os.environ.get('PGPORT', '5432')
DB = os.environ.get('MOQUIZ_TEST_DB', 'moquiz_test')
def dsn(user):
    pw = 'moquiz-test' if user == 'owner' else os.environ.get('PGPASSWORD', '')
    return f"host={HOST} port={PORT} dbname={DB} user={user}" + (f" password={pw}" if pw else '')
DSN = dsn('owner')
U1 = '11111111-1111-1111-1111-111111111111'
U2 = '22222222-2222-2222-2222-222222222222'
fails = 0

def call(role, sql, params=(), uid=None, expect_error=None):
    global fails
    with psycopg.connect(DSN, autocommit=True) as c:
        cur = c.cursor()
        cur.execute(f"set role {role}")
        if uid: cur.execute("select set_config('request.jwt.claims', %s, false)", (json.dumps({'sub': uid}),))
        try:
            cur.execute(sql, params)
            rows = cur.fetchall() if cur.description else None
            if expect_error:
                fails += 1; print('FAIL (kein Fehler erwartet:', expect_error, ')', sql)
            return rows
        except psycopg.Error as e:
            msg = (e.diag.message_primary or str(e))
            if expect_error and expect_error.lower() in msg.lower():
                return msg
            fails += 1; print('FAIL', sql, '->', msg); return None

def check(cond, label):
    global fails
    if cond: print('OK  ', label)
    else: fails += 1; print('FAIL', label)

# ---------- Rechte ----------
call('anon', "select * from private.quiz_sets", expect_error='permission denied')
call('anon', "insert into public.rooms(code) values ('ABCD')", expect_error='permission denied')
call('anon', "select * from public.create_room()", expect_error='permission denied')
call('anon', "select * from public.list_my_quiz_sets()", expect_error='permission denied')
call('authenticated', "select private.random_code()", uid=U1, expect_error='permission denied')
cols = call('anon', "select column_name from information_schema.columns where table_schema='public' and table_name='rooms'")
check(cols is not None and not any('secret' in r[0] for r in cols), 'rooms enthält keine Geheimnisse')

# ---------- Quiz erstellen ----------
qid = call('authenticated', "select quiz_set_id from public.create_quiz_set(%s)", ('Testquiz',), uid=U1)[0][0]
board = [
  {"title": "Geografie", "questions": [
    {"prompt": "Welche Stadt liegt am Bielersee?", "correct_answer": "Biel / Bienne", "image_url": None, "points": 100, "question_type": "all", "duration_seconds": 30},
    {"prompt": "Fluss in Basel?\n\nA) Aare\nB) Rhein", "correct_answer": "B) Rhein", "image_url": "https://x.supabase.co/a.png", "points": 200, "question_type": "buzzer", "duration_seconds": 20},
    {"prompt": "Team-Frage", "correct_answer": "x", "image_url": "javascript:alert(1)", "points": 300, "question_type": "team", "duration_seconds": 3},
  ]},
  {"title": "", "questions": [{"prompt": "Q", "correct_answer": "A", "points": "abc"}]},
]
call('authenticated', "select public.save_quiz_set(%s, '', 'Testquiz 2', %s::jsonb)", (qid, json.dumps(board[:1])), uid=U1)
call('authenticated', "select public.save_quiz_set(%s, '', 'X', %s::jsonb)", (qid, json.dumps(board)), uid=U1, expect_error='invalid input syntax')
call('authenticated', "select public.save_quiz_set(%s, '', 'Testquiz 2', %s::jsonb)", (qid, json.dumps(board[:1] + [{"title": "", "questions": [{"prompt": "Q", "correct_answer": "A"}]}])), uid=U1)
call('authenticated', "select public.save_quiz_set(%s, '', 'Hack', '[]'::jsonb)", (qid,), uid=U2, expect_error='Quiz nicht gefunden')
lst = call('authenticated', "select * from public.list_my_quiz_sets()", uid=U1)
check(lst and lst[0][1] == 'Testquiz 2', 'Liste zeigt eigenes Quiz')
check(call('authenticated', "select count(*) from public.list_my_quiz_sets()", uid=U2)[0][0] == 0, 'fremde Quiz unsichtbar')
ed = call('authenticated', "select public.get_quiz_set_for_edit(%s, '')", (qid,), uid=U1)[0][0]
qs = ed['categories'][0]['questions']
check(ed['categories'][1]['title'] == 'Kategorie 2', 'leerer Kategoriename wird ersetzt')
check(qs[2]['image_url'] is None and qs[2]['duration_seconds'] == 5, 'unsichere Bild-URL entfernt, Zeit begrenzt')
check(qs[1]['prompt'].endswith('B) Rhein') and qs[1]['correct_answer'] == 'B) Rhein', 'Multiple Choice bleibt erhalten')
call('authenticated', "select public.get_quiz_set_for_edit(%s, '')", (qid,), uid=U2, expect_error='Quiz nicht gefunden')

# ---------- Raum ----------
room = call('authenticated', "select * from public.create_room()", uid=U1)[0]
rid, code, sec = room
check(len(code) == 4 and len(sec) == 64, f'Raum erstellt ({code})')
call('anon', "select public.host_select_quiz(%s, 'falsch', %s)", (code, qid), expect_error='Kein Zugriff')
other = call('authenticated', "select quiz_set_id from public.create_quiz_set('Fremd')", uid=U2)[0][0]
call('anon', "select public.host_select_quiz(%s, %s, %s)", (code, sec, other), expect_error='Quiz nicht gefunden')
call('anon', "select public.host_select_quiz(%s, %s, %s)", (code, sec, qid))
b = call('anon', "select public.host_get_board(%s, %s)", (code, sec))[0][0]
check(len(b['categories']) == 2 and 'correct_answer' not in json.dumps(b), 'Board ohne Lösungen')
q_all, q_buzz, q_team = [q['id'] for q in b['categories'][0]['questions']]

# ---------- Teams ----------
t1 = call('anon', "select * from public.join_room(%s, %s)", (code.lower(), '🦊 Die Quizzards'))[0]
t2 = call('anon', "select * from public.join_room(%s, %s)", (code, '🐼   Team  Fondue '))[0]
call('anon', "select * from public.join_room(%s, %s)", (code, '🦊 die quizzards'), expect_error='schon vergeben')
call('anon', "select * from public.join_room('ZZZZ', 'x')", expect_error='Raum nicht gefunden')
call('anon', "select * from public.join_room(%s, '   ')", (code,), expect_error='Teamnamen')
names = call('anon', "select name from public.teams where room_id = %s order by joined_at", (rid,))
check([n[0] for n in names] == ['🦊 Die Quizzards', '🐼 Team Fondue'], 'Teamnamen bereinigt')
T1, TOK1 = t1[1], t1[2]; T2, TOK2 = t2[1], t2[2]

# ---------- Frage: Alle antworten ----------
call('anon', "select public.host_start_question(%s, %s, %s, null)", (code, sec, q_all))
r = call('anon', "select phase, question_ends_at is not null, active_question_id from public.rooms where id = %s", (rid,))[0]
check(r[0] == 'question' and r[1] and str(r[2]) == q_all, 'Frage läuft mit Timer')
pq = call('anon', "select public.player_get_active_question(%s, %s)", (code, TOK1))[0][0]
check(pq['category_title'] == 'Geografie' and 'correct_answer' not in pq and pq['has_buzzed'] is False, 'Spieler sieht Frage ohne Lösung')
call('anon', "select public.player_get_active_question(%s, 'falsch')", (code,), expect_error='nicht mehr in diesem Raum')
call('anon', "select public.submit_answer(%s, %s, 'biel')", (code, TOK1))
call('anon', "select public.submit_answer(%s, %s, 'nochmal')", (code, TOK1), expect_error='schon geantwortet')
call('anon', "select public.submit_answer(%s, %s, 'Bern')", (code, TOK2))
mine = call('anon', "select * from public.get_my_submission(%s, %s)", (code, TOK1))
check(mine and mine[0][0] == 'biel', 'eigene Antwort abrufbar')
subs = call('anon', "select * from public.host_get_submissions(%s, %s)", (code, sec))
check(len(subs) == 2, 'Host sieht beide Antworten')
det = call('anon', "select * from public.host_get_question_details(%s, %s, %s)", (code, sec, q_all))
check(det[0][0] == 'Biel / Bienne', 'Host sieht Lösung')
call('anon', "select public.host_reveal_answers(%s, %s)", (code, sec))
call('anon', "select public.host_grade_submission(%s, %s, %s, 100)", (code, sec, T1))
call('anon', "select public.host_grade_submission(%s, %s, %s, 100)", (code, sec, T1))
call('anon', "select public.host_grade_submission(%s, %s, %s, -100)", (code, sec, T2))
call('anon', "select public.host_grade_submission(%s, %s, %s, 0)", (code, sec, T2))
sc = dict(call('anon', "select id::text, score from public.teams where room_id = %s", (rid,)))
check(sc[T1 if isinstance(T1, str) else str(T1)] == 100 and sc[str(T2)] == 0, 'Neu bewerten ersetzt die Punkte (100 / 0)')
call('anon', "select public.host_toggle_pause(%s, %s)", (code, sec))
p = call('anon', "select question_paused, paused_remaining_seconds from public.rooms where id = %s", (rid,))[0]
check(p[0] and 25 <= p[1] <= 30, 'Pause speichert Restzeit')
call('anon', "select public.host_add_time(%s, %s, 10)", (code, sec))
call('anon', "select public.host_toggle_pause(%s, %s)", (code, sec))
left = call('anon', "select extract(epoch from question_ends_at - now()) from public.rooms where id = %s", (rid,))[0][0]
check(35 <= float(left) <= 41, 'Weiter mit +10 Sekunden')
call('anon', "select public.host_finish_question(%s, %s)", (code, sec))
used = call('anon', "select * from public.host_get_used_questions(%s, %s)", (code, sec))
check([str(u[0]) for u in used] == [q_all], 'gespielte Frage gemerkt')

# ---------- Buzzer ----------
call('anon', "select public.host_start_question(%s, %s, %s, null)", (code, sec, q_buzz))
call('anon', "select public.submit_answer(%s, %s, 'x')", (code, TOK1), expect_error='zuerst gebuzzert')
call('anon', "select public.buzz(%s, %s)", (code, TOK1))
call('anon', "select public.buzz(%s, %s)", (code, TOK2), expect_error='gesperrt')
r = call('anon', "select buzzer_winner_team_id::text, buzzer_open, question_ends_at is not null from public.rooms where id = %s", (rid,))[0]
check(r[0] == str(T1) and r[1] is False and r[2], 'Buzzer-Gewinner, Timer startet')
call('anon', "select public.host_grade_submission(%s, %s, %s, -200)", (code, sec, T1))
call('anon', "select public.host_reopen_buzzer(%s, %s)", (code, sec))
call('anon', "select public.buzz(%s, %s)", (code, TOK1), expect_error='schon gebuzzert')
hb = call('anon', "select public.player_get_active_question(%s, %s)", (code, TOK1))[0][0]
check(hb['has_buzzed'] is True, 'has_buzzed für Team 1')
call('anon', "select public.buzz(%s, %s)", (code, TOK2))
call('anon', "select public.submit_answer(%s, %s, 'B) Rhein')", (code, TOK2))
call('anon', "select public.host_close_buzzer(%s, %s)", (code, sec))
call('anon', "select public.host_finish_question(%s, %s)", (code, sec))

# ---------- Ein Team ----------
call('anon', "select public.host_start_question(%s, %s, %s, null)", (code, sec, q_team), expect_error='Team für diese Frage')
call('anon', "select public.host_start_question(%s, %s, %s, %s)", (code, sec, q_team, T2))
call('anon', "select public.submit_answer(%s, %s, 'x')", (code, TOK1), expect_error='anderes Team')
call('anon', "select public.submit_answer(%s, %s, 'x')", (code, TOK2))
call('anon', "select public.host_award_points(%s, %s, %s, 100)", (code, sec, T2))
call('anon', "select public.host_finish_question(%s, %s)", (code, sec))

# ---------- Zeit abgelaufen ----------
call('postgres' if False else 'anon', "select 1")
with psycopg.connect(dsn(os.environ.get('PGUSER', 'postgres')), autocommit=True) as c:
    c.execute("update public.rooms set active_question_id = %s, phase='question', question_ends_at = now() - interval '10 seconds' where id = %s", (q_all, rid))
call('anon', "select public.submit_answer(%s, %s, 'spät')", (code, TOK2), expect_error='Zeit ist abgelaufen')
call('anon', "select public.host_finish_question(%s, %s)", (code, sec))

# ---------- Löschen ----------
call('authenticated', "select public.delete_quiz_set(%s, '')", (qid,), uid=U2, expect_error='Quiz nicht gefunden')
call('authenticated', "select public.delete_quiz_set(%s, '')", (qid,), uid=U1)
r = call('anon', "select quiz_set_id from public.rooms where id = %s", (rid,))[0]
check(r[0] is None, 'Raum verliert gelöschtes Quiz')
final = call('anon', "select name, score from public.teams where room_id = %s order by joined_at", (rid,))
print('Punkte:', final)
check([s for _, s in final] == [-100, 100], 'Endpunkte stimmen (Team 1: 100 - 200, Team 2: 0 + 100)')

# =================== Version 2: Joker, 50:50, Audio, Rückblick ===================
qid2 = call('authenticated', "select quiz_set_id from public.create_quiz_set('V2')", uid=U1)[0][0]
board2 = [{"title": "Mix", "questions": [
  {"prompt": "Normale Frage", "correct_answer": "ja", "points": 100, "question_type": "all", "duration_seconds": 30, "audio_url": "https://x.supabase.co/song.mp3"},
  {"prompt": "Fluss?\n\nA) Aare\nB) Rhein\nC) Rhone\nD) Limmat", "correct_answer": "B) Rhein", "points": 200, "question_type": "all", "duration_seconds": 30, "audio_url": "http://unsicher.mp3"},
  {"prompt": "Buzzer", "correct_answer": "x", "points": 300, "question_type": "buzzer", "duration_seconds": 30},
  {"prompt": "Team", "correct_answer": "x", "points": 400, "question_type": "team", "duration_seconds": 30},
  {"prompt": "Final", "correct_answer": "x", "points": 500, "question_type": "all", "duration_seconds": 30},
]}]
call('authenticated', "select public.save_quiz_set(%s, '', 'V2', %s::jsonb)", (qid2, json.dumps(board2)), uid=U1)
ed2 = call('authenticated', "select public.get_quiz_set_for_edit(%s, '')", (qid2,), uid=U1)[0][0]
check(ed2['categories'][0]['questions'][0]['audio_url'] == 'https://x.supabase.co/song.mp3' and ed2['categories'][0]['questions'][1]['audio_url'] is None, 'Audio gespeichert, unsichere Audio-URL verworfen')
rm2 = call('authenticated', "select * from public.create_room()", uid=U1)[0]; rid2, code2, sec2 = rm2
a = call('anon', "select * from public.join_room(%s, 'Alpha')", (code2,))[0]; b = call('anon', "select * from public.join_room(%s, 'Beta')", (code2,))[0]
A, TA, B, TB = str(a[1]), a[2], str(b[1]), b[2]
call('anon', "select public.player_arm_joker(%s, %s, 50)", (code2, TA), expect_error='noch nicht begonnen')
call('anon', "select public.host_select_quiz(%s, %s, %s)", (code2, sec2, qid2))
bd = call('anon', "select public.host_get_board(%s, %s)", (code2, sec2))[0][0]
QS = [q['id'] for q in bd['categories'][0]['questions']]
check(bd['categories'][0]['questions'][0]['audio_url'] == 'https://x.supabase.co/song.mp3', 'Host-Board enthält Audio')
call('anon', "select public.player_arm_joker(%s, %s, 50)", (code2, TA), expect_error='zuerst Punkte')
with psycopg.connect(dsn(os.environ.get('PGUSER', 'postgres')), autocommit=True) as c:
    c.execute("update public.teams set score = 300 where room_id = %s", (rid2,))
call('anon', "select public.player_arm_joker(%s, %s, 400)", (code2, TA), expect_error='zwischen 1 und 300')
call('anon', "select public.player_arm_joker(%s, %s, 250)", (code2, TA))
call('anon', "select public.player_arm_joker(%s, %s, 200)", (code2, TA))
st = call('anon', "select joker_state, joker_amount from public.teams where id = %s", (A,))[0]
check(st == ('armed', 200), 'Joker gesetzt und Einsatz geändert (200)')
# Frage 1 (alle): Joker wird eingesetzt
call('anon', "select public.host_start_question(%s, %s, %s, null)", (code2, sec2, QS[0]))
call('anon', "select public.player_arm_joker(%s, %s, 10)", (code2, TB), expect_error='zwischen den Fragen')
st = call('anon', "select joker_state, joker_amount, joker_question_id::text from public.teams where id = %s", (A,))[0]
check(st == ('used', 200, QS[0]), 'Joker bei Fragestart eingesetzt')
pq = call('anon', "select public.player_get_active_question(%s, %s)", (code2, TA))[0][0]
check(pq['has_audio'] is True and 'audio_url' not in pq, 'Spieler weiss von Audio, ohne Datei-Link')
call('anon', "select public.player_use_fifty(%s, %s)", (code2, TA), expect_error='Multiple-Choice')
call('anon', "select public.host_grade_submission(%s, %s, %s, 200)", (code2, sec2, A))
call('anon', "select public.host_finish_question(%s, %s)", (code2, sec2))
call('anon', "select public.player_arm_joker(%s, %s, 100)", (code2, TA), expect_error='schon eingesetzt')
# Frage 2 (MC): 50:50
call('anon', "select public.host_start_question(%s, %s, %s, null)", (code2, sec2, QS[1]))
hid = call('anon', "select public.player_use_fifty(%s, %s)", (code2, TB))[0][0]
check(len(hid) == 2 and 'B' not in hid, f'50:50 blendet zwei falsche Antworten aus {hid}')
pq = call('anon', "select public.player_get_active_question(%s, %s)", (code2, TB))[0][0]
check(sorted(pq['fifty_hidden']) == sorted(hid), '50:50 bleibt nach Neuladen erhalten')
pa = call('anon', "select public.player_get_active_question(%s, %s)", (code2, TA))[0][0]
check(pa['fifty_hidden'] == [], 'andere Teams sehen das 50:50-Ergebnis nicht')
call('anon', "select public.player_use_fifty(%s, %s)", (code2, TB), expect_error='schon eingesetzt')
cols = [r[0] for r in call('anon', "select column_name from information_schema.columns where table_schema='public' and table_name='teams'")]
check('fifty_used' in cols and not any('hidden' in c for c in cols), 'teams zeigt nur, ob 50:50 benutzt wurde')
call('anon', "select public.host_finish_question(%s, %s)", (code2, sec2))
# Buzzer: Joker erst beim Buzzern
call('anon', "select public.player_arm_joker(%s, %s, 100)", (code2, TB))
call('anon', "select public.host_start_question(%s, %s, %s, null)", (code2, sec2, QS[2]))
check(call('anon', "select joker_state from public.teams where id = %s", (B,))[0][0] == 'armed', 'Buzzer: Joker wartet bis zum Buzzern')
call('anon', "select public.buzz(%s, %s)", (code2, TB))
check(call('anon', "select joker_state, joker_question_id::text from public.teams where id = %s", (B,))[0] == ('used', QS[2]), 'Buzzer: Joker beim Buzzern eingesetzt')
call('anon', "select public.host_finish_question(%s, %s)", (code2, sec2))
# Finalrunde: kein Joker-Verbrauch
with psycopg.connect(dsn(os.environ.get('PGUSER', 'postgres')), autocommit=True) as c:
    c.execute("update public.teams set joker_state = 'armed', joker_amount = 50 where id = %s", (B,))
call('anon', "select public.host_start_question(%s, %s, %s, null, true)", (code2, sec2, QS[4]))
check(call('anon', "select joker_state from public.teams where id = %s", (B,))[0][0] == 'armed', 'Finalrunde verbraucht keinen Joker')
call('anon', "select public.player_disarm_joker(%s, %s)", (code2, TB), expect_error='zwischen den Fragen')
call('anon', "select public.host_finish_question(%s, %s)", (code2, sec2))
call('anon', "select public.player_disarm_joker(%s, %s)", (code2, TB))
check(call('anon', "select joker_state from public.teams where id = %s", (B,))[0][0] == 'available', 'Joker zurückgenommen')
# Rückblick
stats = call('anon', "select public.host_get_game_stats(%s, %s)", (code2, sec2))[0][0]
check(len(stats['questions']) == 4 and any(r['points_awarded'] == 200 for r in stats['results']) and len(stats['buzzes']) == 1, 'Rückblick liefert Fragen, Ergebnisse und Buzzer')
call('anon', "select public.host_get_game_stats(%s, 'falsch')", (code2,), expect_error='Kein Zugriff')

print('FEHLER:', fails); sys.exit(1 if fails else 0)
