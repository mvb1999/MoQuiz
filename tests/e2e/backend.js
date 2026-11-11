// Nachgebildetes Supabase-Backend für die Oberflächentests, dazu ein kleiner
// Webserver, der die Vercel-Weiterleitung (/ABCD -> index.html) nachahmt.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.MOQUIZ_TEST_PORT || 4173);
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

// Ton (4 s, 440 Hz) als WAV für die Hörfragen-Tests
function testTone() {
  const rate = 8000, n = Math.round(rate * 4), buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 8000), 44 + i * 2);
  return buf;
}

function startServer(port = PORT) {
  const tone = testTone();
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/__test/ton.wav') { res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': tone.length }); res.end(tone); return; }
    if (p === '/' || /^\/[A-Za-z0-9]{4}$/.test(p)) p = '/index.html';
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(port, () => r(server)));
}

const uid = (p) => p + Math.random().toString(36).slice(2, 10);
const now = () => Date.now();

function createWorld() {
  const W = { rooms: {}, teams: {}, subs: {}, quizSets: {}, buzzed: {}, buzzMs: {}, used: {}, usedAt: {}, fifty: {}, startedAt: {}, pages: [], log: [] };

  // ---------- sample quiz ----------
  const qs = { id: 'quiz1', title: 'Freitagabend Quiz', owner: 'u1', categories: [] };
  const cats = ['Geografie', 'Musik', 'Film & Serien', 'Sport', 'Schweiz'];
  qs.categories = cats.map((t, ci) => ({
    id: 'c' + ci, quiz_set_id: 'quiz1', title: t, position: ci,
    questions: [1, 2, 3, 4, 5].map(p => ({
      id: `c${ci}q${p}`, category_id: 'c' + ci, position: p, points: p * 100, image_url: null, duration_seconds: 30,
      question_type: 'all', prompt: `Frage ${t} ${p * 100}`, correct_answer: 'Biel / Bienne',
    })),
  }));
  const set = (id, patch) => Object.assign(qs.categories.flatMap(c => c.questions).find(q => q.id === id), patch);
  set('c0q1', { prompt: 'Welche Stadt liegt am Bielersee?', correct_answer: 'Biel / Bienne' });
  set('c0q2', { prompt: 'Welcher Fluss fliesst durch Basel?\n\nA) Aare\nB) Rhein\nC) Rhone\nD) Limmat', correct_answer: 'B) Rhein' });
  set('c0q3', { prompt: 'Wie hoch ist das Matterhorn in Metern?', correct_answer: '4478' });
  set('c1q1', { prompt: 'Wer singt «Hallelujah» im Original?', question_type: 'buzzer', correct_answer: 'Leonard Cohen' });
  set('c2q1', { prompt: 'In welcher Stadt spielt «Breaking Bad»?', question_type: 'team', correct_answer: 'Albuquerque' });
  set('c4q5', { prompt: 'In welchem Jahr wurde die Eidgenossenschaft gegründet?', correct_answer: '1291' });
  set('c1q2', { prompt: 'Wie heisst dieser Ton?', correct_answer: 'A', audio_url: `http://localhost:${PORT}/__test/ton.wav` });
  W.quizSets.quiz1 = qs;
  const allQ = () => Object.values(W.quizSets).flatMap(s => s.categories.flatMap(c => c.questions.map(q => ({ ...q, category_title: c.title }))));

  // ---------- helpers ----------
  const err = (m) => ({ data: null, error: { message: m } });
  const ok = (d) => ({ data: d, error: null });
  const roomByCode = (code) => Object.values(W.rooms).find(r => r.code === code);
  const hostRoom = (a) => { const r = roomByCode(a.p_code); return r && r.host_secret === a.p_host_secret ? r : null; };
  const teamByToken = (r, tok) => Object.values(W.teams).find(t => t.room_id === r.id && t.team_token === tok);
  const subKey = (r, teamId) => `${r.id}:${r.active_question_id}:${teamId}`;
  const roomPublic = (r) => { const { host_secret, ...rest } = r; return rest; };
  const teamPublic = (t) => { const { team_token, ...rest } = t; return rest; };
  let codeN = 0;

  async function notify(table, roomId) {
    for (const p of W.pages) { if (!p.isClosed()) p.evaluate(([t, r]) => window.__mockNotify && window.__mockNotify(t, r), [table, roomId]).catch(() => {}); }
  }

  const rpc = {
    'select:rooms': (q) => { const r = W.rooms[q.filters.id]; return r ? ok(roomPublic(r)) : { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } }; },
    'select:teams': (q) => ok(Object.values(W.teams).filter(t => t.room_id === q.filters.room_id).sort((a, b) => a.joined_at.localeCompare(b.joined_at)).map(teamPublic)),
    list_my_quiz_sets: () => ok(Object.values(W.quizSets).map(s => ({ id: s.id, title: s.title }))),
    claim_legacy_quiz_set: () => ok(false),
    create_room: () => {
      const id = uid('room'); const code = ['K7QF', 'ZX42', 'MOQZ'][codeN++] || uid('').slice(0, 4).toUpperCase();
      W.rooms[id] = { id, code, host_secret: uid('sec'), phase: 'lobby', quiz_set_id: null, active_question_id: null, active_team_id: null, question_ends_at: null, question_paused: false, paused_remaining_seconds: null, question_revealed: false, buzzer_open: false, buzzer_round: 0, buzzer_winner_team_id: null };
      W.used[id] = new Set();
      return ok([{ room_id: id, code, host_secret: W.rooms[id].host_secret }]);
    },
    join_room: (a) => {
      const r = roomByCode(a.p_code); if (!r) return err('Raum nicht gefunden.');
      if (Object.values(W.teams).some(t => t.room_id === r.id && t.name.toLowerCase() === a.p_name.toLowerCase())) return err('Dieser Teamname ist schon vergeben.');
      const t = { id: uid('team'), room_id: r.id, name: a.p_name, score: 0, joined_at: new Date(now() + Object.keys(W.teams).length).toISOString(), team_token: uid('tok'), joker_state: 'available', joker_amount: null, joker_question_id: null, fifty_used: false };
      W.teams[t.id] = t; notify('teams', r.id);
      return ok([{ room_id: r.id, team_id: t.id, team_token: t.team_token }]);
    },
    host_select_quiz: (a) => { const r = hostRoom(a); if (!r) return err('Kein Zugriff'); r.quiz_set_id = a.p_quiz_set_id; r.phase = a.p_quiz_set_id ? 'board' : 'lobby'; notify('rooms', r.id); return ok(null); },
    host_get_board: (a) => { const r = hostRoom(a); if (!r) return err('Kein Zugriff'); const s = W.quizSets[r.quiz_set_id]; return ok({ categories: s.categories.map(c => ({ ...c, questions: c.questions.map(({ correct_answer, ...q }) => q) })) }); },
    host_get_used_questions: (a) => { const r = hostRoom(a); if (!r) return err('Kein Zugriff'); return ok([...W.used[r.id]].map(question_id => ({ question_id }))); },
    host_start_question: (a) => {
      const r = hostRoom(a); if (!r) return err('Kein Zugriff'); const q = allQ().find(x => x.id === a.p_question_id);
      Object.assign(r, { active_question_id: q.id, active_team_id: a.p_team_id || null, question_revealed: false, question_paused: false, paused_remaining_seconds: null, buzzer_winner_team_id: null });
      if (q.question_type === 'buzzer') Object.assign(r, { phase: 'buzzer', buzzer_open: true, buzzer_round: 1, question_ends_at: null });
      else Object.assign(r, { phase: 'question', buzzer_open: false, buzzer_round: 0, question_ends_at: new Date(now() + q.duration_seconds * 1000).toISOString() });
      W.used[r.id].add(q.id); W.usedAt[r.id + ':' + q.id] = new Date().toISOString(); W.buzzed[r.id] = new Set(); W.startedAt[r.id] = now();
      if (!a.p_no_joker && q.question_type !== 'buzzer') {
        for (const t of Object.values(W.teams)) {
          if (t.room_id !== r.id || t.joker_state !== 'armed') continue;
          if (q.question_type === 'team' && t.id !== a.p_team_id) continue;
          Object.assign(t, { joker_state: 'used', joker_question_id: q.id, joker_amount: Math.max(0, Math.min(t.joker_amount || 0, t.score)) });
        }
        notify('teams', r.id);
      }
      notify('rooms', r.id); return ok(null);
    },
    host_finish_question: (a) => { const r = hostRoom(a); Object.assign(r, { active_question_id: null, active_team_id: null, phase: 'board', question_ends_at: null, buzzer_winner_team_id: null, buzzer_open: false }); notify('rooms', r.id); return ok(null); },
    host_close_buzzer: (a) => { const r = hostRoom(a); r.buzzer_open = false; notify('rooms', r.id); return ok(null); },
    host_reopen_buzzer: (a) => { const r = hostRoom(a); Object.assign(r, { buzzer_open: true, buzzer_winner_team_id: null, buzzer_round: r.buzzer_round + 1, question_ends_at: null }); notify('rooms', r.id); return ok(null); },
    buzz: (a) => {
      const r = roomByCode(a.p_code); const t = teamByToken(r, a.p_team_token);
      if (!r.buzzer_open || r.buzzer_winner_team_id) return err('Zu spät, jemand war schneller.');
      if (W.buzzed[r.id].has(t.id)) return err('Du hast schon gebuzzert.');
      W.buzzed[r.id].add(t.id); const q = allQ().find(x => x.id === r.active_question_id);
      (W.buzzMs[r.id] ||= []).push({ team_id: t.id, question_id: q.id, ms: now() - (W.startedAt[r.id] || now()) });
      Object.assign(r, { buzzer_winner_team_id: t.id, buzzer_open: false, question_ends_at: new Date(now() + q.duration_seconds * 1000).toISOString() });
      if (t.joker_state === 'armed') { Object.assign(t, { joker_state: 'used', joker_question_id: q.id, joker_amount: Math.max(0, Math.min(t.joker_amount || 0, t.score)) }); notify('teams', r.id); }
      notify('rooms', r.id); return ok(null);
    },
    player_get_active_question: (a) => {
      const r = roomByCode(a.p_code); const t = teamByToken(r, a.p_team_token); const q = allQ().find(x => x.id === r.active_question_id); if (!q) return ok(null);
      const { correct_answer, audio_url, ...pub } = q;
      return ok({ ...pub, has_audio: !!audio_url, has_buzzed: W.buzzed[r.id]?.has(t.id) || false, fifty_hidden: W.fifty[`${r.id}:${q.id}:${t.id}`] || [] });
    },
    host_get_question_details: (a) => { const q = allQ().find(x => x.id === a.p_question_id); return ok([{ correct_answer: q.correct_answer }]); },
    host_get_submissions: (a) => { const r = hostRoom(a); return ok(Object.entries(W.subs).filter(([k]) => k.startsWith(`${r.id}:${r.active_question_id}:`)).map(([, s]) => s)); },
    get_my_submission: (a) => { const r = roomByCode(a.p_code); const t = teamByToken(r, a.p_team_token); const s = W.subs[subKey(r, t.id)]; return ok(s && s.submitted_at ? [s] : []); },
    submit_answer: (a) => {
      const r = roomByCode(a.p_code); const t = teamByToken(r, a.p_team_token); const k = subKey(r, t.id);
      if (W.subs[k]?.submitted_at) return err('Schon abgegeben');
      W.subs[k] = { team_id: t.id, answer_text: a.p_answer, submitted_at: new Date().toISOString(), points_awarded: 0 };
      W.log.push(['submit', t.name, a.p_answer]);
      notify('rooms', r.id); return ok(null);
    },
    host_reveal_answers: (a) => { const r = hostRoom(a); r.question_revealed = true; notify('rooms', r.id); return ok(null); },
    host_add_time: (a) => { const r = hostRoom(a); if (r.question_paused) r.paused_remaining_seconds += a.p_seconds; else r.question_ends_at = new Date(new Date(r.question_ends_at).getTime() + a.p_seconds * 1000).toISOString(); notify('rooms', r.id); return ok(null); },
    host_toggle_pause: (a) => {
      const r = hostRoom(a);
      if (r.question_paused) Object.assign(r, { question_paused: false, question_ends_at: new Date(now() + r.paused_remaining_seconds * 1000).toISOString() });
      else Object.assign(r, { question_paused: true, paused_remaining_seconds: Math.max(0, Math.ceil((new Date(r.question_ends_at) - now()) / 1000)) });
      notify('rooms', r.id); return ok(null);
    },
    host_grade_submission: (a) => {
      const r = hostRoom(a); const k = subKey(r, a.p_team_id); const s = W.subs[k] || (W.subs[k] = { team_id: a.p_team_id, answer_text: null, submitted_at: null, points_awarded: 0 });
      W.teams[a.p_team_id].score += a.p_delta - (s.points_awarded || 0); s.points_awarded = a.p_delta;
      W.log.push(['grade', W.teams[a.p_team_id].name, a.p_delta]);
      notify('teams', r.id); notify('rooms', r.id); return ok(null);
    },
    host_award_points: (a) => { const r = hostRoom(a); W.teams[a.p_team_id].score += a.p_delta; notify('teams', r.id); return ok(null); },
    player_arm_joker: (a) => {
      const r = roomByCode(a.p_code); const t = teamByToken(r, a.p_team_token);
      if (r.active_question_id) return err('Den Joker könnt ihr nur zwischen den Fragen setzen.');
      if (t.joker_state === 'used') return err('Ihr habt euren Joker schon eingesetzt.');
      if (t.score <= 0) return err('Für den Joker braucht ihr zuerst Punkte.');
      if (!(a.p_amount >= 1 && a.p_amount <= t.score)) return err(`Der Einsatz muss zwischen 1 und ${t.score} Punkten liegen.`);
      Object.assign(t, { joker_state: 'armed', joker_amount: a.p_amount, joker_question_id: null }); W.log.push(['joker', t.name, a.p_amount]);
      notify('teams', r.id); return ok(null);
    },
    player_disarm_joker: (a) => {
      const r = roomByCode(a.p_code); const t = teamByToken(r, a.p_team_token);
      if (r.active_question_id) return err('Den Joker könnt ihr nur zwischen den Fragen zurücknehmen.');
      if (t.joker_state !== 'armed') return err('Der Joker ist nicht gesetzt oder schon eingesetzt.');
      Object.assign(t, { joker_state: 'available', joker_amount: null, joker_question_id: null }); notify('teams', r.id); return ok(null);
    },
    player_use_fifty: (a) => {
      const r = roomByCode(a.p_code); const t = teamByToken(r, a.p_team_token); const q = allQ().find(x => x.id === r.active_question_id);
      if (t.fifty_used) return err('Ihr habt den 50:50-Joker schon eingesetzt.');
      const letters = [...q.prompt.matchAll(/^\s*([A-F])\)\s+\S/gm)].map(m => m[1]); const correct = (q.correct_answer.match(/^([A-F])\)/) || [])[1];
      if (letters.length < 3 || !correct) return err('Der 50:50-Joker geht nur bei Multiple-Choice-Fragen mit mindestens drei Antworten.');
      const hidden = letters.filter(l => l !== correct).sort(() => Math.random() - .5).slice(0, letters.length - 2);
      W.fifty[`${r.id}:${q.id}:${t.id}`] = hidden; t.fifty_used = true; notify('teams', r.id); return ok(hidden);
    },
    host_get_game_stats: (a) => {
      const r = hostRoom(a); if (!r) return err('Kein Zugriff');
      const questions = [...W.used[r.id]].map(id => { const q = allQ().find(x => x.id === id); return { id, used_at: W.usedAt[r.id + ':' + id], points: q.points, category: q.category_title, question_type: q.question_type }; });
      const results = Object.entries(W.subs).filter(([k]) => k.startsWith(r.id + ':')).map(([k, s]) => ({ team_id: s.team_id, question_id: k.split(':')[1], points_awarded: s.points_awarded, submitted_at: s.submitted_at, graded: true }));
      return ok({ questions, results, buzzes: W.buzzMs[r.id] || [] });
    },
    get_quiz_set_for_edit: (a) => ok(W.quizSets[a.p_quiz_set_id]),
    create_quiz_set: (a) => { const id = uid('quiz'); W.quizSets[id] = { id, title: a.p_title, owner: 'u1', categories: [] }; return ok([{ quiz_set_id: id }]); },
    save_quiz_set: (a) => {
      const s = W.quizSets[a.p_quiz_set_id]; s.title = a.p_title;
      s.categories = a.p_board.map((c, ci) => { const cid = uid('c'); return { id: cid, quiz_set_id: s.id, title: c.title, position: ci, questions: c.questions.map((q, qi) => ({ ...q, id: uid('q'), category_id: cid, position: qi + 1 })) }; });
      W.log.push(['save', JSON.stringify(a.p_board)]);
      return ok(null);
    },
    delete_quiz_set: (a) => { delete W.quizSets[a.p_quiz_set_id]; return ok(null); },
  };

  // Attach a whole browser context (so popups opened via window.open work too).
  W.attachContext = async (context, { user = false, name = 'ctx' } = {}) => {
    const watch = (page) => {
      W.pages.push(page);
      page.on('pageerror', e => console.log(`[${name}] PAGEERROR`, e.message));
      page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) console.log(`[${name}] console.error`, m.text()); });
    };
    context.on('page', watch);
    await context.exposeBinding('__mockRpc', async (src, n, a) => {
      const f = rpc[n]; if (!f) { console.log('MISSING RPC', n); return err('missing rpc ' + n); }
      try { return JSON.parse(JSON.stringify(f(a))); } catch (e) { console.log('RPC ERROR', n, e); return err(String(e)); }
    });
    await context.exposeBinding('__mockSend', async (src, topic, event, payload) => {
      W.log.push(['bc', name, event, JSON.stringify(payload).slice(0, 160)]);
      for (const p of W.pages) { if (p !== src.page && !p.isClosed()) p.evaluate(([t, e, pl]) => window.__mockBroadcast && window.__mockBroadcast(t, e, pl), [topic, event, payload]).catch(() => {}); }
      return true;
    });
    if (user) await context.addInitScript(() => { window.__mockUser = { id: 'u1', user_metadata: { username: 'moritz' } }; });
    await context.addInitScript({ path: __dirname + '/mock-client.js' });
  };
  W.rpc = rpc;
  return W;
}

module.exports = { startServer, createWorld, PORT };
