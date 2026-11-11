'use strict';
/* MOQUIZ Frontend
   Backend: Supabase (RPC-Funktionen, Tabellen rooms und teams, Realtime)
   Hosting: Vercel (statisch, vercel.json leitet /ABCD auf index.html um)

   Rollen:
   - host:   Steuerung (Laptop oder Handy)
   - screen: Beamer-Ansicht ohne Lösungen und Steuerknöpfe (?beamer)
   - player: Teams auf dem Handy

   Zusätzlicher Zustand ohne Datenbank (Lösung zeigen, Rangliste, Überraschungsfelder,
   Finalrunde, Siegerehrung) wird vom Host über einen Supabase-Broadcast-Kanal verteilt. */

/* =========================================================
   Konfiguration
   ========================================================= */
const SUPABASE_URL = 'https://ottfpxtkgjkesidwfoxn.supabase.co';
const SUPABASE_KEY = 'sb_publishable_QL_3phtu_z8r8NMaIhBtig_yvxyOV6V';
const SUPABASE_SCRIPTS = ['https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2', 'https://unpkg.com/@supabase/supabase-js@2'];
const TEAM_EMOJIS = ['🦊', '🐙', '🦄', '🐸', '🐼', '🦁', '🐝', '🐧', '🦖', '🍕', '🚀', '🔥'];
const MC_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
const SESSION_KEY = 'quizDuellSession';
const OWNER_SECRETS_KEY = 'quizDuellOwnerSecrets';

/* =========================================================
   Hilfsfunktionen
   ========================================================= */
const $ = id => document.getElementById(id);
const safe = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
const normaliseCode = v => String(v ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
const typeLabel = t => ({ buzzer: 'Buzzer', all: 'Alle antworten', team: 'Ein Team' }[t] || t);
const TYPE_HELP = {
  all: 'Alle Teams antworten gleichzeitig auf dem Handy.',
  team: 'Du wählst beim Start ein Team aus, nur dieses antwortet.',
  buzzer: 'Wer zuerst buzzert, darf antworten. Bei falscher Antwort kannst du den Buzzer neu freigeben.',
};
function storageGet(key) { try { return window.localStorage?.getItem(key) ?? null; } catch { return null; } }
function storageSet(key, value) { try { window.localStorage?.setItem(key, value); return true; } catch { return false; } }
function storageRemove(key) { try { window.localStorage?.removeItem(key); return true; } catch { return false; } }
function storageJson(key, fallback) { try { const v = JSON.parse(storageGet(key) || 'null'); return v ?? fallback; } catch { return fallback; } }
function setMsg(id, text = '') { const el = $(id); if (el) el.textContent = text; }
function toast(text, ms = 2200) { const el = $('toast'); el.textContent = text; el.classList.remove('hidden'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.add('hidden'), ms); }
function formatTime(sec) { if (sec == null) return '--:--'; const s = Math.max(0, sec), m = Math.floor(s / 60), r = s % 60; return String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0'); }
const signed = n => (n > 0 ? '+' : n < 0 ? '−' : '±') + Math.abs(n);
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
function errText(e) { return e?.message || String(e || 'Unbekannter Fehler'); }

/* Einfaches Cache für innerHTML, damit Eingaben, Fokus und Animationen erhalten bleiben */
const viewCache = {};
function setHtml(id, html) {
  const el = $(id); if (!el) return false;
  if (viewCache[id] === html && el.innerHTML) return false;
  viewCache[id] = html; el.innerHTML = html; return true;
}

/* =========================================================
   Datenbank
   ========================================================= */
let db = null, supabaseLoadPromise = null;
function loadExternalScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true; s.onload = () => resolve(); s.onerror = () => { s.remove(); reject(new Error('Script konnte nicht geladen werden')); };
    document.head.appendChild(s);
  });
}
async function ensureDb() {
  if (db) return db;
  if (window.supabase) { db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY); return db; }
  if (!supabaseLoadPromise) {
    supabaseLoadPromise = (async () => {
      let lastError = null;
      for (const src of SUPABASE_SCRIPTS) { try { await loadExternalScript(src); if (window.supabase) break; } catch (e) { lastError = e; } }
      if (!window.supabase) throw lastError || new Error('Supabase konnte nicht geladen werden');
      db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
      return db;
    })();
  }
  try { return await supabaseLoadPromise; } catch (e) { supabaseLoadPromise = null; throw e; }
}
const connectionErrorText = () => 'Verbindung konnte nicht hergestellt werden. Prüfe die Internetverbindung und lade die Seite neu.';
/* RPC mit einheitlicher Fehlerbehandlung: wirft bei Fehler */
async function rpc(name, args) {
  try { await ensureDb(); } catch { throw new Error(connectionErrorText()); }
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error(error.message || 'Fehler bei ' + name);
  return data;
}
const hostArgs = (extra = {}) => ({ p_code: current.code, p_host_secret: current.hostSecret, ...extra });
const teamArgs = (extra = {}) => ({ p_code: current.code, p_team_token: current.teamToken, ...extra });

/* =========================================================
   Ton und Vibration
   ========================================================= */
const Sfx = (() => {
  let ctx = null, enabled = storageGet('moquizSound') !== 'off';
  function ensure() {
    if (!ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null; try { ctx = new AC(); } catch { return null; } }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }
  function tone(freq, dur, { type = 'sine', vol = .2, delay = 0, slide = null } = {}) {
    const c = ensure(); if (!c || c.state !== 'running') return;
    const t = c.currentTime + delay, o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t); if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur + 0.05);
  }
  const sounds = {
    tick: () => tone(880, .07, { type: 'square', vol: .06 }),
    end: () => { tone(220, .5, { type: 'sawtooth', vol: .14 }); tone(165, .65, { type: 'sawtooth', vol: .1, delay: .05 }); },
    start: () => { tone(440, .12, { type: 'triangle', vol: .14 }); tone(660, .2, { type: 'triangle', vol: .14, delay: .1 }); },
    buzz: () => { tone(140, .5, { type: 'sawtooth', vol: .22 }); tone(147, .5, { type: 'square', vol: .1 }); },
    join: () => tone(660, .14, { type: 'triangle', vol: .12, slide: 990 }),
    correct: () => { tone(523, .12, { type: 'triangle', vol: .16 }); tone(659, .12, { type: 'triangle', vol: .16, delay: .1 }); tone(784, .28, { type: 'triangle', vol: .16, delay: .2 }); },
    wrong: () => { tone(311, .18, { type: 'square', vol: .1 }); tone(233, .38, { type: 'square', vol: .1, delay: .16 }); },
    double: () => [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(f, .15, { type: 'triangle', vol: .15, delay: i * .1 })),
    fanfare: () => [392, 523, 659, 784, 659, 784].forEach((f, i) => tone(f, i === 5 ? .7 : .16, { type: 'triangle', vol: .17, delay: i * .15 })),
  };
  return {
    play(name) { if (enabled && sounds[name]) { try { sounds[name](); } catch { /* ignorieren */ } } },
    unlock() { ensure(); },
    get enabled() { return enabled; },
    set enabled(v) { enabled = !!v; storageSet('moquizSound', v ? 'on' : 'off'); if (v) ensure(); },
    get running() { return !!ctx && ctx.state === 'running'; },
  };
})();
function vibrate(pattern) { try { navigator.vibrate?.(pattern); } catch { /* nicht unterstützt */ } }

/* =========================================================
   Konfetti
   ========================================================= */
function confetti(ms = 4000) {
  if (reducedMotion()) return;
  const cv = document.createElement('canvas'); cv.className = 'confetti'; document.body.appendChild(cv);
  const g = cv.getContext('2d'), dpr = window.devicePixelRatio || 1;
  cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
  const colors = ['#f36fc6', '#ffd426', '#8fd39a', '#a7adff', '#ff7448', '#7ad8d2'];
  const parts = Array.from({ length: 170 }, () => ({
    x: Math.random() * cv.width, y: -Math.random() * cv.height * .6, w: (6 + Math.random() * 8) * dpr, h: (9 + Math.random() * 10) * dpr,
    vy: (2.5 + Math.random() * 4) * dpr, vx: (Math.random() - .5) * 3 * dpr, r: Math.random() * 6, vr: (Math.random() - .5) * .25,
    c: colors[Math.random() * colors.length | 0],
  }));
  const t0 = performance.now();
  (function frame(t) {
    g.clearRect(0, 0, cv.width, cv.height);
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy; p.r += p.vr;
      if (p.y > cv.height && t - t0 < ms - 1200) { p.y = -20; p.x = Math.random() * cv.width; }
      g.save(); g.translate(p.x, p.y); g.rotate(p.r); g.fillStyle = p.c; g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      g.lineWidth = 1.5 * dpr; g.strokeStyle = '#111'; g.strokeRect(-p.w / 2, -p.h / 2, p.w, p.h); g.restore();
    }
    if (t - t0 < ms) requestAnimationFrame(frame); else cv.remove();
  })(t0);
}
function splash(text) {
  if (reducedMotion()) { toast(text); return; }
  const el = document.createElement('div'); el.className = 'splash'; el.innerHTML = `<div>${text}</div>`;
  document.body.appendChild(el); setTimeout(() => el.remove(), 2700);
}

/* =========================================================
   QR-Code
   ========================================================= */
function qrSvg(text, label = 'QR-Code zum Beitreten') {
  if (typeof window.qrcode !== 'function') return `<svg class="qr" viewBox="0 0 10 10" role="img" aria-label="${safe(label)}"><rect width="10" height="10" fill="#fff"/></svg>`;
  const q = window.qrcode(0, 'M'); q.addData(text); q.make();
  const n = q.getModuleCount(), m = 2; let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + m} ${r + m}h1v1h-1z`;
  return `<svg class="qr" viewBox="0 0 ${n + 2 * m} ${n + 2 * m}" shape-rendering="crispEdges" role="img" aria-label="${safe(label)}"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#111"/></svg>`;
}

/* =========================================================
   Antworten: Multiple Choice, Vergleich mit Lösung, Schätzfragen, Einsatz
   ========================================================= */
/* Multiple Choice wird als lesbarer Text in der Frage gespeichert:
   Fragetext, Leerzeile, danach Zeilen "A) ...", "B) ..." usw. */
function parseMC(prompt) {
  const lines = String(prompt ?? '').replace(/\r/g, '').split('\n');
  let i = lines.length - 1; while (i >= 0 && !lines[i].trim()) i--;
  const opts = [];
  while (i >= 0) { const m = lines[i].match(/^\s*([A-F])\)\s+(.+?)\s*$/); if (!m) break; opts.unshift({ letter: m[1], text: m[2] }); i--; }
  if (opts.length < 2 || !opts.every((o, k) => o.letter === MC_LETTERS[k])) return null;
  return { text: lines.slice(0, i + 1).join('\n').trim(), options: opts };
}
function composeMC(text, options) { return (String(text || '').trim() + '\n\n' + options.map((o, k) => MC_LETTERS[k] + ') ' + o).join('\n')).trim(); }
function mcLetter(s) { const m = String(s ?? '').trim().match(/^([A-F])(?:\)|:|\.|\s|$)/i); return m ? m[1].toUpperCase() : null; }
function promptText(q) { const mc = parseMC(q?.prompt); return mc ? mc.text : (q?.prompt || ''); }

function normAnswer(s) {
  return String(s ?? '').toLowerCase().replace(/ß/g, 'ss').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
    .replace(/^(der|die|das|den|dem|des|ein|eine|einen|the|a|an|le|la|les|l|il|lo|gli|el|los|las)\s+/, '');
}
function acceptedAnswers(correct) { return String(correct ?? '').split(/\s*(?:\/|;|\||\boder\b)\s*/i).map(normAnswer).filter(Boolean); }
function levenshtein(a, b) {
  if (a === b) return 0; if (!a.length) return b.length; if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
function textMatch(answer, correct) {
  const a = normAnswer(answer); if (!a) return null;
  const acc = acceptedAnswers(correct);
  if (acc.includes(a)) return 'match';
  for (const c of acc) {
    const tol = c.length <= 4 ? 0 : c.length <= 8 ? 1 : 2;
    if (tol && levenshtein(a, c) <= tol) return 'close';
    if (c.length >= 3 && (' ' + a + ' ').includes(' ' + c + ' ')) return 'close';
  }
  return null;
}
function parseNumber(s) {
  let t = String(s ?? '').replace(/(\d)['’’   _](?=\d{3}\b)/g, '$1');
  const m = t.match(/-?\d+(?:[.,]\d+)*/); if (!m) return null;
  let v = m[0];
  if (/^-?\d{1,3}(?:\.\d{3})+$/.test(v)) v = v.replace(/\./g, '');
  else if (/^-?\d{1,3}(?:,\d{3})+$/.test(v)) v = v.replace(/,/g, '');
  else v = v.replace(',', '.');
  const n = parseFloat(v); return Number.isFinite(n) ? n : null;
}
function isNumericSolution(correct) {
  const c = String(correct ?? '').trim(); if (!c || parseNumber(c) == null) return false;
  return c.replace(/[\d'’.,\s-]/g, '').length <= 6;
}
function fmtNum(n) { return Number.isInteger(n) ? n.toLocaleString('de-CH') : n.toLocaleString('de-CH', { maximumFractionDigits: 2 }); }
/* Vorschläge für die Bewertung. rows: [{team, sub}] */
function suggestionsFor(q, correct, rows) {
  const out = {}; if (!q || !correct) return out;
  const answered = rows.filter(r => r.sub?.submitted_at && String(answerOnly(r.sub.answer_text)).trim());
  const mc = parseMC(q.prompt);
  if (mc) {
    let cl = mcLetter(correct);
    if (!cl) { const hit = mc.options.find(o => normAnswer(o.text) === normAnswer(correct)); cl = hit?.letter || null; }
    if (!cl) return out;
    for (const r of answered) out[r.team.id] = mcLetter(answerOnly(r.sub.answer_text)) === cl ? { kind: 'match', label: 'Richtige Option' } : { kind: 'wrong', label: 'Falsche Option' };
    return out;
  }
  if (isNumericSolution(correct)) {
    const target = parseNumber(correct);
    const nums = answered.map(r => ({ r, n: parseNumber(answerOnly(r.sub.answer_text)) })).filter(x => x.n != null);
    if (nums.length > 1) {
      const best = Math.min(...nums.map(x => Math.abs(x.n - target)));
      for (const x of nums) {
        const d = Math.abs(x.n - target);
        if (d === best) out[x.r.team.id] = { kind: 'nearest', label: d === 0 ? 'Exakt richtig' : 'Am nächsten (' + fmtNum(d) + ' daneben)' };
      }
      return out;
    }
    for (const x of nums) if (x.n === target) out[x.r.team.id] = { kind: 'match', label: 'Exakt richtig' };
    return out;
  }
  for (const r of answered) {
    const m = textMatch(answerOnly(r.sub.answer_text), correct);
    if (m === 'match') out[r.team.id] = { kind: 'match', label: 'Passt zur Lösung' };
    else if (m === 'close') out[r.team.id] = { kind: 'close', label: 'Ähnlich wie Lösung' };
  }
  return out;
}
/* Finalrunde: Einsatz wird vor die Antwort geschrieben, z.B. "Einsatz 300 | Biel" */
function parseWager(text) { const m = String(text ?? '').match(/^Einsatz\s+(\d+)\s*\|\s?([\s\S]*)$/); return m ? { wager: +m[1], answer: m[2] } : { wager: null, answer: String(text ?? '') }; }
const answerOnly = t => parseWager(t).answer;

/* =========================================================
   Teams und Emojis
   ========================================================= */
function splitTeam(name) {
  const s = String(name ?? '').trim();
  const m = s.match(/^(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*)\s+(.+)$/u);
  return m ? { emoji: m[1], label: m[2] } : { emoji: null, label: s };
}
function teamBadge(t) {
  if (!t) return '';
  const { emoji, label } = splitTeam(t.name);
  return `<span class="tb">${emoji ? `<span class="tb-emoji" aria-hidden="true">${emoji}</span>` : `<span class="tb-emoji tb-initial" aria-hidden="true">${safe(label.slice(0, 1).toUpperCase())}</span>`}<span class="tb-name">${safe(label)}</span></span>`;
}
const teamLabel = t => t ? splitTeam(t.name).label : 'Ein Team';

/* =========================================================
   Zustand
   ========================================================= */
let current = emptySession();
function emptySession() { return { mode: null, roomId: null, code: null, hostSecret: null, teamId: null, teamToken: null }; }
let roomState = null, teamsState = [], quizSets = [];
let boardQuizId = null, boardCategories = [], boardQuestions = [], usedQuestionIds = new Set();
let activeQuestion = null, activeCategory = null, hostQuestionDetails = null, hostSubmissions = [], mySubmission = null;
let draftAnswer = '', activeRoundKey = null, autoSubmitBusy = false;
let refreshBusy = false, refreshAgain = false, refreshFailed = false, pendingTeamQuestion = null, submittedRound = null;
let builderState = null, builderReturn = 'home', builderDirty = false, builderOpen = new Set();
let authUser = null, pendingAfterAuth = null;
let ownerSecrets = storageJson(OWNER_SECRETS_KEY, {}) || {};

/* Vom Host gesteuerter, geteilter Anzeigezustand */
const defaultUi = () => ({ rev: 0, ranking: false, podium: false, recap: null, showJoin: false, solution: null, double: null, final: null, quizTitle: '' });
let ui = defaultUi();
let hostDoubles = { quizId: null, count: null, ids: [] };
let hostWagers = {};
let localGrades = {};          // Host und Beamer: Runde -> Team -> Punkte
let myWager = null, wagerDraft = null, lastGrade = null;
let roundTotal = 0, lastRem = null, prevWinner = undefined, prevTeamIds = null, lastScreenAlive = 0, splashFor = null;
let selectedEmoji = TEAM_EMOJIS[Math.random() * TEAM_EMOJIS.length | 0];
let pgChannel = null, uiChannel = null, liveGen = 0, liveOk = true, reconnectTimer = null;
let jokerOpen = false, jokerDraft = null;                              // Spieler: Einsatz-Joker
let audioEl = null, audioSrc = null, audioBlocked = false, remoteAudioPlaying = false; // Audiofragen

const hostLike = () => current.mode === 'host' || current.mode === 'screen';
function sortedTeams() { return [...teamsState].sort((a, b) => b.score - a.score || new Date(a.joined_at) - new Date(b.joined_at)); }
function getTeam(id) { return teamsState.find(t => t.id === id); }
function rankOf(teamId) { const t = getTeam(teamId); if (!t) return null; return 1 + teamsState.filter(x => x.score > t.score).length; }
function currentRoundKey() { if (!roomState?.active_question_id) return null; return roomState.active_question_id + ':' + (roomState.phase === 'buzzer' ? roomState.buzzer_round : 0); }
function remainingSeconds() {
  if (!roomState?.active_question_id) return null;
  if (roomState.question_paused) return Math.max(0, roomState.paused_remaining_seconds ?? 0);
  if (!roomState.question_ends_at) return null;
  return Math.max(0, Math.ceil((new Date(roomState.question_ends_at).getTime() - Date.now()) / 1000));
}
const hasContent = q => !!((q?.prompt || '').trim() || q?.image_url || q?.audio_url);
const isDoubleActive = () => !!roomState?.active_question_id && ui.double === roomState.active_question_id;
const isFinalActive = () => !!roomState?.active_question_id && ui.final?.qid === roomState.active_question_id;
const joinHost = () => (location.host || 'moquiz').replace(/^www\./, '');
const joinUrl = (code = current.code) => location.protocol + '//' + joinHost() + '/' + code;
function canAnswerNow() {
  if (!activeQuestion || !roomState) return false;
  const t = activeQuestion.question_type;
  return t === 'all' || (t === 'team' && roomState.active_team_id === current.teamId) || (t === 'buzzer' && roomState.buzzer_winner_team_id === current.teamId);
}
/* Einsatz-Joker: gilt, wenn er für genau diese Frage eingesetzt wurde */
const jokerOn = (t, qid = roomState?.active_question_id) => !!t && !!qid && t.joker_state === 'used' && t.joker_question_id === qid;
function pointsFor(teamId, sub) {
  const q = activeQuestion; if (!q) return 0;
  if (isFinalActive()) { const w = parseWager(sub?.answer_text).wager; return w ?? hostWagers[teamId] ?? 0; }
  const t = getTeam(teamId); if (jokerOn(t)) return Number(t.joker_amount) || 0;
  return (Number(q.points) || 0) * (isDoubleActive() ? 2 : 1);
}

/* =========================================================
   Ansichten umschalten
   ========================================================= */
const SECTIONS = ['home', 'builder', 'host', 'player', 'screen'];
function show(which) {
  SECTIONS.forEach(id => $(id).classList.toggle('hidden', id !== which));
  document.body.dataset.mode = which;
}

/* =========================================================
   Konto
   ========================================================= */
function accountName() { return authUser?.user_metadata?.username || 'Konto'; }
/* Konten mit Benutzername: Supabase Auth braucht eine E-Mail-Adresse. Daraus wird eine
   feste, interne Adresse abgeleitet (Hash des Benutzernamens). Es werden nie E-Mails verschickt.
   Gleicher Algorithmus wie in supabase/functions/signup-username/index.ts */
function normUsername(u) { return String(u ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase(); }
async function usernameToEmail(username) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('moquiz:' + normUsername(username)));
  return 'u' + [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 40) + '@users.moquiz.ch';
}
function authErrorText(e, fallback) {
  const m = String(e?.message || e || '');
  if (/invalid login credentials/i.test(m)) return 'Benutzername oder Passwort ist falsch.';
  if (/already (been )?registered|already exists|user_already_exists/i.test(m)) return 'Dieser Benutzername ist schon vergeben.';
  if (/email not confirmed/i.test(m)) return 'Das Konto ist noch nicht freigeschaltet. Bitte versuche es in einer Minute nochmals.';
  if (/rate limit|too many/i.test(m)) return 'Zu viele Versuche. Bitte kurz warten und nochmals probieren.';
  if (/password/i.test(m)) return 'Das Passwort ist zu kurz oder zu einfach.';
  if (/failed to fetch|load failed|networkerror/i.test(m)) return connectionErrorText();
  return m || fallback;
}
async function loginWithUsername(username, password) {
  try { await ensureDb(); } catch { throw new Error(connectionErrorText()); }
  const { data, error } = await db.auth.signInWithPassword({ email: await usernameToEmail(username), password });
  if (error) throw new Error(authErrorText(error, 'Anmeldung fehlgeschlagen.'));
  return data.user;
}
/* Konto erstellen: zuerst über die Edge Function (Konto sofort freigeschaltet),
   sonst direkt über Supabase Auth (funktioniert, wenn «Confirm email» ausgeschaltet ist). */
async function createAccount(username, password) {
  await ensureDb();
  let res = null;
  try {
    res = await fetch(SUPABASE_URL + '/functions/v1/signup-username', {
      method: 'POST', headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY }, body: JSON.stringify({ username, password }),
    });
  } catch { res = null; }
  if (res && res.status !== 404) {
    const result = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(authErrorText(result.error, 'Konto konnte nicht erstellt werden.'));
    return;
  }
  const { data, error } = await db.auth.signUp({ email: await usernameToEmail(username), password, options: { data: { username } } });
  if (error) throw new Error(authErrorText(error, 'Konto konnte nicht erstellt werden.'));
  if (!data.session) throw new Error('Konto erstellt, aber Supabase verlangt eine E-Mail-Bestätigung. Im Supabase-Projekt unter Authentication die Option «Confirm email» ausschalten.');
}
function updateAuthUI() {
  const b = $('accountButton'); if (!b) return;
  b.textContent = authUser ? accountName() : 'Anmelden';
  b.title = authUser ? 'Klicken zum Abmelden' : 'Anmelden oder Konto erstellen';
}
function openAuthModal(after = null) {
  pendingAfterAuth = after || pendingAfterAuth; setMsg('authError');
  $('authModal').classList.remove('hidden'); setTimeout(() => $('authUsername').focus(), 30);
}
function closeAuthModal() { $('authModal').classList.add('hidden'); if (!authUser) pendingAfterAuth = null; }
function requireAccount(after) { if (authUser) return true; openAuthModal(after); return false; }
async function claimLegacyQuizSets() {
  if (!authUser) return; let changed = false;
  for (const [id, secret] of Object.entries(ownerSecrets)) {
    try { const { data, error } = await db.rpc('claim_legacy_quiz_set', { p_quiz_set_id: id, p_owner_secret: secret }); if (!error && data) { delete ownerSecrets[id]; changed = true; } } catch { /* weiter */ }
  }
  if (changed) storageSet(OWNER_SECRETS_KEY, JSON.stringify(ownerSecrets));
}
async function finishAccountLogin() {
  await claimLegacyQuizSets(); try { await loadQuizSets(); } catch { /* später */ }
  updateAuthUI(); $('authModal').classList.add('hidden');
  const next = pendingAfterAuth; pendingAfterAuth = null; if (next) await Promise.resolve(next());
}
function authInputs() { return { username: $('authUsername').value.trim(), password: $('authPassword').value }; }
function setAuthBusy(b) { $('authLogin').disabled = $('authSignup').disabled = b; }
async function loginAccount() {
  setMsg('authError'); const { username, password } = authInputs();
  if (!username || !password) { setMsg('authError', 'Bitte Benutzername und Passwort eingeben.'); return; }
  setAuthBusy(true);
  try { authUser = await loginWithUsername(username, password); await finishAccountLogin(); }
  catch (e) { setMsg('authError', errText(e) || 'Anmeldung fehlgeschlagen.'); }
  finally { setAuthBusy(false); }
}
async function signupAccount() {
  setMsg('authError'); const { username, password } = authInputs();
  if (!username || !password) { setMsg('authError', 'Bitte Benutzername und Passwort eingeben.'); return; }
  if (username.length < 3 || username.length > 24) { setMsg('authError', 'Der Benutzername muss 3 bis 24 Zeichen lang sein.'); return; }
  if (!/^[\p{L}\p{N}._ -]+$/u.test(username)) { setMsg('authError', 'Erlaubt sind Buchstaben, Zahlen, Leerzeichen, Punkt, Unterstrich und Bindestrich.'); return; }
  if (password.length < 6) { setMsg('authError', 'Das Passwort muss mindestens 6 Zeichen haben.'); return; }
  setAuthBusy(true);
  try {
    await createAccount(username, password);
    authUser = await loginWithUsername(username, password); await finishAccountLogin();
  } catch (e) { setMsg('authError', errText(e) || 'Konto konnte nicht erstellt werden.'); }
  finally { setAuthBusy(false); }
}
async function signOutAccount() {
  try { await ensureDb(); } catch { toast(connectionErrorText()); return; }
  if (current.mode === 'host') { leaveRoom(); show('home'); }
  await db.auth.signOut(); authUser = null; quizSets = []; updateAuthUI(); toast('Abgemeldet');
}
async function loadQuizSets() {
  try { await ensureDb(); } catch { throw new Error(connectionErrorText()); }
  if (!authUser) { quizSets = []; return quizSets; }
  const { data, error } = await db.rpc('list_my_quiz_sets'); if (error) throw error;
  quizSets = data || []; return quizSets;
}

/* =========================================================
   Sitzung und Links
   ========================================================= */
function saveSession() {
  if (current.mode === 'host' || current.mode === 'player') storageSet(SESSION_KEY, JSON.stringify(current));
  else if (!current.mode) storageRemove(SESSION_KEY);
}
function readSavedSession() { const s = storageJson(SESSION_KEY, null); return s?.roomId && s?.mode ? s : null; }
function resetRoomState() {
  roomState = null; teamsState = []; boardQuizId = null; boardCategories = []; boardQuestions = []; usedQuestionIds = new Set();
  activeQuestion = null; activeCategory = null; mySubmission = null; hostSubmissions = []; hostQuestionDetails = null;
  activeRoundKey = null; ui = defaultUi(); hostWagers = {}; localGrades = {}; myWager = null; wagerDraft = null; lastGrade = null;
  prevWinner = undefined; prevTeamIds = null; Object.keys(viewCache).forEach(k => delete viewCache[k]);
}
function leaveRoom() {
  const wasScreen = current.mode === 'screen';
  liveGen++; stopChannels();
  if (!wasScreen) { current = emptySession(); saveSession(); } else current = emptySession();
  resetRoomState(); setLive(true);
}
function encodeToken(o) { return btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function decodeToken(t) {
  try { const s = t.replace(/-/g, '+').replace(/_/g, '/'); return JSON.parse(decodeURIComponent(escape(atob(s + '='.repeat((4 - s.length % 4) % 4))))); } catch { return null; }
}
const hostToken = () => encodeToken({ r: current.roomId, c: current.code, s: current.hostSecret });
/* Für die Übergabe der Steuerung zusätzlich die Überraschungsfelder mitgeben */
const controlToken = () => encodeToken({ r: current.roomId, c: current.code, s: current.hostSecret, q: boardQuizId, d: hostDoubles.ids, n: hostDoubles.count });

/* =========================================================
   Live-Verbindung
   ========================================================= */
async function startLive() {
  try { await ensureDb(); } catch { setLive(false); scheduleReconnect(5000); return; }
  const gen = ++liveGen;
  stopChannels();
  await refreshState();
  if (gen !== liveGen || !current.roomId) return;
  pgChannel = db.channel('quiz-' + current.roomId + '-' + Math.random().toString(36).slice(2))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms', filter: 'id=eq.' + current.roomId }, () => refreshState())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'teams', filter: 'room_id=eq.' + current.roomId }, () => refreshState())
    .subscribe(status => onLiveStatus(gen, status));
  uiChannel = db.channel('moquiz-ui-' + current.roomId, { config: { broadcast: { self: false } } })
    .on('broadcast', { event: '*' }, msg => onBroadcast(msg.event, msg.payload || {}))
    .subscribe(status => {
      if (gen !== liveGen || status !== 'SUBSCRIBED') return;
      if (current.mode === 'host') broadcastUi(); else sendBroadcast('hello', { mode: current.mode });
      if (current.mode === 'screen') sendBroadcast('screen-alive', {});
    });
}
function stopChannels() {
  for (const ch of [pgChannel, uiChannel]) if (ch && db) { try { db.removeChannel(ch); } catch { /* egal */ } }
  pgChannel = null; uiChannel = null;
}
function onLiveStatus(gen, status) {
  if (gen !== liveGen) return;
  if (status === 'SUBSCRIBED') { setLive(true); refreshState(); }
  else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') { setLive(false); scheduleReconnect(); }
}
function setLive(ok) { liveOk = ok; $('liveBanner').classList.toggle('hidden', ok || !current.roomId); }
function scheduleReconnect(delay = 2500) {
  if (reconnectTimer || !current.roomId) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; if (current.roomId) startLive().catch(() => scheduleReconnect(5000)); }, delay);
}
function sendBroadcast(event, payload) {
  if (!uiChannel) return;
  try { const p = uiChannel.send({ type: 'broadcast', event, payload }); p?.catch?.(() => {}); } catch { /* offline */ }
}
/* Nach dem Entsperren des Handys oder bei wiederkehrendem Netz sofort aktualisieren */
function wakeUp() { if (!current.roomId) return; if (!liveOk) startLive(); else refreshState(); }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wakeUp(); });
window.addEventListener('online', wakeUp);
window.addEventListener('pageshow', e => { if (e.persisted) wakeUp(); });
setInterval(() => { if (current.roomId && document.visibilityState === 'visible') refreshState(); }, 15000);

/* =========================================================
   Geteilter Anzeigezustand (Broadcast)
   ========================================================= */
const uiKey = () => 'moquizUi:' + current.roomId;
function loadHostUi() { const saved = storageJson(uiKey(), null); ui = { ...defaultUi(), ...(saved || {}) }; hostWagers = storageJson('moquizWagers:' + current.roomId, {}) || {}; }
function broadcastUi() { sendBroadcast('ui', ui); }
function setUi(patch) {
  const prev = ui;
  ui = { ...ui, ...patch, rev: (ui.rev || 0) + 1 };
  storageSet(uiKey(), JSON.stringify(ui));
  broadcastUi(); uiEffects(prev); render();
}
function applyUi(next) {
  const prev = ui; ui = { ...defaultUi(), ...next };
  if (current.mode === 'player' && ui.final?.stage === 'wager' && myWager != null && !(ui.final.ready || []).includes(current.teamId)) {
    sendBroadcast('wager', { teamId: current.teamId, amount: myWager, qid: ui.final.qid });
  }
  uiEffects(prev); render();
}
function uiEffects(prev) {
  if (ui.podium && !prev.podium) {
    playFx('fanfare');
    if (current.mode !== 'player' || (rankOf(current.teamId) || 99) <= 3) confetti(5000);
    if (current.mode === 'player') vibrate([80, 60, 80, 60, 160]);
  }
  if (ui.final?.qid && ui.final.qid !== prev.final?.qid) {
    const stored = storageGet('moquizWager:' + current.roomId + ':' + ui.final.qid);
    myWager = stored != null ? +stored : null; wagerDraft = null;
  }
}
function onBroadcast(event, p) {
  switch (event) {
    case 'ui':
      if (current.mode === 'host') { if ((p.rev || 0) > (ui.rev || 0)) { ui = { ...defaultUi(), ...p }; storageSet(uiKey(), JSON.stringify(ui)); render(); } }
      else applyUi(p);
      break;
    case 'hello': if (current.mode === 'host') broadcastUi(); break;
    case 'screen-alive': lastScreenAlive = Date.now(); break;
    case 'grade': onGradeEvent(p); break;
    case 'award': if (current.mode === 'player' && p.teamId === current.teamId) toast(signed(p.delta) + ' Punkte vom Host'); break;
    case 'audio': if (current.mode === 'screen' && p.qid && p.qid === roomState?.active_question_id) audioCmd(p.cmd); break;
    case 'audio-state': if (current.mode === 'host') { remoteAudioPlaying = !!p.playing && p.qid === roomState?.active_question_id; render(); } break;
    case 'wager':
      if (current.mode === 'host' && ui.final?.qid && p.qid === ui.final.qid) {
        hostWagers[p.teamId] = Math.max(0, Number(p.amount) || 0);
        storageSet('moquizWagers:' + current.roomId, JSON.stringify(hostWagers));
        const ready = [...new Set([...(ui.final.ready || []), p.teamId])];
        setUi({ final: { ...ui.final, ready } });
      } else if (current.mode === 'player' && p.teamId === current.teamId && ui.final?.qid === p.qid) {
        myWager = Math.max(0, Number(p.amount) || 0); wagerDraft = null;               // zweites Handy desselben Teams
        storageSet('moquizWager:' + current.roomId + ':' + p.qid, String(myWager)); render();
      }
      break;
  }
}
function onGradeEvent(p) {
  const rk = p.rk || activeRoundKey;
  (localGrades[rk] ||= {})[p.teamId] = p.delta;
  if (current.mode === 'player') {
    if (p.teamId !== current.teamId) return;
    lastGrade = { rk, delta: p.delta };
    showFeedback(p.delta);
    vibrate(p.delta > 0 ? [60, 40, 60] : p.delta < 0 ? 300 : 40);
    render();
  } else {
    playFx(p.delta > 0 ? 'correct' : p.delta < 0 ? 'wrong' : '');
    render();
  }
}
function showFeedback(delta) {
  const el = $('feedback');
  const cls = delta > 0 ? 'good' : delta < 0 ? 'bad' : 'neutral';
  const title = delta > 0 ? 'Richtig!' : delta < 0 ? 'Leider falsch' : 'Keine Punkte';
  el.className = 'feedback ' + cls; el.innerHTML = `<div class="t">${title}</div><div class="p">${signed(delta)}</div>`;
  clearTimeout(showFeedback.t); showFeedback.t = setTimeout(() => el.classList.add('hidden'), 2300);
  el.onclick = () => el.classList.add('hidden');
}
/* Töne spielen auf dem Beamer. Ist keiner offen, spielt die Host-Steuerung. */
function soundOwner() { return current.mode === 'screen' || (current.mode === 'host' && Date.now() - lastScreenAlive > 10000); }
function playFx(name) { if (name && soundOwner()) Sfx.play(name); }
setInterval(() => { if (current.mode === 'screen' && current.roomId) sendBroadcast('screen-alive', {}); }, 4000);

/* Hörfragen: Das Audio läuft dort, wo auch die Töne laufen (Beamer, sonst Host). */
function audioPlaying() { return !!audioEl && !!audioSrc && !audioEl.paused && !audioEl.ended; }
function onAudioState() {
  if (current.mode === 'screen') sendBroadcast('audio-state', { playing: audioPlaying(), qid: roomState?.active_question_id || null });
  render();
}
function audioFor(q) {
  if (!q?.audio_url) return null;
  if (!audioEl) { audioEl = new Audio(); audioEl.preload = 'auto'; ['play', 'pause', 'ended'].forEach(ev => audioEl.addEventListener(ev, onAudioState)); }
  if (audioSrc !== q.audio_url) { audioEl.src = q.audio_url; audioSrc = q.audio_url; }
  return audioEl;
}
async function audioCmd(cmd) {
  const a = audioFor(activeQuestion); if (!a) return;
  if (cmd === 'pause' || (cmd === 'toggle' && audioPlaying())) { a.pause(); return; }
  if (cmd === 'restart') a.currentTime = 0;
  try { await a.play(); audioBlocked = false; } catch { audioBlocked = true; }
  render();
}
function stopAudio() {
  if (audioEl) { audioEl.pause(); audioEl.removeAttribute('src'); audioEl.load(); }
  audioSrc = null; audioBlocked = false; remoteAudioPlaying = false;
}
function hostAudio(cmd) {
  if (soundOwner()) audioCmd(cmd);
  else { sendBroadcast('audio', { cmd, qid: roomState?.active_question_id }); if (cmd !== 'pause') remoteAudioPlaying = cmd === 'restart' || !remoteAudioPlaying; render(); }
}
const screenAudioPlay = () => audioCmd('play');

/* =========================================================
   Daten laden
   ========================================================= */
async function refreshState() {
  if (!current.roomId) return;
  try { await ensureDb(); } catch { setLive(false); return; }
  if (refreshBusy) { refreshAgain = true; return; }
  refreshBusy = true;
  try {
    const [{ data: room, error: re }, { data: teams, error: te }] = await Promise.all([
      db.from('rooms').select('*').eq('id', current.roomId).single(),
      db.from('teams').select('*').eq('room_id', current.roomId).order('joined_at'),
    ]);
    if (re) { if (re.code === 'PGRST116') { roomGone(); return; } throw re; }
    if (te) throw te;
    const prevRoom = roomState;
    roomState = room; teamsState = teams || [];

    if (hostLike()) {
      if (roomState.quiz_set_id) {
        if (boardQuizId !== roomState.quiz_set_id) await loadBoard(roomState.quiz_set_id);
        await loadUsedQuestions();
      } else { boardQuizId = null; boardCategories = []; boardQuestions = []; usedQuestionIds = new Set(); }
      activeQuestion = roomState.active_question_id ? boardQuestions.find(q => q.id === roomState.active_question_id) || null : null;
      activeCategory = activeQuestion ? boardCategories.find(c => c.id === activeQuestion.category_id) : null;
      if (current.mode === 'host') { ensureDoubles(); syncQuizTitle(); }
    } else {
      if (roomState.active_question_id) {
        const q = await rpc('player_get_active_question', teamArgs());
        activeQuestion = q || null; activeCategory = activeQuestion ? { id: activeQuestion.category_id, title: activeQuestion.category_title } : null;
      } else { activeQuestion = null; activeCategory = null; }
    }

    const rk = currentRoundKey();
    if (rk !== activeRoundKey) { const was = activeRoundKey; activeRoundKey = rk; onRoundChange(was, rk); }

    if (hostLike() && roomState.active_question_id) {
      const [d, s] = await Promise.all([
        rpc('host_get_question_details', hostArgs({ p_question_id: roomState.active_question_id })).catch(() => null),
        rpc('host_get_submissions', hostArgs()).catch(() => []),
      ]);
      hostQuestionDetails = d?.[0] || null; hostSubmissions = s || [];
    } else { hostQuestionDetails = null; hostSubmissions = []; }

    if (current.mode === 'player') {
      if (roomState.active_question_id) { const d = await rpc('get_my_submission', teamArgs()); mySubmission = d?.[0] || null; }
      else mySubmission = null;
    }
    detectEffects(prevRoom);
    if (refreshFailed) { refreshFailed = false; setMsg(errorTarget(), ''); }
    render();
  } catch (e) {
    refreshFailed = true;
    if (current.mode === 'screen') toast(errText(e), 5000); else setMsg(errorTarget(), errText(e));
  } finally {
    refreshBusy = false;
    if (refreshAgain) { refreshAgain = false; refreshState(); }
  }
}
const errorTarget = () => ({ host: 'hostError', player: 'playerError', screen: 'hostError' }[current.mode] || 'hostHomeError');
function roomGone() {
  const mode = current.mode; leaveRoom(); show('home');
  setMsg(mode === 'host' ? 'hostHomeError' : 'joinError', 'Dieser Raum existiert nicht mehr.');
  if (mode === 'screen') { show('screen'); setHtml('screenBody', screenMessage('Dieser Raum existiert nicht mehr.')); }
}
async function loadBoard(quizSetId) {
  const data = await rpc('host_get_board', hostArgs());
  const cats = data?.categories || [];
  boardCategories = cats.map(c => ({ id: c.id, quiz_set_id: c.quiz_set_id, title: c.title, position: c.position }));
  boardQuestions = cats.flatMap(c => c.questions || []);
  boardQuizId = quizSetId;
}
async function loadUsedQuestions() { const data = await rpc('host_get_used_questions', hostArgs()); usedQuestionIds = new Set((data || []).map(x => x.question_id)); }
function syncQuizTitle() {
  const t = quizSets.find(q => q.id === roomState?.quiz_set_id)?.title || '';
  if (t && t !== ui.quizTitle) { ui = { ...ui, quizTitle: t, rev: ui.rev + 1 }; storageSet(uiKey(), JSON.stringify(ui)); broadcastUi(); }
}
function onRoundChange(was, rk) {
  draftAnswer = ''; mySubmission = null; roundTotal = 0; lastRem = null; autoSubmitBusy = false;
  if (current.mode === 'player') { lastGrade = null; $('feedback').classList.add('hidden'); }
  const isNew = rk && (!was || was.split(':')[0] !== rk.split(':')[0]);
  if (!rk || isNew) stopAudio();
  if (isNew) {
    playFx('start');
    if (current.mode === 'player') vibrate(40);
    if (hostLike() && soundOwner() && activeQuestion?.audio_url) setTimeout(() => audioCmd('play'), 600);
  }
}
function detectEffects(prevRoom) {
  const winner = roomState?.buzzer_winner_team_id || null;
  if (prevWinner !== undefined && winner && winner !== prevWinner) {
    playFx('buzz');
    if (soundOwner() && audioPlaying()) audioEl.pause();                             // Buzzer stoppt die Musik
    if (current.mode === 'player' && winner === current.teamId) vibrate([80, 40, 80]);
  }
  prevWinner = winner;
  const ids = new Set(teamsState.map(t => t.id));
  if (prevTeamIds && [...ids].some(id => !prevTeamIds.has(id))) playFx('join');
  prevTeamIds = ids;
}

/* =========================================================
   Überraschungsfelder (doppelte Punkte)
   ========================================================= */
const doublesKey = () => 'moquizDoubles:' + current.roomId + ':' + boardQuizId;
function ensureDoubles() {
  if (!boardQuizId || !boardQuestions.length) return;
  if (hostDoubles.quizId === boardQuizId && hostDoubles.roomId === current.roomId) return;
  const saved = storageJson(doublesKey(), null);
  if (saved && Array.isArray(saved.ids)) { hostDoubles = { ...saved, quizId: boardQuizId, roomId: current.roomId }; return; }
  const playable = boardQuestions.filter(hasContent);
  assignDoubles(playable.length >= 16 ? 2 : playable.length >= 6 ? 1 : 0);
}
function assignDoubles(count) {
  const playable = boardQuestions.filter(q => hasContent(q) && !usedQuestionIds.has(q.id));
  const minPts = Math.min(...playable.map(q => q.points));
  let pool = playable.filter(q => q.points > minPts); if (pool.length < count) pool = playable;
  const ids = [];
  const byCat = {};
  for (const q of [...pool].sort(() => Math.random() - .5)) {
    if (ids.length >= count) break;
    if (byCat[q.category_id] && pool.length > count * 2) continue;
    byCat[q.category_id] = true; ids.push(q.id);
  }
  hostDoubles = { quizId: boardQuizId, roomId: current.roomId, count, ids };
  storageSet(doublesKey(), JSON.stringify(hostDoubles));
}

/* =========================================================
   Rendering: gemeinsame Bausteine
   ========================================================= */
function render() {
  if (current.mode === 'host') renderHost();
  else if (current.mode === 'player') renderPlayer();
  else if (current.mode === 'screen') renderScreen();
  updateTimers();
}
function timerBlock(cls = '') {
  return `<div class="timer-block ${cls}"><div class="timer" data-timer></div><div class="tbar" data-tbar><i></i></div></div>`;
}
function updateTimers() {
  const rem = remainingSeconds();
  const buzzWait = activeQuestion?.question_type === 'buzzer' && !roomState?.buzzer_winner_team_id;
  const total = Math.max(roundTotal, Number(activeQuestion?.duration_seconds) || 0, rem || 0);
  document.querySelectorAll('[data-timer]').forEach(el => {
    el.textContent = buzzWait ? 'BUZZ' : formatTime(rem);
    el.classList.toggle('paused', !!roomState?.question_paused);
  });
  document.querySelectorAll('[data-tbar]').forEach(el => {
    const idle = buzzWait || rem == null;
    el.classList.toggle('idle', idle);
    el.classList.toggle('urgent', !idle && rem > 0 && rem <= 5 && !roomState?.question_paused);
    el.classList.toggle('done', !idle && rem === 0);
    const bar = el.firstElementChild; if (bar && !idle && total) bar.style.width = Math.max(0, Math.min(100, rem / total * 100)) + '%';
  });
}
function mcGrid(mc, { correctLetter = null, chosen = null, buttons = false, dimOthers = false, hidden = [] } = {}) {
  return `<div class="mc-grid">${mc.options.map((o, i) => {
    const gone = hidden.includes(o.letter);
    const cls = ['mc-opt', 'mc-' + i, correctLetter === o.letter ? 'is-correct' : '', dimOthers && correctLetter && correctLetter !== o.letter && chosen !== o.letter ? 'is-dim' : '', chosen === o.letter ? 'is-chosen' : '', gone ? 'is-gone' : ''].join(' ');
    const inner = `<span class="mc-letter">${o.letter}</span><span>${safe(o.text)}</span>`;
    return buttons ? `<button type="button" class="${cls}" data-mc="${o.letter}" ${gone ? 'disabled aria-label="Durch 50:50 ausgeblendet"' : ''}>${inner}</button>` : `<div class="${cls}">${inner}</div>`;
  }).join('')}</div>`;
}
function jokerChips() {
  return sortedTeams().filter(t => jokerOn(t)).map(t => `<span class="chip ink">🃏 ${safe(teamLabel(t))} setzt ${t.joker_amount}</span>`).join(' ');
}
function questionBadges(q, { forHost = false } = {}) {
  const chips = [];
  const me = current.mode === 'player' ? getTeam(current.teamId) : null;
  if (activeCategory?.title) chips.push(`<span class="chip">${safe(activeCategory.title)}</span>`);
  if (isFinalActive()) chips.push(`<span class="chip ink">Finalrunde</span>`);
  else if (me && jokerOn(me)) chips.push(`<span class="chip ink">🃏 Joker: ${me.joker_amount} Punkte</span>`);
  else chips.push(`<span class="chip yellow">${isDoubleActive() ? (q.points * 2) + ' Punkte (×2)' : q.points + ' Punkte'}</span>`);
  if (isDoubleActive() && !(me && jokerOn(me))) chips.push(`<span class="chip pink">Doppelte Punkte</span>`);
  if (q.audio_url || q.has_audio) chips.push(`<span class="chip">🎵 Hörfrage</span>`);
  if (current.mode === 'player') return chips.join(' ');
  if (q.question_type === 'team') chips.push(`<span class="chip">${forHost || current.mode === 'screen' ? 'Frage an ' + safe(teamLabel(getTeam(roomState.active_team_id))) : 'Ein Team'}</span>`);
  else chips.push(`<span class="chip">${typeLabel(q.question_type)}</span>`);
  return chips.join(' ');
}
function podiumHtml() {
  const teams = sortedTeams(); const top = teams.slice(0, 3);
  const col = (t, place) => t ? `<div class="podium-col p${place}">${teamBadge(t)}<div class="podium-score">${t.score} Punkte</div><div class="podium-block">${place}</div></div>` : `<div class="podium-col p${place}"></div>`;
  const rest = teams.slice(3).map(t => `<div class="wager-row"><span><b>${rankOf(t.id)}.</b> ${teamBadge(t)}</span><span class="score">${t.score}</span></div>`).join('');
  return `<div class="podium">${col(top[1], 2)}${col(top[0], 1)}${col(top[2], 3)}</div>${rest ? `<div class="podium-rest">${rest}</div>` : ''}`;
}
function rowsForQuestion(q) {
  if (q.question_type === 'buzzer') { const w = getTeam(roomState.buzzer_winner_team_id); return w ? [{ team: w, sub: hostSubmissions.find(x => x.team_id === w.id) }] : []; }
  if (q.question_type === 'team') { const t = getTeam(roomState.active_team_id); return t ? [{ team: t, sub: hostSubmissions.find(x => x.team_id === t.id) }] : []; }
  return teamsState.map(t => ({ team: t, sub: hostSubmissions.find(x => x.team_id === t.id) }));
}
const answersVisible = (q, rem) => q.question_type !== 'all' || roomState.question_revealed || rem === 0;
function gradeOf(teamId, sub) {
  const g = localGrades[activeRoundKey]?.[teamId];
  if (g !== undefined) return g;
  return sub?.points_awarded ? sub.points_awarded : undefined;
}

/* =========================================================
   Rendering: Host
   ========================================================= */
function renderHost() {
  show('host');
  $('hostCode').textContent = current.code || '----';
  $('hostJoinUrl').innerHTML = `Mitspielen auf<br><b>${safe(joinHost())}/${safe(current.code || '')}</b>`;
  $('hostQuizName').textContent = ui.quizTitle || quizSets.find(q => q.id === roomState?.quiz_set_id)?.title || (roomState?.quiz_set_id ? 'Quiz' : 'Noch kein Quiz gewählt');
  $('hostState').textContent = ui.podium ? 'Siegerehrung' : roomState ? ({ lobby: 'Lobby', board: 'Board', question: 'Frage läuft', buzzer: 'Buzzer-Frage', results: 'Auswertung' }[roomState.phase] || roomState.phase) : 'Verbinde …';
  $('soundToggle').textContent = 'Ton: ' + (Sfx.enabled ? 'an' : 'aus');
  $('toggleJoinInfo').textContent = ui.showJoin ? 'QR-Code auf Beamer ausblenden' : 'QR-Code auf Beamer zeigen';
  $('toggleJoinInfo').classList.toggle('is-on', !!ui.showJoin);
  renderTeamList();
  if (!roomState) return;
  const view = ui.podium ? 'podium' : !roomState.quiz_set_id ? 'lobby' : roomState.active_question_id ? 'question' : ui.final?.stage === 'wager' ? 'final' : 'board';
  const ids = { lobby: 'hostLobby', board: 'hostBoard', question: 'hostQuestion', final: 'hostFinal', podium: 'hostPodium' };
  Object.entries(ids).forEach(([v, id]) => $(id).classList.toggle('hidden', v !== view));
  if (view === 'lobby') renderHostLobby();
  else if (view === 'board') renderHostBoard();
  else if (view === 'question') renderHostQuestion();
  else if (view === 'final') renderHostFinal();
  else renderHostPodium();
}
function renderTeamList() {
  const teams = sortedTeams();
  $('teamCount').textContent = plural(teams.length, 'Team', 'Teams');
  setHtml('hostTeams', teams.length ? teams.map(t => `<div class="teamrow"><div class="rank">${rankOf(t.id)}.</div><div style="min-width:0">${teamBadge(t)}<div class="teamrow-bottom"><span class="score">${t.score} Punkte</span><span class="score-actions"><button class="btn ghost smallbtn" onclick="manualAward('${t.id}',-100)" aria-label="100 Punkte abziehen">−100</button><button class="btn ghost smallbtn" onclick="manualAward('${t.id}',100)" aria-label="100 Punkte geben">+100</button></span></div>${teamJokerLine(t)}</div></div>`).join('') : '<p class="muted small">Noch keine Teams. Zeig den QR-Code, damit die Teams beitreten können.</p>');
}
function teamJokerLine(t) {
  const bits = [];
  if (t.joker_state === 'armed') bits.push(`<span class="jk armed">🃏 Joker gesetzt: ${t.joker_amount}</span>`);
  else if (jokerOn(t)) bits.push(`<span class="jk armed">🃏 ${t.joker_amount} auf dieser Frage</span>`);
  else if (t.joker_state === 'used') bits.push(`<span class="jk">Joker eingesetzt</span>`);
  if (t.fifty_used) bits.push(`<span class="jk">50:50 eingesetzt</span>`);
  return bits.length ? `<div class="jk-line">${bits.join('')}</div>` : '';
}
function joinPanelHtml() {
  return `<div class="card join-panel">
    <div class="eyebrow">Teams beitreten lassen</div>
    <div class="join-panel-body">
      <div class="qr-box">${qrSvg(joinUrl())}</div>
      <div><p style="margin:0">QR-Code scannen oder im Browser öffnen:</p><div class="join-url">${safe(joinHost())}/<wbr>${safe(current.code)}</div>
      <p class="small" style="margin:0 0 4px">Oder auf ${safe(joinHost())} den Code eingeben:</p><div class="code-mini">${safe(current.code)}</div></div>
    </div>
    <div class="toolbar" style="margin-top:16px"><button class="btn primary" onclick="openScreen()">Beamer-Ansicht öffnen</button><button class="btn ghost" onclick="copyJoinLink()">Link kopieren</button></div>
  </div>`;
}
function renderHostLobby() {
  const list = quizSets.length
    ? `<div class="quiz-list">${quizSets.map(q => `<div class="quiz-row"><strong>${safe(q.title)}</strong><button class="btn primary smallbtn" onclick="selectQuiz('${q.id}')">Dieses Quiz spielen</button></div>`).join('')}</div>`
    : `<div class="empty-state"><p><strong>Noch kein Quiz gespeichert.</strong></p><p class="small">Erstelle zuerst ein Quiz mit Kategorien und Fragen.</p></div>`;
  setHtml('hostLobby', `<div class="lobby-grid">${joinPanelHtml()}
    <div class="card"><div class="eyebrow">Quiz auswählen</div>${list}
      <div class="toolbar" style="margin-top:14px"><button class="btn secondary" onclick="openBuilder('host')">Neues Quiz erstellen</button></div>
      <p class="small muted" style="margin-top:12px">Teams können jederzeit beitreten, auch während des Spiels.</p>
    </div></div>`);
  if (authUser && !renderHostLobby.loaded) { renderHostLobby.loaded = true; loadQuizSets().then(() => render()).catch(e => setMsg('hostError', errText(e))); }
}
function boardGridHtml({ interactive }) {
  if (!boardCategories.length) return '<div class="card"><p class="muted">Dieses Quiz hat noch keine Kategorien.</p></div>';
  return `<div class="board-wrap"><div class="board">${boardCategories.map(c => {
    const qs = boardQuestions.filter(q => q.category_id === c.id).sort((a, b) => a.position - b.position);
    return `<div class="category-col"><div class="category-title">${safe(c.title)}</div>${qs.map(q => {
      const used = usedQuestionIds.has(q.id), empty = !hasContent(q);
      if (!interactive) return `<div class="qcell ${used ? 'used' : ''}">${used ? '' : q.points}</div>`;
      const dbl = hostDoubles.ids.includes(q.id) && !used;
      const tags = [q.question_type !== 'all' ? typeLabel(q.question_type) : '', parseMC(q.prompt) ? 'Multiple Choice' : '', q.audio_url ? 'Audio' : ''].filter(Boolean).join(', ');
      return `<button class="qcell ${used ? 'used' : ''} ${empty ? 'empty' : ''}" ${used ? 'disabled' : ''} onclick="chooseQuestion('${q.id}')" aria-label="${safe(c.title)} ${q.points} Punkte">${dbl ? '<span class="dbl" title="Überraschungsfeld: doppelte Punkte">×2</span>' : ''}${empty ? 'Noch leer' : q.points}${tags ? `<span class="type-dot">${tags}</span>` : ''}</button>`;
    }).join('')}</div>`;
  }).join('')}</div></div>`;
}
function renderHostBoard() {
  const remaining = boardQuestions.filter(q => !usedQuestionIds.has(q.id) && hasContent(q)).length;
  const strip = ui.ranking ? `<div class="leaderboard-strip">${sortedTeams().map(t => `<div class="leader-chip"><strong>${rankOf(t.id)}. ${safe(teamLabel(t))}</strong> ${t.score}</div>`).join('')}</div>` : '';
  setHtml('hostBoard', `<div class="section-title">
      <div><h2 style="margin:0">Quiz-Board</h2><div class="small muted">Frage anklicken, um sie zu starten. Noch ${plural(remaining, 'Frage', 'Fragen')} offen.</div></div>
      <div class="toolbar">
        <button class="btn smallbtn ${ui.ranking ? 'is-on' : ''}" onclick="toggleRanking()">${ui.ranking ? 'Rangliste ausblenden' : 'Rangliste zeigen'}</button>
        <button class="btn secondary smallbtn" onclick="openFinalPicker()">Finalrunde</button>
        <button class="btn pink smallbtn" onclick="showPodium()">Spiel beenden</button>
        <button class="linkbtn" onclick="changeQuiz()">Quiz wechseln</button>
      </div>
    </div>${strip}${boardGridHtml({ interactive: true })}
    <div class="board-legend">×2 = Überraschungsfeld mit doppelten Punkten, nur du siehst die Markierung.
      <label style="display:inline;margin:0 0 0 8px;text-transform:none;letter-spacing:0;font-size:12px">Anzahl
      <select onchange="setDoubleCount(this.value)" style="width:auto;padding:3px 6px;margin-left:4px">${[0, 1, 2, 3].map(n => `<option value="${n}" ${hostDoubles.count === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    </div>`);
}
function renderHostQuestion() {
  const q = activeQuestion; if (!q) { setHtml('hostQuestion', '<div class="card"><p>Frage wird geladen …</p></div>'); return; }
  const mc = parseMC(q.prompt), rem = remainingSeconds(), winner = getTeam(roomState.buzzer_winner_team_id);
  const correct = hostQuestionDetails?.correct_answer || '';
  const rows = rowsForQuestion(q), visible = answersVisible(q, rem);
  const sugg = visible ? suggestionsFor(q, correct, rows) : {};
  const submittedCount = rows.filter(r => r.sub?.submitted_at).length;
  let status = '';
  if (q.question_type === 'all') status = `${submittedCount} von ${plural(teamsState.length, 'Team', 'Teams')} ${submittedCount === 1 ? 'hat' : 'haben'} geantwortet`;
  else if (q.question_type === 'buzzer' && !winner) status = roomState.buzzer_open ? 'Buzzer offen. Warte auf den ersten Buzzer …' : 'Buzzer gesperrt';
  else if (q.question_type === 'team') status = `Frage an ${safe(teamLabel(getTeam(roomState.active_team_id)))}`;

  const subsHtml = rows.map(({ team, sub }) => {
    const submitted = !!sub?.submitted_at, pts = pointsFor(team.id, sub), g = gradeOf(team.id, sub), s = sugg[team.id];
    const wager = isFinalActive() ? (parseWager(sub?.answer_text).wager ?? hostWagers[team.id]) : null;
    const ans = submitted && visible ? `<div class="submission-answer"><span>${safe(answerOnly(sub.answer_text) || '(leer)')}</span>${s ? `<span class="sug ${s.kind}">${s.label}</span>` : ''}${wager != null ? `<span class="sug">Einsatz ${wager}</span>` : ''}${jokerOn(team) ? `<span class="sug joker">🃏 Joker ${team.joker_amount}</span>` : ''}</div>
      <div class="grade">
        <button class="btn green smallbtn ${g === pts && g !== 0 ? 'is-chosen' : ''}" onclick="gradeSubmission('${team.id}',${pts})">Richtig ${signed(pts)}</button>
        <button class="btn ghost smallbtn ${g === 0 ? 'is-chosen' : ''}" onclick="gradeSubmission('${team.id}',0)">0 Punkte</button>
        <button class="btn red smallbtn ${g === -pts && g !== 0 ? 'is-chosen' : ''}" onclick="gradeSubmission('${team.id}',${-pts})">Falsch ${signed(-pts)}</button>
        ${g !== undefined ? `<span class="graded">gewertet: ${signed(g)}</span>` : ''}
      </div>` : '';
    return `<div class="submission ${s && visible ? 'sug-' + s.kind : ''}"><div class="submission-head"><div style="min-width:0">${teamBadge(team)}<div class="small ${submitted ? 'ok' : 'muted'}">${submitted ? (visible ? 'Antwort abgegeben' : 'Antwort abgegeben (verdeckt)') : 'Noch keine Abgabe'}</div></div><div class="score">${team.score} P.</div></div>${ans}</div>`;
  }).join('');

  const tools = [];
  if (q.question_type === 'buzzer' && !winner) tools.push(roomState.buzzer_open ? `<button class="btn secondary" onclick="closeBuzzer()">Buzzer sperren</button>` : `<button class="btn primary" onclick="reopenBuzzer()">Buzzer freigeben</button>`);
  if (q.question_type === 'buzzer' && winner) tools.push(`<button class="btn secondary" onclick="wrongAndReopen('${winner.id}',${pointsFor(winner.id)})">Falsch ${signed(-pointsFor(winner.id))} und neu buzzern</button>`);
  if (q.question_type === 'all' && !roomState.question_revealed && rem !== 0) tools.push(`<button class="btn secondary" onclick="revealAnswers()">Antworten jetzt aufdecken</button>`);
  const toApply = Object.entries(sugg).filter(([tid, s]) => ['match', 'nearest', 'close'].includes(s.kind) && gradeOf(tid, hostSubmissions.find(x => x.team_id === tid)) === undefined);
  const mcAuto = mc && Object.keys(sugg).length && Object.entries(sugg).some(([tid]) => gradeOf(tid, hostSubmissions.find(x => x.team_id === tid)) === undefined);
  if (mcAuto) tools.push(`<button class="btn green" onclick="applySuggestions(true)">Automatisch bewerten</button>`);
  else if (toApply.length) tools.push(`<button class="btn green" onclick="applySuggestions(false)">Vorschläge übernehmen (${toApply.length}× richtig)</button>`);
  const timerActive = (q.question_type !== 'buzzer' || winner) && rem != null && rem > 0 && !roomState.question_revealed;
  if (timerActive) { tools.push(`<button class="btn ghost" onclick="togglePause()">${roomState.question_paused ? 'Timer fortsetzen' : 'Timer pausieren'}</button>`); tools.push(`<button class="btn ghost" onclick="addTime(10)">+10 Sek.</button>`); }
  const solShown = ui.solution?.qid === q.id;
  tools.push(`<button class="btn ${solShown ? 'is-on' : 'secondary'}" onclick="toggleSolution()">${solShown ? 'Lösung verbergen' : 'Lösung allen zeigen'}</button>`);
  tools.push(isFinalActive() ? `<button class="btn primary" onclick="finishToPodium()">Zur Siegerehrung</button><button class="btn ghost" onclick="finishQuestion()">Zurück zum Board</button>` : `<button class="btn primary" onclick="finishQuestion()">Zurück zum Board</button>`);

  setHtml('hostQuestion', `<div class="question-stage ${isDoubleActive() ? 'is-double' : ''} ${isFinalActive() ? 'is-final' : ''}">
    <div class="question-meta"><div class="chips">${questionBadges(q, { forHost: true })} ${jokerChips()}</div></div>
    <div class="question-prompt">${safe(promptText(q))}</div>
    ${q.audio_url ? hostAudioBar() : ''}
    ${q.image_url ? `<div class="question-image-wrap"><img class="question-image" src="${safe(q.image_url)}" alt="Bild zur Frage"></div>` : ''}
    ${mc ? mcGrid(mc, { correctLetter: mcLetter(correct) }) : ''}
    ${timerBlock()}
    ${status ? `<div class="status-line">${status}</div>` : ''}
    ${winner ? `<div class="winner">${teamBadge(winner)} war zuerst und darf antworten.</div>` : ''}
    <div class="submission-list">${subsHtml}</div>
    <div class="solution"><strong>Lösung (nur für dich${solShown ? ', wird gerade allen gezeigt' : ''})</strong>${safe(correct || 'Keine Lösung hinterlegt.')}</div>
    <div class="question-controls"><div class="toolbar">${tools.join('')}</div></div>
  </div>`);
}
function hostAudioBar() {
  const here = soundOwner(), playing = here ? audioPlaying() : remoteAudioPlaying;
  return `<div class="audio-bar"><span>🎵 Hörfrage <span class="muted small">${here ? 'spielt hier' : 'spielt auf dem Beamer'}</span></span>
    <button class="btn smallbtn ${playing ? 'is-on' : ''}" onclick="hostAudio('toggle')">${playing ? 'Pause' : 'Abspielen'}</button>
    <button class="btn smallbtn" onclick="hostAudio('restart')">Von vorne</button></div>`;
}
function renderHostFinal() {
  const f = ui.final; const teams = sortedTeams(); const ready = new Set(f.ready || []);
  setHtml('hostFinal', `<div class="question-stage is-final">
    <div class="question-meta"><div class="chips"><span class="chip ink">Finalrunde</span><span class="chip">${safe(f.category || '')}</span></div></div>
    <div class="question-prompt" style="margin-top:22px">Kategorie: ${safe(f.category || '')}</div>
    <p class="center">Die Teams setzen jetzt auf dem Handy ihren Einsatz. Danach startest du die Frage. ${ready.size} von ${teams.length} sind bereit.</p>
    <div class="wager-list">${teams.map(t => `<div class="wager-row">${teamBadge(t)}<span class="small"><b>${t.score}</b> Punkte · ${ready.has(t.id) ? `Einsatz <b>${hostWagers[t.id] ?? 0}</b>` : 'setzt noch …'}</span></div>`).join('')}</div>
    <div class="question-controls"><div class="toolbar"><button class="btn primary" onclick="startFinalQuestion()">Frage starten</button><button class="btn ghost" onclick="cancelFinal()">Abbrechen</button></div></div>
  </div>`);
}
function renderHostPodium() {
  if (ui.recap) {
    setHtml('hostPodium', `<div class="card"><h2 class="center">Rückblick</h2>${recapHtml({ forScreen: false })}
      <div class="toolbar" style="justify-content:center;margin-top:22px"><button class="btn" onclick="hideRecap()">Zurück zur Siegerehrung</button><button class="btn red" onclick="leaveHostConfirm()">Raum schliessen</button></div></div>`);
    return;
  }
  setHtml('hostPodium', `<div class="card"><h2 class="center">Siegerehrung</h2>${podiumHtml()}
    <div class="toolbar" style="justify-content:center;margin-top:22px"><button class="btn primary" onclick="showRecap()">Rückblick zeigen</button><button class="btn" onclick="hidePodium()">Zurück zum Spiel</button><button class="btn red" onclick="leaveHostConfirm()">Raum schliessen</button></div></div>`);
}

/* Rückblick: Punkteverlauf und Auszeichnungen (vom Host berechnet und an alle verteilt) */
const LINE_COLORS = ['#d63fa5', '#2f9a4a', '#5b63e0', '#e2552a', '#1f9e96', '#b08800', '#8a4fd1', '#555'];
function buildRecap(stats) {
  const teams = sortedTeams(), qs = [...(stats.questions || [])].sort((a, b) => String(a.used_at).localeCompare(String(b.used_at))), res = stats.results || [];
  const get = (tid, qid) => res.find(r => r.team_id === tid && r.question_id === qid);
  /* Manuell vergebene Punkte (±100) zwischen den Fragen einordnen */
  const starts = qs.map(q => Date.parse(q.used_at) || 0), manual = storageJson(awardsKey(), []) || [];
  const slot = t => { let k = 0; while (k < starts.length && starts[k] <= t) k++; return k; };
  const series = teams.map(t => {
    const extra = Array(qs.length + 1).fill(0);
    manual.filter(a => a.teamId === t.id).forEach(a => { extra[slot(a.t)] += Number(a.delta) || 0; });
    let s = extra[0]; const pts = [s];
    qs.forEach((q, k) => { s += (get(t.id, q.id)?.points_awarded || 0) + extra[k + 1]; pts.push(s); });
    if (s !== t.score) pts.push(t.score);
    return { id: t.id, pts };
  });
  const len = Math.max(1, ...series.map(x => x.pts.length));
  series.forEach(x => { while (x.pts.length < len) x.pts.push(x.pts[x.pts.length - 1]); });
  const correct = {}; teams.forEach(t => { correct[t.id] = res.filter(r => r.team_id === t.id && r.points_awarded > 0).length; });
  const awards = [];
  const maxC = Math.max(0, ...Object.values(correct));
  if (maxC > 0) awards.push({ icon: '🎯', title: 'Meiste richtige Antworten', teams: teams.filter(t => correct[t.id] === maxC).map(t => t.id), detail: plural(maxC, 'richtige Antwort', 'richtige Antworten') });
  const bz = (stats.buzzes || []).filter(b => b.ms > 0).sort((a, b) => a.ms - b.ms)[0];
  if (bz) awards.push({ icon: '⚡', title: 'Schnellster Buzzer', teams: [bz.team_id], detail: (bz.ms / 1000).toFixed(1).replace('.', ',') + ' Sekunden nach dem Start' });
  const big = res.filter(r => r.points_awarded > 0).sort((a, b) => b.points_awarded - a.points_awarded)[0];
  if (big) { const q = qs.find(x => x.id === big.question_id); awards.push({ icon: '🚀', title: 'Grösster Sprung', teams: [big.team_id], detail: '+' + big.points_awarded + ' Punkte' + (q ? ' in ' + q.category : '') }); }
  const jk = teams.filter(t => t.joker_state === 'used' && t.joker_amount).sort((a, b) => b.joker_amount - a.joker_amount)[0];
  if (jk) { const r = get(jk.id, jk.joker_question_id), p = r?.points_awarded || 0; awards.push({ icon: '🃏', title: 'Mutigster Joker', teams: [jk.id], detail: jk.joker_amount + ' Punkte gesetzt' + (p > 0 ? ' und gewonnen' : p < 0 ? ' und verloren' : '') }); }
  return { series, correct, awards, n: qs.length };
}
function recapChart(r, big) {
  const W = 800, H = big ? 380 : 300, px = 44, py = 26;
  const all = r.series.flatMap(s => s.pts), min = Math.min(0, ...all), max = Math.max(1, ...all);
  const len = r.series[0]?.pts.length || 1;
  const x = i => px + (W - px - 16) * (len <= 1 ? 0 : i / (len - 1));
  const y = v => H - py - (H - 2 * py) * (v - min) / ((max - min) || 1);
  const grid = [min, 0, max].filter((v, i, a) => a.indexOf(v) === i).map(v => `<line x1="${px}" x2="${W - 16}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="#111" stroke-opacity="${v === 0 ? .35 : .12}" ${v === 0 ? '' : 'stroke-dasharray="4 5"'}/><text x="${px - 8}" y="${(y(v) + 5).toFixed(1)}" text-anchor="end" font-size="14" fill="#6b645a">${v}</text>`).join('');
  const lines = r.series.map((s, i) => `<polyline fill="none" stroke="${LINE_COLORS[i % LINE_COLORS.length]}" stroke-width="${big ? 5 : 4}" stroke-linejoin="round" stroke-linecap="round" points="${s.pts.map((v, k) => x(k).toFixed(1) + ',' + y(v).toFixed(1)).join(' ')}"/>`).join('');
  return `<svg class="recap-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Punkteverlauf aller Teams">${grid}${lines}</svg>`;
}
function awardHtml(a) {
  return `<div class="award"><div class="award-icon" aria-hidden="true">${a.icon}</div><div><div class="award-title">${safe(a.title)}</div><div class="award-teams">${a.teams.map(id => teamBadge(getTeam(id))).join(' ')}</div><div class="small muted">${safe(a.detail)}</div></div></div>`;
}
function recapHtml({ forScreen }) {
  const r = ui.recap;
  const legend = r.series.map((s, i) => `<span class="legend-item"><i style="background:${LINE_COLORS[i % LINE_COLORS.length]}"></i>${teamBadge(getTeam(s.id))}<b>${getTeam(s.id)?.score ?? ''}</b></span>`).join('');
  return `<div class="recap ${forScreen ? 'is-screen' : ''}">
    <div class="recap-chart-wrap"><h3>Punkteverlauf über ${plural(r.n, 'Frage', 'Fragen')}</h3>${recapChart(r, forScreen)}<div class="legend">${legend}</div></div>
    <div class="awards">${r.awards.map(awardHtml).join('') || '<p class="muted">Für Auszeichnungen wurden noch zu wenige Fragen gespielt.</p>'}</div>
  </div>`;
}

/* =========================================================
   Rendering: Beamer
   ========================================================= */
function screenMessage(text) { return `<div class="scr-msg">${safe(text)}</div>`; }
function joinMiniHtml() { return `<div class="scr-joinmini">${qrSvg(joinUrl())}<div>Mitspielen<br>${safe(joinHost())}<br>Code <b>${safe(current.code)}</b></div></div>`; }
function renderScreen() {
  show('screen');
  $('scrSound').textContent = !Sfx.enabled ? 'Ton: aus' : Sfx.running ? 'Ton: an' : 'Ton aktivieren';
  $('scrTools').classList.toggle('attn', Sfx.enabled && !Sfx.running);
  let html;
  if (!roomState) html = screenMessage('Verbinde …');
  else if (ui.podium) html = ui.recap ? `<div class="scr-big-center" style="justify-content:flex-start"><h1 style="margin-top:1vh">Rückblick</h1>${recapHtml({ forScreen: true })}</div>` : screenPodium();
  else if (!roomState.quiz_set_id || ui.showJoin) html = screenLobby();
  else if (roomState.active_question_id && activeQuestion) html = screenQuestion();
  else if (ui.final?.stage === 'wager') html = screenFinalWager();
  else html = screenBoard();
  setHtml('screenBody', html);
  if (isDoubleActive() && splashFor !== activeRoundKey) { splashFor = activeRoundKey; splash('Doppelte<br>Punkte!'); playFx('double'); }
}
function screenLobby() {
  const teams = teamsState;
  return `<div class="scr-head"><div class="scr-brand">MOQUIZ</div><div class="scr-title">${safe(ui.quizTitle || '')}</div></div>
  <div class="scr-lobby">
    <div>
      <h1>Mitspielen!</h1>
      <ol class="scr-steps">
        <li data-n="1">QR-Code scannen oder ${safe(joinHost())} öffnen</li>
        <li data-n="2">Diesen Code eingeben</li>
        <li data-n="3">Teamnamen und Emoji wählen</li>
      </ol>
      <div class="scr-code">${safe(current.code)}</div>
    </div>
    <div class="scr-qr">${qrSvg(joinUrl())}<div class="scr-qr-url">${safe(joinHost())}/${safe(current.code)}</div></div>
  </div>
  <div class="scr-teams"><div class="scr-count">${teams.length ? plural(teams.length, 'Team ist', 'Teams sind') + ' dabei' : 'Noch keine Teams. Los geht’s!'}</div>
  <div class="chips">${teams.map(t => `<span class="tchip">${teamBadge(t)}</span>`).join('')}</div></div>`;
}
function screenBoard() {
  const rank = ui.ranking ? screenRanking() : '';
  const armed = sortedTeams().filter(t => t.joker_state === 'armed');
  const jk = armed.length ? `<div class="scr-jokers"><span>🃏 Joker gesetzt:</span>${armed.map(t => `<span class="tchip">${teamBadge(t)}&nbsp;<b>${t.joker_amount}</b></span>`).join('')}</div>` : '';
  return `<div class="scr-head"><div><div class="scr-brand">MOQUIZ</div><div class="scr-title">${safe(ui.quizTitle || '')}</div></div>${joinMiniHtml()}</div>${jk}${boardGridHtml({ interactive: false })}${rank}`;
}
function screenRanking() {
  const teams = sortedTeams(); const max = Math.max(1, ...teams.map(t => t.score));
  return `<div class="scr-rank"><h2>Rangliste</h2><div class="scr-rank-list">${teams.map(t => `<div class="scr-rank-row"><span class="bar" style="width:${Math.max(0, t.score) / max * 100}%"></span><b>${rankOf(t.id)}.</b>${teamBadge(t)}<span class="score">${t.score}</span></div>`).join('') || '<p>Noch keine Teams.</p>'}</div></div>`;
}
function screenQuestion() {
  const q = activeQuestion, mc = parseMC(q.prompt), rem = remainingSeconds(), winner = getTeam(roomState.buzzer_winner_team_id);
  const rows = rowsForQuestion(q), visible = answersVisible(q, rem);
  const solShown = ui.solution?.qid === q.id;
  const correctL = solShown && mc ? mcLetter(ui.solution.text) : null;
  let status = '';
  if (q.question_type === 'all') { const n = rows.filter(r => r.sub?.submitted_at).length; status = `${n} / ${teamsState.length} Antworten`; }
  else if (q.question_type === 'buzzer' && !winner) status = roomState.buzzer_open ? 'Wer buzzert zuerst?' : 'Buzzer gesperrt';
  else if (q.question_type === 'team') status = `Frage an ${teamBadge(getTeam(roomState.active_team_id))}`;
  const showAnswers = q.question_type === 'all' ? visible : true;
  const answers = showAnswers ? rows.filter(r => r.sub?.submitted_at).map(({ team, sub }) => {
    const g = gradeOf(team.id, sub);
    const cls = g > 0 ? 'good' : g < 0 || (g === 0 && localGrades[activeRoundKey]?.[team.id] === 0) ? 'bad' : '';
    const w = isFinalActive() ? parseWager(sub.answer_text).wager : null;
    return `<div class="scr-ans ${cls}">${g !== undefined ? `<span class="mark">${g > 0 ? '✓' : '✗'}</span>` : ''}${teamBadge(team)}<div class="a">${safe(answerOnly(sub.answer_text) || '(leer)')}</div>${w != null ? `<div class="small"><b>Einsatz ${w}</b></div>` : ''}</div>`;
  }).join('') : '';
  return `<div class="scr-q ${isDoubleActive() ? 'is-double' : ''} ${isFinalActive() ? 'is-final' : ''}">
    <div class="chips">${questionBadges(q)} ${jokerChips()}</div>
    <div class="scr-q-main">
    <div class="scr-prompt">${safe(promptText(q))}</div>
    ${q.audio_url ? `<div class="scr-audio">${audioBlocked ? `<button class="btn primary big" onclick="screenAudioPlay()">🎵 Audio abspielen</button>` : audioPlaying() ? '🎵 Audio läuft' : '🎵 Hörfrage'}</div>` : ''}
    ${q.image_url ? `<div class="question-image-wrap"><img class="question-image" src="${safe(q.image_url)}" alt="Bild zur Frage"></div>` : ''}
    ${mc ? mcGrid(mc, { correctLetter: correctL, dimOthers: !!correctL }) : ''}
    <div class="scr-timer-row"><div class="tbar" data-tbar><i></i></div><div class="scr-timer" data-timer></div></div>
    ${winner ? `<div class="scr-winner">${teamBadge(winner)} war zuerst!</div>` : ''}
    ${status && !winner ? `<div class="scr-status">${status}</div>` : ''}
    ${answers ? `<div class="scr-answers">${answers}</div>` : ''}
    ${solShown ? `<div class="scr-solution"><small>Lösung</small>${safe(ui.solution.text || '')}</div>` : ''}
    </div>
  </div>`;
}
function screenFinalWager() {
  const ready = new Set(ui.final.ready || []);
  return `<div class="scr-big-center"><span class="chip ink" style="font-size:clamp(14px,1.3vw,24px)">Finalrunde</span><h1>${safe(ui.final.category || 'Finale')}</h1>
    <div class="sub">Setzt jetzt euren Einsatz auf dem Handy.</div>
    <div class="scr-teams"><div class="chips" style="justify-content:center">${sortedTeams().map(t => `<span class="tchip" style="${ready.has(t.id) ? '' : 'opacity:.45'}">${teamBadge(t)}${ready.has(t.id) ? '&nbsp;✓' : ''}</span>`).join('')}</div></div></div>`;
}
function screenPodium() {
  return `<div class="scr-big-center" style="justify-content:flex-start"><h1 style="margin-top:2vh">Siegerehrung</h1>${podiumHtml()}</div>`;
}

/* =========================================================
   Rendering: Spieler
   ========================================================= */
function renderPlayer() {
  show('player');
  const me = getTeam(current.teamId);
  if (me) {
    setHtml('playerTeam', teamBadge(me));
    $('playerScore').textContent = me.score + ' Punkte';
    const r = rankOf(me.id); $('playerRank').textContent = teamsState.length > 1 ? `Platz ${r} von ${teamsState.length}` : '';
  }
  let html, cls = '';
  if (!roomState) html = `<div class="waiting">Verbinde …</div>`;
  else if (ui.podium) html = playerPodium();
  else if (roomState.active_question_id && activeQuestion) { html = playerQuestion(); cls = isDoubleActive() ? 'is-double' : isFinalActive() ? 'is-final' : ''; }
  else if (ui.final?.stage === 'wager') { html = playerWager(); cls = 'is-final'; }
  else if (!roomState.quiz_set_id) html = playerLobby();
  else html = playerBoardWait();
  const body = $('playerBody'); body.className = 'player-card ' + cls;
  if (setHtml('playerBody', html)) bindPlayerBody();
}
function miniBoard() {
  return `<div class="mini-board">${sortedTeams().map(t => `<div class="wager-row ${t.id === current.teamId ? 'me' : ''}"><span><b>${rankOf(t.id)}.</b> ${teamBadge(t)}</span><span class="score">${t.score}</span></div>`).join('')}</div>`;
}
function playerLobby() {
  const me = getTeam(current.teamId); const em = me ? splitTeam(me.name).emoji : null;
  const others = teamsState.filter(t => t.id !== current.teamId);
  return `<div class="waiting">${em ? `<div class="big-emoji">${em}</div>` : ''}<div class="status-big">Ihr seid dabei!</div><div>Warte, bis der Host das Quiz startet.</div>
    ${others.length ? `<div class="chips" style="justify-content:center;margin-top:16px">${others.map(t => `<span class="chip">${safe(t.name)}</span>`).join('')}</div>` : ''}</div>`;
}
function playerBoardWait() {
  return `<div class="waiting"><div class="status-big">Schaut auf den Bildschirm</div><div>Der Host wählt die nächste Frage.</div></div>${jokerCard()}${ui.ranking ? miniBoard() : ''}`;
}
function jokerCard() {
  const me = getTeam(current.teamId); if (!me) return '';
  const st = me.joker_state || 'available', score = Math.max(0, me.score || 0);
  if (st === 'used') return `<div class="joker-card is-used"><span>🃏 Einsatz-Joker eingesetzt${me.joker_amount ? ' (' + me.joker_amount + ' Punkte)' : ''}</span></div>`;
  if (st === 'available' && score <= 0) return `<div class="joker-card is-used"><span>🃏 Den Einsatz-Joker könnt ihr setzen, sobald ihr Punkte habt.</span></div>`;
  if (st === 'armed' && !jokerOpen) return `<div class="joker-card is-armed">
      <div class="jk-head"><b>🃏 Joker gesetzt</b></div>
      <div class="wager-value">${me.joker_amount} Punkte</div>
      <p class="small">Gilt für die nächste Frage, die ihr beantworten dürft. Richtig: +${me.joker_amount}. Falsch: −${me.joker_amount}.</p>
      <div class="toolbar jk-actions"><button class="btn smallbtn" id="jokerEdit" type="button">Einsatz ändern</button><button class="btn ghost smallbtn" id="jokerDisarm" type="button">Zurücknehmen</button></div>
    </div>`;
  if (!jokerOpen) return `<div class="joker-card">
      <div class="jk-head"><b>🃏 Einsatz-Joker</b><span class="small muted">einmal pro Spiel</span></div>
      <p class="small">Setzt Punkte auf die nächste Frage, bevor ihr sie seht. Richtig: Einsatz gewonnen. Falsch: Einsatz verloren.</p>
      <button class="btn primary full" id="jokerOpen" type="button">Joker einsetzen</button>
    </div>`;
  const v = Math.min(score, Math.max(1, jokerDraft ?? (st === 'armed' ? me.joker_amount : Math.round(score / 2))));
  return `<div class="joker-card is-open">
      <div class="jk-head"><b>🃏 Wie viele Punkte setzt ihr?</b></div>
      <div class="wager-value"><span id="jokerOut">${v}</span> Punkte</div>
      <div class="small muted">Ihr habt ${score} Punkte.</div>
      <input type="range" id="jokerRange" min="1" max="${score}" step="1" value="${v}" aria-label="Einsatz für den Joker">
      <div class="wager-quick"><button class="btn ghost smallbtn" type="button" data-jw="${Math.max(1, Math.round(score / 4))}">Ein Viertel</button><button class="btn ghost smallbtn" type="button" data-jw="${Math.max(1, Math.round(score / 2))}">Hälfte</button><button class="btn ghost smallbtn" type="button" data-jw="${score}">Alles</button></div>
      <button class="btn primary big full" id="jokerArm" type="button" style="margin-top:12px">Auf die nächste Frage setzen</button>
      <button class="linkbtn" id="jokerCancel" type="button">Abbrechen</button>
    </div>`;
}
function playerPodium() {
  const r = rankOf(current.teamId);
  const title = r === 1 ? 'Ihr habt gewonnen!' : r <= 3 ? `Platz ${r}! Stark!` : `Platz ${r}`;
  const rc = ui.recap, mine = rc ? rc.awards.filter(a => a.teams.includes(current.teamId)) : [];
  const recap = rc ? `<div class="player-recap"><div><b>${plural(rc.correct?.[current.teamId] || 0, 'richtige Antwort', 'richtige Antworten')}</b> bei ${plural(rc.n, 'Frage', 'Fragen')}</div>${mine.length ? `<div class="chips" style="justify-content:center">${mine.map(a => `<span class="chip ink">${a.icon} ${safe(a.title)}</span>`).join('')}</div>` : ''}</div>` : '';
  return `<div class="waiting"><div class="big-emoji">${r === 1 ? '🏆' : r === 2 ? '🥈' : r === 3 ? '🥉' : '👏'}</div><div class="status-big">${title}</div><div>Danke fürs Mitspielen.</div>${recap}${miniBoard()}</div>`;
}
function playerWager() {
  const me = getTeam(current.teamId), maxW = Math.max(0, me?.score || 0);
  if (maxW <= 0 && myWager == null) { setTimeout(() => setWager(0), 0); }
  const w = Math.min(maxW, wagerDraft ?? myWager ?? Math.round(maxW / 2));
  const head = `<div class="player-badges"><span class="chip ink">Finalrunde</span></div><div class="player-prompt">Kategorie: ${safe(ui.final.category || '')}</div>`;
  if (maxW <= 0) return head + `<div class="waiting">Ihr habt keine Punkte zum Setzen und spielt ohne Einsatz mit. Viel Glück!</div>`;
  return head + `<p>Wie viele Punkte setzt ihr? Richtig: Einsatz gewonnen. Falsch: Einsatz verloren.</p>
    <div class="wager-value"><span id="wagerOut">${w}</span> Punkte</div>
    <input type="range" id="wagerRange" min="0" max="${maxW}" step="1" value="${w}" aria-label="Einsatz">
    <div class="wager-quick"><button class="btn ghost smallbtn" data-w="0">Nichts</button><button class="btn ghost smallbtn" data-w="${Math.round(maxW / 2)}">Hälfte</button><button class="btn ghost smallbtn" data-w="${maxW}">Alles</button></div>
    <button class="btn primary big full" id="wagerSubmit" style="margin-top:12px">${myWager == null ? 'Einsatz setzen' : 'Einsatz ändern'}</button>
    ${myWager != null ? `<div class="submitted">Einsatz gesetzt: ${myWager} Punkte. Ihr könnt ihn ändern, bis die Frage startet.</div>` : ''}`;
}
function playerQuestion() {
  const q = activeQuestion, mc = parseMC(q.prompt), winner = getTeam(roomState.buzzer_winner_team_id), selected = getTeam(roomState.active_team_id);
  const solShown = ui.solution?.qid === q.id;
  let body = `<div class="player-badges">${questionBadges(q)}</div><div class="player-prompt">${safe(promptText(q))}</div>${q.image_url ? `<img class="player-question-image" src="${safe(q.image_url)}" alt="Bild zur Frage">` : ''}`;
  const solution = solShown ? `<div class="solution"><strong>Lösung</strong>${safe(ui.solution.text || '')}</div>` : '';
  const grade = lastGrade && lastGrade.rk === activeRoundKey ? lastGrade.delta : (mySubmission?.points_awarded || undefined);
  const result = grade !== undefined && grade !== null ? `<div class="result ${grade > 0 ? 'good' : grade < 0 ? 'bad' : 'neutral'}">${grade > 0 ? 'Richtig!' : grade < 0 ? 'Leider falsch' : 'Keine Punkte'} ${signed(grade)}</div>` : '';
  const me = getTeam(current.teamId), hidden = q.fifty_hidden || [];
  const armedNote = me?.joker_state === 'armed' ? `<div class="chips" style="justify-content:center;margin-bottom:8px"><span class="chip ink">🃏 Euer Joker (${me.joker_amount}) ${q.question_type === 'buzzer' ? 'gilt, wenn ihr zuerst buzzert' : 'bleibt für eine spätere Frage gesetzt'}</span></div>` : '';
  if (q.question_type === 'buzzer' && !winner) {
    body += armedNote;
    if (q.has_buzzed) body += `<div class="status-big muted">Ihr habt bereits gebuzzert.</div><div class="waiting">Bei dieser Frage könnt ihr nicht nochmals buzzern.</div><button class="buzzer" disabled>BUZZ</button>`;
    else body += `<div class="status-big ${roomState.buzzer_open ? 'ok' : 'muted'}">${roomState.buzzer_open ? 'Buzzer offen!' : 'Buzzer gesperrt'}</div><button id="buzzButton" class="buzzer" ${roomState.buzzer_open ? '' : 'disabled'}>BUZZ</button>`;
    return body + solution;
  }
  if (q.question_type === 'buzzer' && winner?.id !== current.teamId) return body + `<div class="status-big">${safe(teamLabel(winner))} war zuerst.</div><div class="waiting">Dieses Team antwortet jetzt.</div>${armedNote}${solution}`;
  if (q.question_type === 'team' && roomState.active_team_id !== current.teamId) return body + `<div class="status-big">Diese Frage geht an ${safe(teamLabel(selected))}.</div>${armedNote}${timerBlock()}${solution}`;
  if (isFinalActive()) body += `<div class="chips" style="justify-content:center;margin-bottom:6px"><span class="chip">Euer Einsatz: ${myWager ?? 0}</span></div>`;
  body += timerBlock();
  if (mySubmission) {
    const mine = answerOnly(mySubmission.answer_text);
    body += mc ? mcGrid(mc, { correctLetter: solShown ? mcLetter(ui.solution.text) : null, chosen: mcLetter(mine), dimOthers: true, hidden }) : '';
    body += `<div class="submitted"><strong>Antwort abgegeben</strong><div class="ans">${safe(mine || '(leer)')}</div></div>`;
  } else if (roomState.question_revealed) body += `<div class="waiting">Die Antworten wurden aufgedeckt.</div>`;
  else if (mc) {
    const canFifty = me && !me.fifty_used && mc.options.length >= 3 && !hidden.length;
    body += `<div class="mc-help"><span class="small">Tippe auf eure Antwort:</span>${canFifty ? `<button class="btn smallbtn" id="fiftyBtn" type="button">50:50-Joker</button>` : hidden.length ? '<span class="chip">50:50 eingesetzt</span>' : ''}</div>${mcGrid(mc, { buttons: true, hidden })}`;
  }
  else body += `<div class="answerbox"><textarea id="playerAnswer" rows="3" placeholder="Antwort eingeben …" enterkeyhint="send" aria-label="Antwort"></textarea><button id="submitAnswer" class="btn primary big full" style="margin-top:10px">Antwort abschicken</button></div>`;
  return body + result + solution;
}
function bindPlayerBody() {
  const buzz = $('buzzButton'); if (buzz) { buzz.onpointerdown = e => { e.preventDefault(); buzzNow(); }; buzz.onclick = buzzNow; }
  const ans = $('playerAnswer');
  if (ans) {
    ans.value = draftAnswer; ans.oninput = e => { draftAnswer = e.target.value; };
    ans.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitCurrentAnswer(false); } };
  }
  const submit = $('submitAnswer'); if (submit) submit.onclick = () => submitCurrentAnswer(false);
  document.querySelectorAll('#playerBody [data-mc]').forEach(b => b.onclick = () => {
    const mc = parseMC(activeQuestion?.prompt); const o = mc?.options.find(x => x.letter === b.dataset.mc); if (!o) return;
    document.querySelectorAll('#playerBody [data-mc]').forEach(x => { x.disabled = true; x.classList.toggle('is-dim', x !== b); });
    submitCurrentAnswer(false, `${o.letter}) ${o.text}`);
  });
  const range = $('wagerRange');
  if (range) {
    range.oninput = e => { wagerDraft = +e.target.value; $('wagerOut').textContent = wagerDraft; };
    document.querySelectorAll('#playerBody [data-w]').forEach(b => b.onclick = () => { wagerDraft = +b.dataset.w; range.value = wagerDraft; $('wagerOut').textContent = wagerDraft; });
    $('wagerSubmit').onclick = () => setWager(+range.value);
  }
  const fifty = $('fiftyBtn'); if (fifty) fifty.onclick = useFifty;
  const jr = $('jokerRange');
  if (jr) {
    jr.oninput = e => { jokerDraft = +e.target.value; $('jokerOut').textContent = jokerDraft; };
    document.querySelectorAll('#playerBody [data-jw]').forEach(b => b.onclick = () => { jokerDraft = +b.dataset.jw; jr.value = jokerDraft; $('jokerOut').textContent = jokerDraft; });
    $('jokerArm').onclick = () => armJoker(+jr.value);
    $('jokerCancel').onclick = () => { jokerOpen = false; jokerDraft = null; render(); };
  }
  if ($('jokerOpen')) $('jokerOpen').onclick = () => { jokerOpen = true; jokerDraft = null; render(); };
  if ($('jokerEdit')) $('jokerEdit').onclick = () => { jokerOpen = true; jokerDraft = null; render(); };
  if ($('jokerDisarm')) $('jokerDisarm').onclick = disarmJoker;
}

/* =========================================================
   Aktionen: Host
   ========================================================= */
function showError(e) { toast(errText(e), 5000); }
async function hostCall(name, extra = {}) {
  try { await rpc(name, hostArgs(extra)); return true; }
  catch (e) { showError(e); return false; }
}
async function createRoom() {
  if (!requireAccount(createRoom)) return;
  setMsg('hostHomeError');
  $('createRoom').disabled = true;
  try {
    const data = await rpc('create_room');
    const r = data[0];
    resetRoomState();
    current = { mode: 'host', roomId: r.room_id, code: r.code, hostSecret: r.host_secret, teamId: null, teamToken: null }; saveSession();
    loadHostUi(); show('host'); render(); await startLive();
  } catch (e) { setMsg('hostHomeError', errText(e)); }
  finally { $('createRoom').disabled = false; }
}
async function selectQuiz(id) {
  if (!(await hostCall('host_select_quiz', { p_quiz_set_id: id }))) return;
  boardQuizId = null; hostDoubles = { quizId: null, ids: [] };
  const t = quizSets.find(q => q.id === id)?.title || '';
  setUi({ quizTitle: t, showJoin: false, podium: false, recap: null, final: null, solution: null, double: null });
  await refreshState();
}
async function changeQuiz() {
  if (!confirm('Ein anderes Quiz wählen? Die Punkte der Teams bleiben bestehen.')) return;
  if (!(await hostCall('host_select_quiz', { p_quiz_set_id: null }))) return;
  setUi({ quizTitle: '', final: null, double: null, solution: null });
  await refreshState();
}
async function chooseQuestion(id) {
  const q = boardQuestions.find(x => x.id === id); if (!q || usedQuestionIds.has(id)) return; setMsg('hostError');
  if (!hasContent(q)) { setMsg('hostError', 'Diese Frage ist noch leer. Ergänze sie im Editor.'); return; }
  if (q.question_type === 'team') { pendingTeamQuestion = id; openTeamPicker(); } else await startQuestion(id, null);
}
function openTeamPicker() {
  const teams = sortedTeams();
  $('teamPicker').innerHTML = teams.length ? teams.map(t => `<button class="btn secondary" onclick="pickTeamForQuestion('${t.id}')">${teamBadge(t)}</button>`).join('') : '<p class="muted">Noch keine Teams im Raum.</p>';
  $('teamModal').classList.remove('hidden');
}
function closeTeamPicker() { $('teamModal').classList.add('hidden'); pendingTeamQuestion = null; }
async function pickTeamForQuestion(teamId) { const qid = pendingTeamQuestion; closeTeamPicker(); if (qid) await startQuestion(qid, teamId); }
async function startQuestion(qid, teamId) {
  const dbl = hostDoubles.ids.includes(qid) && !(ui.final?.qid === qid);
  setUi({ double: dbl ? qid : null, solution: null, ranking: false, showJoin: false });
  if (!(await hostCall('host_start_question', { p_question_id: qid, p_team_id: teamId }))) { setUi({ double: null }); return; }
  if (dbl && current.mode === 'host' && soundOwner()) { splash('Doppelte<br>Punkte!'); playFx('double'); }
  await refreshState();
}
async function finishQuestion() {
  const qid = roomState?.active_question_id;
  if (!(await hostCall('host_finish_question'))) return;
  setUi({ solution: null, double: null, final: ui.final?.qid === qid ? null : ui.final });
  await refreshState();
}
async function finishToPodium() {
  if (!(await hostCall('host_finish_question'))) return;
  setUi({ solution: null, double: null, final: null, podium: true });
  await refreshState();
}
const closeBuzzer = async () => { await hostCall('host_close_buzzer'); await refreshState(); };
const reopenBuzzer = async () => { await hostCall('host_reopen_buzzer'); await refreshState(); };
const revealAnswers = async () => { await hostCall('host_reveal_answers'); await refreshState(); };
const addTime = async sec => { await hostCall('host_add_time', { p_seconds: sec }); await refreshState(); };
const togglePause = async () => { await hostCall('host_toggle_pause'); await refreshState(); };
async function gradeOne(teamId, delta) {
  if (!(await hostCall('host_grade_submission', { p_team_id: teamId, p_delta: delta }))) return false;
  (localGrades[activeRoundKey] ||= {})[teamId] = delta;
  sendBroadcast('grade', { teamId, delta, rk: activeRoundKey });
  return true;
}
async function gradeSubmission(teamId, delta) {
  if (await gradeOne(teamId, delta)) playFx(delta > 0 ? 'correct' : delta < 0 ? 'wrong' : '');
  await refreshState();
}
async function applySuggestions(includeWrong) {
  const q = activeQuestion; if (!q) return;
  const rows = rowsForQuestion(q), sugg = suggestionsFor(q, hostQuestionDetails?.correct_answer || '', rows);
  let good = 0;
  for (const { team, sub } of rows) {
    const s = sugg[team.id]; if (!s || gradeOf(team.id, sub) !== undefined) continue;
    if (['match', 'nearest', 'close'].includes(s.kind)) { if (await gradeOne(team.id, pointsFor(team.id, sub))) good++; }
    else if (includeWrong && s.kind === 'wrong') await gradeOne(team.id, isFinalActive() || jokerOn(team) ? -pointsFor(team.id, sub) : 0);
  }
  if (good) playFx('correct');
  toast(good ? plural(good, 'Team', 'Teams') + ' richtig bewertet' : 'Bewertet');
  await refreshState();
}
async function wrongAndReopen(teamId, points) {
  if (!(await gradeOne(teamId, -points))) return;
  playFx('wrong');
  await hostCall('host_reopen_buzzer'); await refreshState();
}
const awardsKey = () => 'moquizAwards:' + current.roomId;
async function manualAward(teamId, delta) {
  if (!(await hostCall('host_award_points', { p_team_id: teamId, p_delta: delta }))) return;
  const log = storageJson(awardsKey(), []) || []; log.push({ t: Date.now(), teamId, delta }); storageSet(awardsKey(), JSON.stringify(log.slice(-300)));
  sendBroadcast('award', { teamId, delta });
  await refreshState();
}
function toggleSolution() {
  const q = activeQuestion; if (!q) return;
  if (ui.solution?.qid === q.id) setUi({ solution: null });
  else setUi({ solution: { qid: q.id, text: hostQuestionDetails?.correct_answer || 'Keine Lösung hinterlegt.' } });
}
const toggleRanking = () => setUi({ ranking: !ui.ranking });
function showPodium() { if (confirm('Spiel beenden und Siegerehrung zeigen?')) setUi({ podium: true, ranking: false, showJoin: false }); }
const hidePodium = () => setUi({ podium: false, recap: null });
async function showRecap() {
  try { const stats = await rpc('host_get_game_stats', hostArgs()); setUi({ recap: buildRecap(stats || {}) }); }
  catch (e) { showError(e); }
}
const hideRecap = () => setUi({ recap: null });
function setDoubleCount(n) { assignDoubles(Number(n) || 0); render(); toast(Number(n) ? 'Überraschungsfelder neu verteilt' : 'Keine Überraschungsfelder'); }

/* Finalrunde */
function openFinalPicker() {
  const qs = boardQuestions.filter(q => !usedQuestionIds.has(q.id) && q.question_type === 'all' && hasContent(q));
  const catName = id => boardCategories.find(c => c.id === id)?.title || '';
  $('finalPicker').innerHTML = qs.length ? qs.sort((a, b) => b.points - a.points).map(q => `<button class="btn ghost" onclick="startFinal('${q.id}')"><span style="text-align:left"><b>${safe(catName(q.category_id))}</b> · ${q.points}<br><span class="small muted">${safe(promptText(q).slice(0, 60))}</span></span></button>`).join('')
    : '<p class="small">Für die Finalrunde braucht es eine noch nicht gespielte Frage vom Typ «Alle antworten».</p>';
  $('finalModal').classList.remove('hidden');
}
function startFinal(qid) {
  $('finalModal').classList.add('hidden');
  const q = boardQuestions.find(x => x.id === qid);
  hostWagers = {}; storageSet('moquizWagers:' + current.roomId, '{}');
  setUi({ final: { qid, stage: 'wager', category: boardCategories.find(c => c.id === q.category_id)?.title || 'Finale', ready: [] }, ranking: false, showJoin: false, double: null });
  playFx('double');
}
async function startFinalQuestion() {
  const f = ui.final; if (!f) return;
  if (!(await hostCall('host_start_question', { p_question_id: f.qid, p_team_id: null, p_no_joker: true }))) return;
  setUi({ final: { ...f, stage: 'question' }, solution: null });
  await refreshState();
}
const cancelFinal = () => setUi({ final: null });

/* Raum, Beamer, Handy-Steuerung */
function copyText(text, okMsg) {
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => toast(okMsg)).catch(() => prompt('Link kopieren:', text));
  else prompt('Link kopieren:', text);
}
const copyJoinLink = () => copyText(joinUrl(), 'Beitrittslink kopiert');
function openScreen() {
  const w = window.open('/?beamer#' + hostToken(), 'moquiz-beamer');
  if (!w) { copyText(location.origin + '/?beamer#' + hostToken(), 'Popup blockiert. Link zur Beamer-Ansicht kopiert.'); return; }
  toast('Beamer-Ansicht geöffnet. Zieh das Fenster auf den Beamer und drück F für Vollbild.', 4200);
}
const controlLink = () => location.origin + '/?steuerung#' + controlToken();
function openPhoneControl() { $('phoneQr').innerHTML = qrSvg(controlLink(), 'QR-Code für die Steuerung'); $('phoneModal').classList.remove('hidden'); }
function switchToScreen() { $('phoneModal').classList.add('hidden'); location.href = '/?beamer#' + hostToken(); }
function leaveHostConfirm() {
  if (!confirm('Raum schliessen? Du verlässt die Steuerung. Mit diesem Gerät kommst du danach nicht mehr in diesen Raum zurück.')) return;
  leaveRoom(); show('home');
}

/* =========================================================
   Aktionen: Spieler
   ========================================================= */
function renderEmojiPicker() {
  $('emojiPicker').innerHTML = TEAM_EMOJIS.map(e => `<button type="button" data-emoji="${e}" aria-pressed="${e === selectedEmoji}" aria-label="Emoji ${e}">${e}</button>`).join('');
  $('emojiPicker').querySelectorAll('button').forEach(b => b.onclick = () => { selectedEmoji = b.dataset.emoji; renderEmojiPicker(); });
}
async function joinRoom(e) {
  e?.preventDefault?.();
  const code = normaliseCode($('joinCode').value), name = $('teamName').value.trim().replace(/\s+/g, ' ');
  setMsg('joinError');
  if (code.length !== 4) { setMsg('joinError', 'Bitte den vierstelligen Raumcode eingeben.'); $('joinCode').focus(); return; }
  if (!name) { setMsg('joinError', 'Bitte einen Teamnamen eingeben.'); $('teamName').focus(); return; }
  const fullName = selectedEmoji ? selectedEmoji + ' ' + name : name;
  $('joinRoom').disabled = true;
  try {
    const data = await rpc('join_room', { p_code: code, p_name: fullName });
    const r = data[0];
    resetRoomState();
    current = { mode: 'player', roomId: r.room_id, code, hostSecret: null, teamId: r.team_id, teamToken: r.team_token }; saveSession();
    if (location.pathname !== '/') history.replaceState(null, '', '/');
    vibrate(30); show('player'); render(); await startLive();
  } catch (err) { setMsg('joinError', errText(err)); }
  finally { $('joinRoom').disabled = false; }
}
async function buzzNow() {
  const b = $('buzzButton'); if (!b || b.disabled) return;
  b.disabled = true; b.classList.add('is-pressed'); vibrate(60);
  try { await rpc('buzz', teamArgs()); } catch (e) { showError(e); }
  await refreshState();
}
async function submitCurrentAnswer(auto = false, text = null) {
  if (autoSubmitBusy || mySubmission || submittedRound === activeRoundKey) return;
  autoSubmitBusy = true;
  let answer = text ?? draftAnswer;
  if (isFinalActive()) answer = `Einsatz ${myWager ?? 0} | ${answer}`;
  const btn = $('submitAnswer'); if (btn) btn.disabled = true;
  try {
    await rpc('submit_answer', teamArgs({ p_answer: answer }));
    submittedRound = activeRoundKey; vibrate(30); toast(auto ? 'Zeit abgelaufen, Antwort abgegeben' : 'Antwort abgegeben');
  } catch (e) {
    showError(e); if (btn) btn.disabled = false;
    document.querySelectorAll('#playerBody [data-mc]').forEach(x => { x.disabled = x.classList.contains('is-gone'); x.classList.remove('is-dim'); });
  } finally { autoSubmitBusy = false; }
  await refreshState();
}
function setWager(amount) {
  if (!ui.final) return;
  const me = getTeam(current.teamId); const maxW = Math.max(0, me?.score || 0);
  myWager = Math.max(0, Math.min(maxW, Math.round(amount) || 0)); wagerDraft = null;
  storageSet('moquizWager:' + current.roomId + ':' + ui.final.qid, String(myWager));
  sendBroadcast('wager', { teamId: current.teamId, amount: myWager, qid: ui.final.qid });
  vibrate(30); render();
}
async function armJoker(amount) {
  const b = $('jokerArm'); if (b) b.disabled = true;
  try { await rpc('player_arm_joker', teamArgs({ p_amount: Math.round(amount) })); jokerOpen = false; jokerDraft = null; vibrate(30); toast('Joker gesetzt: ' + Math.round(amount) + ' Punkte'); }
  catch (e) { showError(e); if (b) b.disabled = false; }
  await refreshState();
}
async function disarmJoker() {
  try { await rpc('player_disarm_joker', teamArgs()); toast('Joker zurückgenommen'); } catch (e) { showError(e); }
  await refreshState();
}
async function useFifty() {
  if (!confirm('50:50-Joker jetzt einsetzen? Danach bleiben nur noch zwei Antworten übrig. Ihr habt ihn einmal pro Spiel.')) return;
  const b = $('fiftyBtn'); if (b) b.disabled = true;
  try { await rpc('player_use_fifty', teamArgs()); vibrate(30); } catch (e) { showError(e); if (b) b.disabled = false; }
  await refreshState();
}
const teamLink = () => location.protocol + '//' + joinHost() + '/?team#' + encodeToken({ r: current.roomId, c: current.code, t: current.teamId, k: current.teamToken });
function openTeamPhone() { $('teamPhoneQr').innerHTML = qrSvg(teamLink(), 'QR-Code für ein weiteres Handy'); $('teamPhoneModal').classList.remove('hidden'); }
function leavePlayerConfirm() {
  if (!confirm('Raum verlassen? Ihr könnt mit dem Code wieder beitreten, aber als neues Team.')) return;
  leaveRoom(); show('home');
}

/* =========================================================
   Editor
   ========================================================= */
function newQuestion(points = 100) { return { prompt: '', correct_answer: '', image_url: null, _imageFile: null, _imagePreview: null, audio_url: null, _audioFile: null, _audioPreview: null, points, question_type: 'all', duration_seconds: 30, format: 'text', options: ['', '', '', ''], correctLetter: 'A' }; }
function newCategory(title = 'Kategorie') { return { title, questions: [newQuestion(100)] }; }
function templateBoard5x5() { return Array.from({ length: 5 }, (_, ci) => ({ title: 'Kategorie ' + (ci + 1), questions: Array.from({ length: 5 }, (_, qi) => newQuestion((qi + 1) * 100)) })); }
function fromStoredQuestion(q) {
  const base = { ...newQuestion(q.points), prompt: q.prompt || '', correct_answer: q.correct_answer || '', image_url: q.image_url || null, audio_url: q.audio_url || null, points: q.points, question_type: q.question_type || 'all', duration_seconds: q.duration_seconds || 30 };
  const mc = parseMC(q.prompt);
  if (mc) {
    const opts = mc.options.map(o => o.text); while (opts.length < 4) opts.push('');
    let cl = mcLetter(q.correct_answer); if (!cl) cl = mc.options.find(o => normAnswer(o.text) === normAnswer(q.correct_answer))?.letter || 'A';
    Object.assign(base, { format: 'mc', prompt: mc.text, options: opts, correctLetter: cl });
  }
  return base;
}
function markDirty(v = true) { builderDirty = v; $('dirtyNote').classList.toggle('hidden', !v); }
window.addEventListener('beforeunload', e => { if (builderDirty && !$('builder').classList.contains('hidden')) { e.preventDefault(); e.returnValue = ''; } });
function openBuilder(returnTo = current.mode === 'host' ? 'host' : 'home') {
  if (!requireAccount(() => openBuilder(returnTo))) return;
  builderReturn = returnTo; show('builder');
  $('builderLibrary').classList.remove('hidden'); $('builderEditor').classList.add('hidden');
  renderQuizLibrary();
}
function closeBuilder() {
  show(builderReturn === 'host' && current.mode === 'host' ? 'host' : 'home');
  if (builderReturn === 'host' && current.mode === 'host') { renderHostLobby.loaded = false; loadQuizSets().catch(() => {}).finally(() => refreshState()); }
}
async function renderQuizLibrary() {
  setMsg('libraryError');
  try { await loadQuizSets(); } catch (e) { setMsg('libraryError', errText(e)); return; }
  $('quizLibrary').innerHTML = quizSets.length
    ? quizSets.map(q => `<div class="library-item"><div><strong>${safe(q.title)}</strong><div class="owner-note">In deinem Konto gespeichert</div></div><div class="library-actions"><button class="btn secondary smallbtn" onclick="editQuiz('${q.id}')">Bearbeiten</button><button class="btn ghost smallbtn" onclick="duplicateQuiz('${q.id}')">Kopieren</button><button class="btn ghost smallbtn" onclick="exportQuiz('${q.id}')">Exportieren</button><button class="btn ghost smallbtn" onclick="deleteQuiz('${q.id}')">Löschen</button></div></div>`).join('')
      + `<div class="library-foot"><button class="linkbtn" type="button" onclick="exportAllQuizzes()">Alle Quiz als Datei sichern</button></div>`
    : '<div class="empty-state"><p><strong>Noch keine Quiz gespeichert.</strong></p><p class="small">Klicke auf «Neues Quiz» und starte mit der 5×5-Vorlage, oder importiere eine MOQUIZ-Datei.</p></div>';
}
/* Export und Import als Datei (Sicherung, Weitergabe) */
function downloadFile(name, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const slug = s => String(s || 'quiz').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'quiz';
function exportShape(raw) {
  return { title: raw.title, categories: (raw.categories || []).map(c => ({ title: c.title, questions: (c.questions || []).map(q => ({
    prompt: q.prompt || '', correct_answer: q.correct_answer || '', points: q.points, question_type: q.question_type || 'all',
    duration_seconds: q.duration_seconds || 30, image_url: q.image_url || null, audio_url: q.audio_url || null })) })) };
}
async function exportQuizzes(ids) {
  const quizzes = [];
  for (const id of ids) quizzes.push(exportShape(await rpc('get_quiz_set_for_edit', { p_quiz_set_id: id, p_owner_secret: '' })));
  const name = quizzes.length === 1 ? 'moquiz-' + slug(quizzes[0].title) + '.json' : 'moquiz-alle-quiz-' + new Date().toISOString().slice(0, 10) + '.json';
  downloadFile(name, JSON.stringify({ format: 'moquiz', version: 1, exported_at: new Date().toISOString(), quizzes }, null, 2));
  return quizzes.length;
}
async function exportQuiz(id) { setMsg('libraryError'); try { await exportQuizzes([id]); toast('Quiz exportiert'); } catch (e) { setMsg('libraryError', errText(e)); } }
async function exportAllQuizzes() { setMsg('libraryError'); try { const n = await exportQuizzes(quizSets.map(q => q.id)); toast(plural(n, 'Quiz', 'Quiz') + ' exportiert'); } catch (e) { setMsg('libraryError', errText(e)); } }
function importedBoard(quiz) {
  const https = u => (typeof u === 'string' && /^https:\/\//.test(u) ? u : null);
  return (Array.isArray(quiz?.categories) ? quiz.categories : []).slice(0, 20).map(c => ({
    title: String(c?.title || 'Kategorie').slice(0, 80),
    questions: (Array.isArray(c?.questions) ? c.questions : []).slice(0, 20).map(q => ({
      prompt: String(q?.prompt ?? ''), correct_answer: String(q?.correct_answer ?? ''),
      points: Math.max(0, Math.round(Number(q?.points) || 0)),
      question_type: ['all', 'team', 'buzzer'].includes(q?.question_type) ? q.question_type : 'all',
      duration_seconds: Math.min(600, Math.max(5, Math.round(Number(q?.duration_seconds) || 30))),
      image_url: https(q?.image_url), audio_url: https(q?.audio_url),
    })),
  })).filter(c => c.questions.length);
}
async function importQuizFile(file) {
  if (!file) return; setMsg('libraryError');
  let doc; try { doc = JSON.parse(await file.text()); } catch { setMsg('libraryError', 'Die Datei konnte nicht gelesen werden. Wähle eine MOQUIZ-Datei (.json).'); return; }
  const list = doc?.format === 'moquiz' && Array.isArray(doc.quizzes) ? doc.quizzes : doc?.title && Array.isArray(doc?.categories) ? [doc] : null;
  if (!list?.length) { setMsg('libraryError', 'Das ist keine MOQUIZ-Datei. Eine passende Datei erhältst du über «Exportieren».'); return; }
  let n = 0;
  try {
    for (const quiz of list) {
      const board = importedBoard(quiz); if (!board.length) continue;
      let title = String(quiz.title || '').trim().slice(0, 120) || 'Importiertes Quiz';
      if (quizSets.some(q => q.title.toLowerCase() === title.toLowerCase())) title += ' (Import)';
      const created = await rpc('create_quiz_set', { p_title: title });
      await rpc('save_quiz_set', { p_quiz_set_id: created[0].quiz_set_id, p_owner_secret: '', p_title: title, p_board: board });
      n++;
    }
    toast(n ? plural(n, 'Quiz', 'Quiz') + ' importiert' : 'In der Datei wurden keine Fragen gefunden');
  } catch (e) { setMsg('libraryError', errText(e)); }
  await renderQuizLibrary();
}

/* Fragen aus Excel, Numbers oder Google Sheets einfügen */
let tableMode = 'add';
const TABLE_COLS = {
  category: /^(kategorie|category|thema|rubrik)$/,
  prompt: /^(frage|question|fragetext)$/,
  answer: /^(antwort|lösung|loesung|richtige antwort|answer|solution)$/,
  points: /^(punkte|points|wert|pkt\.?)$/,
  type: /^(typ|fragetyp|type|modus)$/,
  time: /^(zeit|zeit \(sek\.?\)|sekunden|sek\.?|time|seconds|dauer)$/,
  options: /^(optionen|antwortoptionen|auswahl|options|choices)$/,
};
function parseTable(text) {
  text = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const first = text.split('\n').find(l => l.trim()) || '';
  const delim = first.includes('\t') ? '\t' : (first.match(/;/g) || []).length >= (first.match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; } else cell += ch; }
    else if (ch === '"' && !cell.trim()) { inQ = true; cell = ''; }
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  row.push(cell); rows.push(row);
  return { delim, rows: rows.map(r => r.map(c => c.trim())).filter(r => r.some(Boolean)) };
}
function tableToCategories(text) {
  const { delim, rows } = parseTable(text);
  const cats = [], errors = []; let count = 0, mcCount = 0;
  if (!rows.length) return { cats, errors, count, mcCount };
  const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const head = rows[0].map(norm);
  const isHeader = head.some(h => TABLE_COLS.category.test(h) || TABLE_COLS.prompt.test(h));
  let map = {}; const optCols = [];
  if (isHeader) head.forEach((h, i) => {
    for (const [k, re] of Object.entries(TABLE_COLS)) if (map[k] == null && re.test(h)) map[k] = i;
    if (/^(option|auswahl|choice) ?[a-f1-6]$/.test(h)) optCols.push(i);
  });
  else map = { category: 0, prompt: 1, answer: 2, points: 3, type: 4, time: 5, options: 6 };
  const splitOpts = s => s.split(s.includes('|') ? '|' : delim !== ';' && s.includes(';') ? ';' : '|').map(x => x.trim());
  (isHeader ? rows.slice(1) : rows).forEach((r, ri) => {
    const line = ri + (isHeader ? 2 : 1), get = k => (map[k] != null ? r[map[k]] || '' : '').trim();
    const prompt = get('prompt');
    if (!prompt) { errors.push(`Zeile ${line}: Die Frage fehlt, die Zeile wird übersprungen.`); return; }
    const catTitle = get('category') || 'Kategorie';
    let cat = cats.find(c => c.title.toLowerCase() === catTitle.toLowerCase());
    if (!cat) { cat = { title: catTitle, questions: [] }; cats.push(cat); }
    const q = newQuestion((cat.questions.length + 1) * 100);
    q.prompt = prompt;
    const pts = parseInt(get('points').replace(/[^\d]/g, ''), 10); if (Number.isFinite(pts)) q.points = pts;
    const t = norm(get('type')); q.question_type = /buzz/.test(t) ? 'buzzer' : /team/.test(t) ? 'team' : 'all';
    const sec = parseInt(get('time'), 10); if (Number.isFinite(sec)) q.duration_seconds = Math.min(600, Math.max(5, sec));
    let opts = [];
    if (optCols.length) opts = optCols.map(i => (r[i] || '').trim());
    else if (map.options != null) {
      const rest = isHeader ? [get('options')] : r.slice(map.options).map(s => s.trim());
      const filled = rest.filter(Boolean);
      opts = filled.length === 1 ? splitOpts(filled[0]) : filled;
    }
    opts = opts.filter(Boolean);
    const answer = get('answer');
    if (opts.length >= 2) {
      if (opts.length > 4) { errors.push(`Zeile ${line}: Höchstens vier Antwortoptionen, die übrigen fallen weg.`); opts = opts.slice(0, 4); }
      let idx = opts.findIndex(o => normAnswer(o) === normAnswer(answer));
      if (idx < 0 && mcLetter(answer)) idx = MC_LETTERS.indexOf(mcLetter(answer));
      if (idx < 0 || idx >= opts.length) { errors.push(`Zeile ${line}: Die Antwort passt zu keiner Option. Gib den Buchstaben (z.B. B) oder den Text einer Option an.`); idx = 0; }
      while (opts.length < 4) opts.push('');
      Object.assign(q, { format: 'mc', options: opts, correctLetter: MC_LETTERS[idx] }); mcCount++;
    } else q.correct_answer = answer;
    cat.questions.push(q); count++;
  });
  return { cats, errors, count, mcCount };
}
function openTableImport() {
  $('tableInput').value = ''; tableMode = 'add'; setMsg('tableError'); updateTablePreview();
  $('tableModal').classList.remove('hidden'); setTimeout(() => $('tableInput').focus(), 30);
}
function updateTablePreview() {
  document.querySelectorAll('[data-tmode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tmode === tableMode)));
  const { cats, errors, count, mcCount } = tableToCategories($('tableInput').value);
  $('tablePreview').innerHTML = !count ? '<span class="muted">Noch keine Fragen erkannt.</span>'
    : `<b>Erkannt: ${plural(cats.length, 'Kategorie', 'Kategorien')} mit ${plural(count, 'Frage', 'Fragen')}</b>${mcCount ? `, davon ${mcCount} Multiple Choice` : ''}.`
      + (errors.length ? `<ul class="table-warn">${errors.slice(0, 4).map(e => `<li>${safe(e)}</li>`).join('')}${errors.length > 4 ? `<li>und ${errors.length - 4} weitere Hinweise</li>` : ''}</ul>` : '');
}
function applyTableImport() {
  const { cats, errors, count } = tableToCategories($('tableInput').value); setMsg('tableError');
  if (!count) { setMsg('tableError', 'Keine Fragen erkannt. Jede Zeile braucht mindestens eine Kategorie und eine Frage.'); return; }
  if (errors.length && !confirm(plural(errors.length, 'Zeile hat', 'Zeilen haben') + ' einen Hinweis (siehe Liste). Trotzdem übernehmen?')) return;
  const filled = q => (q.prompt || '').trim() || q.image_url || q._imageFile || q.audio_url || q._audioFile;
  const boardEmpty = builderState.categories.every(c => !c.questions.some(filled));
  if (tableMode === 'replace' && !boardEmpty && !confirm('Alle bisherigen Kategorien und Fragen durch die Tabelle ersetzen?')) return;
  if (tableMode === 'replace' || boardEmpty) builderState.categories = cats;
  else cats.forEach(c => {
    const ex = builderState.categories.find(x => x.title.trim().toLowerCase() === c.title.toLowerCase());
    if (ex) ex.questions = ex.questions.filter(filled).concat(c.questions); else builderState.categories.push(c);
  });
  $('tableModal').classList.add('hidden'); builderOpen = new Set(); markDirty(); renderCategoryEditors();
  const tooMany = builderState.categories.length > 20 || builderState.categories.some(c => c.questions.length > 20);
  setMsg('builderError', tooMany ? 'Achtung: Ein Quiz kann höchstens 20 Kategorien mit je 20 Fragen haben. Kürze es vor dem Speichern.' : '');
  toast(plural(count, 'Frage', 'Fragen') + ' übernommen. Speichern nicht vergessen.', 3500);
}
function downloadTableTemplate() {
  const rows = [
    ['Kategorie', 'Frage', 'Antwort', 'Punkte', 'Typ', 'Zeit', 'Optionen'],
    ['Geografie', 'Wie heisst die Hauptstadt der Schweiz?', 'Bern', '100', 'Alle', '30', ''],
    ['Geografie', 'Welcher Fluss fliesst durch Basel?', 'B', '200', 'Alle', '20', 'Aare | Rhein | Rhone | Limmat'],
    ['Geografie', 'Wie hoch ist das Matterhorn in Metern?', '4478', '300', 'Alle', '30', ''],
    ['Musik', 'Wer singt «Hallelujah» im Original?', 'Leonard Cohen', '100', 'Buzzer', '15', ''],
    ['Musik', 'Aus welchem Land stammt die Band ABBA?', 'Schweden', '200', 'Ein Team', '30', ''],
  ];
  const csv = '\uFEFF' + rows.map(r => r.map(c => /[;"\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c).join(';')).join('\r\n');
  downloadFile('moquiz-vorlage.csv', csv, 'text/csv;charset=utf-8');
}

function startNewQuiz() {
  if (!requireAccount(startNewQuiz)) return;
  builderState = { id: null, title: '', categories: templateBoard5x5() }; builderOpen = new Set(['0:0']); openBuilderEditor(); markDirty(false);
}
async function editQuiz(id) {
  if (!requireAccount(() => editQuiz(id))) return;
  try {
    const raw = await rpc('get_quiz_set_for_edit', { p_quiz_set_id: id, p_owner_secret: '' });
    builderState = { id: raw.id, title: raw.title, categories: (raw.categories || []).map(c => ({ title: c.title, questions: (c.questions || []).map(fromStoredQuestion) })) };
    builderOpen = new Set(); openBuilderEditor(); markDirty(false);
  } catch (e) { setMsg('libraryError', errText(e)); }
}
async function duplicateQuiz(id) {
  try {
    const raw = await rpc('get_quiz_set_for_edit', { p_quiz_set_id: id, p_owner_secret: '' });
    const created = await rpc('create_quiz_set', { p_title: raw.title + ' (Kopie)' });
    const board = (raw.categories || []).map(c => ({ title: c.title, questions: (c.questions || []).map(q => ({ prompt: q.prompt || '', correct_answer: q.correct_answer || '', image_url: q.image_url || null, audio_url: q.audio_url || null, points: q.points, question_type: q.question_type, duration_seconds: q.duration_seconds })) }));
    await rpc('save_quiz_set', { p_quiz_set_id: created[0].quiz_set_id, p_owner_secret: '', p_title: raw.title + ' (Kopie)', p_board: board });
    toast('Kopie erstellt'); renderQuizLibrary();
  } catch (e) { setMsg('libraryError', errText(e)); }
}
function openBuilderEditor() {
  $('builderLibrary').classList.add('hidden'); $('builderEditor').classList.remove('hidden');
  $('builderHeading').textContent = builderState.id ? 'Quiz bearbeiten' : 'Neues Quiz';
  $('quizTitle').value = builderState.title; setMsg('builderError'); renderCategoryEditors();
}
function questionSummary(q) {
  const img = q._imagePreview || q.image_url;
  const aud = q._audioPreview || q.audio_url;
  const bits = [q.points + ' Punkte', typeLabel(q.question_type)]; if (q.format === 'mc') bits.push('MC'); if (img) bits.push('Bild'); if (aud) bits.push('Audio');
  const preview = q.prompt ? q.prompt.slice(0, 50) + (q.prompt.length > 50 ? '…' : '') : (img ? 'Bildfrage' : aud ? 'Hörfrage' : 'Noch leer');
  return `<span>${bits.join(' · ')}</span><span class="muted small">${safe(preview)}</span>`;
}
function questionEditorHtml(q, ci, qi) {
  const key = ci + ':' + qi, img = q._imagePreview || q.image_url || '', aud = q._audioPreview || q.audio_url || '';
  const answerPart = q.format === 'mc'
    ? `<label>Antwortoptionen</label><div class="field-help" style="margin-top:0">Mindestens zwei Optionen ausfüllen und die richtige mit dem Punkt markieren.</div>
       ${q.options.map((o, oi) => `<div class="opt-row"><input type="radio" name="c${ci}q${qi}" data-correct="${key}:${oi}" ${q.correctLetter === MC_LETTERS[oi] ? 'checked' : ''} aria-label="Option ${MC_LETTERS[oi]} ist richtig"><span class="mc-letter mc-${oi}">${MC_LETTERS[oi]}</span><input data-opt="${key}:${oi}" value="${safe(o)}" placeholder="Option ${MC_LETTERS[oi]}"></div>`).join('')}`
    : `<label>Richtige Antwort</label><input data-q="${key}:correct_answer" value="${safe(q.correct_answer)}" placeholder="z.B. Biel / Bienne">
       <div class="field-help">Mehrere richtige Antworten mit / trennen. Ist die Lösung eine Zahl, wird es eine Schätzfrage: MOQUIZ schlägt dir die nächste Antwort vor.</div>`;
  return `<details class="question-editor" data-open="${key}" ${builderOpen.has(key) ? 'open' : ''}><summary>${questionSummary(q)}</summary><div class="question-editor-body">
    <label>Frage</label><textarea data-q="${key}:prompt" placeholder="Frage eingeben …">${safe(q.prompt)}</textarea>
    <label>Antwortformat</label><div class="segmented" role="group"><button type="button" data-format="${key}:text" aria-pressed="${q.format !== 'mc'}">Freitext</button><button type="button" data-format="${key}:mc" aria-pressed="${q.format === 'mc'}">Multiple Choice</button></div>
    ${answerPart}
    <div class="image-editor"><div class="image-editor-row"><div><label>Bild zur Frage (optional)</label><input type="file" accept="image/jpeg,image/png,image/webp,image/gif" data-img="${key}"><div class="field-help">Ideal für Kartenausschnitte, Fotos oder Logos. Max. 8 MB.</div></div>${img ? `<button class="danger-link" type="button" onclick="removeQuestionImage(${ci},${qi})">Bild entfernen</button>` : ''}</div>${img ? `<div class="image-preview"><img src="${safe(img)}" alt="Vorschau"></div>` : ''}</div>
    <div class="image-editor"><div class="image-editor-row"><div><label>Audio zur Frage (optional)</label><input type="file" accept="audio/mpeg,audio/mp4,audio/x-m4a,audio/aac,audio/wav,audio/ogg,audio/webm,.mp3,.m4a,.aac,.wav,.ogg" data-audio="${key}"><div class="field-help">Läuft auf dem Beamer, zum Beispiel für Musikfragen. MP3 oder M4A, max. 15 MB.</div></div>${aud ? `<button class="danger-link" type="button" onclick="removeQuestionAudio(${ci},${qi})">Audio entfernen</button>` : ''}</div>${aud ? `<audio class="audio-preview" controls preload="none" src="${safe(aud)}"></audio>` : ''}</div>
    <div class="mini-grid">
      <div><label>Punkte</label><input type="number" min="0" step="50" data-q="${key}:points" value="${q.points}"></div>
      <div><label>Fragetyp</label><select data-q="${key}:question_type"><option value="all" ${q.question_type === 'all' ? 'selected' : ''}>Alle antworten</option><option value="team" ${q.question_type === 'team' ? 'selected' : ''}>Ein Team</option><option value="buzzer" ${q.question_type === 'buzzer' ? 'selected' : ''}>Buzzer</option></select><div class="field-help">${TYPE_HELP[q.question_type] || ''}</div></div>
      <div><label>Zeit (Sek.)</label><input type="number" min="5" max="600" data-q="${key}:duration_seconds" value="${q.duration_seconds}"></div>
    </div>
    <div class="toolbar" style="margin-top:12px"><button class="danger-link" type="button" onclick="removeQuestion(${ci},${qi})">Frage löschen</button></div>
  </div></details>`;
}
function renderCategoryEditors() {
  $('categoryEditors').innerHTML = builderState.categories.map((c, ci) => `<div class="category-editor"><div class="category-editor-head"><div><label>Kategorie ${ci + 1}</label><input data-cat-title="${ci}" value="${safe(c.title)}"></div><button class="danger-link" type="button" onclick="removeCategory(${ci})">Kategorie löschen</button></div>
    <div>${c.questions.map((q, qi) => questionEditorHtml(q, ci, qi)).join('')}</div>
    <button class="btn secondary smallbtn" type="button" style="margin-top:10px" onclick="addQuestion(${ci})">+ Frage</button></div>`).join('');
  const root = $('categoryEditors');
  root.querySelectorAll('[data-open]').forEach(d => d.ontoggle = () => { d.open ? builderOpen.add(d.dataset.open) : builderOpen.delete(d.dataset.open); });
  root.querySelectorAll('[data-cat-title]').forEach(el => el.oninput = e => { builderState.categories[+e.target.dataset.catTitle].title = e.target.value; markDirty(); });
  root.querySelectorAll('[data-q]').forEach(el => {
    const handler = e => {
      const [ci, qi, f] = e.target.dataset.q.split(':'); let v = e.target.value;
      if (f === 'points' || f === 'duration_seconds') v = Number(v) || 0;
      const q = builderState.categories[+ci].questions[+qi]; q[f] = v; markDirty();
      const sum = e.target.closest('details')?.querySelector('summary'); if (sum) sum.innerHTML = questionSummary(q);
      if (f === 'question_type') { const help = e.target.parentElement.querySelector('.field-help'); if (help) help.textContent = TYPE_HELP[v] || ''; }
    };
    el.oninput = handler; if (el.tagName === 'SELECT') el.onchange = handler;
  });
  root.querySelectorAll('[data-opt]').forEach(el => el.oninput = e => { const [ci, qi, oi] = e.target.dataset.opt.split(':').map(Number); builderState.categories[ci].questions[qi].options[oi] = e.target.value; markDirty(); });
  root.querySelectorAll('[data-correct]').forEach(el => el.onchange = e => { const [ci, qi, oi] = e.target.dataset.correct.split(':').map(Number); builderState.categories[ci].questions[qi].correctLetter = MC_LETTERS[oi]; markDirty(); });
  root.querySelectorAll('[data-format]').forEach(el => el.onclick = e => {
    const [ci, qi, f] = e.currentTarget.dataset.format.split(':'); const q = builderState.categories[+ci].questions[+qi];
    if (q.format === f) return; q.format = f; builderOpen.add(ci + ':' + qi); markDirty(); renderCategoryEditors();
  });
  root.querySelectorAll('[data-img]').forEach(el => el.onchange = e => {
    const file = e.target.files?.[0]; if (!file) return;
    if (file.size > 8 * 1024 * 1024) { setMsg('builderError', 'Das Bild darf maximal 8 MB gross sein.'); e.target.value = ''; return; }
    const [ci, qi] = e.target.dataset.img.split(':').map(Number); const q = builderState.categories[ci].questions[qi];
    if (q._imagePreview) URL.revokeObjectURL(q._imagePreview);
    q._imageFile = file; q._imagePreview = URL.createObjectURL(file); builderOpen.add(ci + ':' + qi); markDirty(); renderCategoryEditors();
  });
  root.querySelectorAll('[data-audio]').forEach(el => el.onchange = e => {
    const file = e.target.files?.[0]; if (!file) return;
    if (!audioMime(file)) { setMsg('builderError', 'Bitte eine Audiodatei wählen (MP3, M4A, WAV oder OGG).'); e.target.value = ''; return; }
    if (file.size > 15 * 1024 * 1024) { setMsg('builderError', 'Die Audiodatei darf maximal 15 MB gross sein.'); e.target.value = ''; return; }
    const [ci, qi] = e.target.dataset.audio.split(':').map(Number); const q = builderState.categories[ci].questions[qi];
    if (q._audioPreview) URL.revokeObjectURL(q._audioPreview);
    q._audioFile = file; q._audioPreview = URL.createObjectURL(file); builderOpen.add(ci + ':' + qi); setMsg('builderError'); markDirty(); renderCategoryEditors();
  });
}
const AUDIO_TYPES = { mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', webm: 'audio/webm' };
function audioMime(file) {
  if (/^audio\//.test(file.type || '')) return file.type;
  return AUDIO_TYPES[(file.name.split('.').pop() || '').toLowerCase()] || null;
}
function removeQuestionAudio(ci, qi) { const q = builderState.categories[ci].questions[qi]; if (q._audioPreview) URL.revokeObjectURL(q._audioPreview); Object.assign(q, { _audioFile: null, _audioPreview: null, audio_url: null }); markDirty(); renderCategoryEditors(); }
function addCategory() { builderState.categories.push(newCategory('Kategorie ' + (builderState.categories.length + 1))); markDirty(); renderCategoryEditors(); }
function removeCategory(ci) {
  if (builderState.categories.length === 1) { toast('Mindestens eine Kategorie behalten'); return; }
  if (!confirm('Kategorie «' + builderState.categories[ci].title + '» mit allen Fragen löschen?')) return;
  builderState.categories.splice(ci, 1); builderOpen = new Set(); markDirty(); renderCategoryEditors();
}
function addQuestion(ci) { const qs = builderState.categories[ci].questions; const last = qs.at(-1)?.points || 0; qs.push(newQuestion(last ? last + 100 : 100)); builderOpen.add(ci + ':' + (qs.length - 1)); markDirty(); renderCategoryEditors(); }
function removeQuestion(ci, qi) {
  builderState.categories[ci].questions.splice(qi, 1);
  if (!builderState.categories[ci].questions.length) builderState.categories[ci].questions.push(newQuestion(100));
  builderOpen = new Set(); markDirty(); renderCategoryEditors();
}
function removeQuestionImage(ci, qi) { const q = builderState.categories[ci].questions[qi]; if (q._imagePreview) URL.revokeObjectURL(q._imagePreview); Object.assign(q, { _imageFile: null, _imagePreview: null, image_url: null }); markDirty(); renderCategoryEditors(); }
async function uploadQuestionImage(file, quizId, contentType = file.type) {
  await ensureDb();
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  if (!authUser) throw new Error('Bitte zuerst anmelden');
  const path = authUser.id + '/' + quizId + '/' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12) + '.' + ext;
  const { error } = await db.storage.from('quiz-question-images').upload(path, file, { cacheControl: '3600', upsert: false, contentType: contentType || undefined });
  if (error) throw error;
  return db.storage.from('quiz-question-images').getPublicUrl(path).data.publicUrl;
}
async function uploadPendingQuestionImages() {
  const jobs = [];
  builderState.categories.forEach(c => c.questions.forEach(q => {
    if (q._imageFile) jobs.push((async () => { q.image_url = await uploadQuestionImage(q._imageFile, builderState.id); q._imageFile = null; if (q._imagePreview) { URL.revokeObjectURL(q._imagePreview); q._imagePreview = null; } })());
    if (q._audioFile) jobs.push((async () => { q.audio_url = await uploadQuestionImage(q._audioFile, builderState.id, audioMime(q._audioFile)); q._audioFile = null; if (q._audioPreview) { URL.revokeObjectURL(q._audioPreview); q._audioPreview = null; } })());
  }));
  await Promise.all(jobs);
}
function cleanBoard() {
  const errors = [];
  const board = builderState.categories.map((c, ci) => ({
    title: c.title.trim(),
    questions: c.questions.map((q, qi) => {
      let prompt = q.prompt || '', correct = q.correct_answer || '';
      if (q.format === 'mc') {
        const filled = q.options.map((o, oi) => ({ o: o.trim(), oi })).filter(x => x.o);
        const where = `Kategorie ${ci + 1}, Frage ${qi + 1}`;
        if (filled.length < 2) errors.push(where + ': Multiple Choice braucht mindestens zwei Optionen.');
        const ci2 = filled.findIndex(x => MC_LETTERS[x.oi] === q.correctLetter);
        if (filled.length >= 2 && ci2 < 0) errors.push(where + ': Die als richtig markierte Option ist leer.');
        if (filled.length >= 2) { prompt = composeMC(prompt, filled.map(x => x.o)); correct = ci2 >= 0 ? MC_LETTERS[ci2] + ') ' + filled[ci2].o : ''; }
      }
      return { prompt, correct_answer: correct, image_url: q.image_url || null, audio_url: q.audio_url || null, points: Math.max(0, Number(q.points) || 0), question_type: q.question_type || 'all', duration_seconds: Math.min(600, Math.max(5, Number(q.duration_seconds) || 30)) };
    }),
  }));
  return { board, errors };
}
async function saveQuiz() {
  if (!requireAccount(saveQuiz)) return;
  builderState.title = $('quizTitle').value.trim(); setMsg('builderError');
  if (!builderState.title) { setMsg('builderError', 'Bitte einen Titel eingeben.'); $('quizTitle').focus(); return; }
  if (builderState.categories.some(c => !c.title.trim())) { setMsg('builderError', 'Bitte jeder Kategorie einen Namen geben.'); return; }
  const { errors } = cleanBoard(); if (errors.length) { setMsg('builderError', errors[0]); return; }
  $('saveQuiz').disabled = $('saveQuizBottom').disabled = true;
  try {
    if (!builderState.id) { const data = await rpc('create_quiz_set', { p_title: builderState.title }); builderState.id = data[0].quiz_set_id; }
    await uploadPendingQuestionImages();
    const { board } = cleanBoard();
    await rpc('save_quiz_set', { p_quiz_set_id: builderState.id, p_owner_secret: '', p_title: builderState.title, p_board: board });
    boardQuizId = null; markDirty(false); toast('Quiz gespeichert');
    await renderQuizLibrary(); $('builderEditor').classList.add('hidden'); $('builderLibrary').classList.remove('hidden');
  } catch (e) { setMsg('builderError', errText(e)); }
  finally { $('saveQuiz').disabled = $('saveQuizBottom').disabled = false; }
}
async function deleteQuiz(id) {
  if (!requireAccount(() => deleteQuiz(id))) return;
  const t = quizSets.find(q => q.id === id)?.title || 'dieses Quiz';
  if (!confirm('«' + t + '» wirklich löschen?')) return;
  try { await rpc('delete_quiz_set', { p_quiz_set_id: id, p_owner_secret: '' }); boardQuizId = null; await renderQuizLibrary(); toast('Quiz gelöscht'); }
  catch (e) { setMsg('libraryError', errText(e)); }
}
function leaveEditor() {
  if (builderDirty && !confirm('Ungespeicherte Änderungen verwerfen?')) return;
  markDirty(false); $('builderEditor').classList.add('hidden'); $('builderLibrary').classList.remove('hidden'); renderQuizLibrary();
}

/* =========================================================
   Takt (Timer, Töne, automatische Abgabe)
   ========================================================= */
function tick() {
  if (!current.roomId || !roomState) return;
  const rem = remainingSeconds();
  if (roomState.active_question_id && rem != null && !roomState.question_paused) roundTotal = Math.max(roundTotal, rem);
  updateTimers();
  if (roomState.active_question_id && rem != null && lastRem != null && rem !== lastRem && !roomState.question_paused) {
    if (rem > 0 && rem <= 5) playFx('tick');
    if (rem === 0 && lastRem > 0) { playFx('end'); if (current.mode === 'player' && canAnswerNow() && !mySubmission) vibrate(200); }
  }
  const changedToZero = rem === 0 && lastRem !== 0;
  lastRem = rem;
  if (hostLike() && activeQuestion?.question_type === 'all' && changedToZero) render();
  if (current.mode === 'player' && roomState.active_question_id && activeQuestion) {
    if (canAnswerNow() && !mySubmission && !roomState.question_revealed && !roomState.question_paused && rem === 0) submitCurrentAnswer(true);
  }
}
setInterval(tick, 250);

/* =========================================================
   Ereignisse und Start
   ========================================================= */
function exposeGlobals() {
  Object.assign(window, {
    chooseQuestion, pickTeamForQuestion, finishQuestion, finishToPodium, removeQuestionImage, closeBuzzer, reopenBuzzer, revealAnswers, addTime, togglePause,
    gradeSubmission, applySuggestions, wrongAndReopen, manualAward, toggleSolution, toggleRanking, showPodium, hidePodium, setDoubleCount,
    openFinalPicker, startFinal, startFinalQuestion, cancelFinal, selectQuiz, changeQuiz, openBuilder, openScreen, copyJoinLink, leaveHostConfirm,
    editQuiz, duplicateQuiz, deleteQuiz, removeCategory, addQuestion, removeQuestion, removeQuestionAudio,
    showRecap, hideRecap, hostAudio, screenAudioPlay, exportQuiz, exportAllQuizzes,
  });
}
function bindStatic() {
  $('accountButton').onclick = () => { if (authUser) { if (confirm('Von ' + accountName() + ' abmelden?')) signOutAccount(); } else openAuthModal(); };
  $('closeAuth').onclick = closeAuthModal;
  $('authForm').onsubmit = e => { e.preventDefault(); loginAccount(); };
  $('authSignup').onclick = signupAccount;
  $('brandHome').onclick = () => { if (!current.mode) show('home'); };
  $('joinForm').onsubmit = joinRoom;
  $('joinCode').oninput = e => { const v = normaliseCode(e.target.value); e.target.value = v; if (v.length === 4 && document.activeElement === e.target) $('teamName').focus(); };
  $('createRoom').onclick = createRoom;
  $('openBuilder').onclick = () => openBuilder('home');
  $('homeBuilder').onclick = () => openBuilder('home');
  $('builderBack').onclick = closeBuilder;
  $('newQuiz').onclick = startNewQuiz;
  $('editorCancel').onclick = leaveEditor;
  $('addCategory').onclick = addCategory;
  $('saveQuiz').onclick = saveQuiz; $('saveQuizBottom').onclick = saveQuiz;
  $('quizTitle').oninput = e => { if (builderState) { builderState.title = e.target.value; markDirty(); } };
  $('template5x5').onclick = () => { if (confirm('Aktuelle Kategorien durch eine leere 5×5-Vorlage ersetzen?')) { builderState.categories = templateBoard5x5(); builderOpen = new Set(['0:0']); markDirty(); renderCategoryEditors(); } };
  $('hostBuilderShortcut').onclick = () => openBuilder('host');
  $('openScreen').onclick = openScreen;
  $('phoneControl').onclick = openPhoneControl;
  $('closePhone').onclick = () => $('phoneModal').classList.add('hidden');
  $('switchToScreen').onclick = switchToScreen;
  $('copyControlLink').onclick = () => copyText(controlLink(), 'Steuerungslink kopiert');
  $('toggleJoinInfo').onclick = () => setUi({ showJoin: !ui.showJoin });
  $('soundToggle').onclick = () => { Sfx.enabled = !Sfx.enabled; render(); };
  $('leaveHost').onclick = leaveHostConfirm;
  $('leavePlayer').onclick = leavePlayerConfirm;
  $('addPhone').onclick = openTeamPhone;
  $('closeTeamPhone').onclick = () => $('teamPhoneModal').classList.add('hidden');
  $('copyTeamLink').onclick = () => copyText(teamLink(), 'Link fürs Team kopiert');
  $('openKeys').onclick = openKeys;
  $('closeKeys').onclick = () => $('keysModal').classList.add('hidden');
  $('importQuiz').onclick = () => $('importFile').click();
  $('importFile').onchange = e => { const f = e.target.files?.[0]; e.target.value = ''; importQuizFile(f); };
  $('openTableImport').onclick = openTableImport;
  $('closeTable').onclick = () => $('tableModal').classList.add('hidden');
  $('tableInput').oninput = updateTablePreview;
  document.querySelectorAll('[data-tmode]').forEach(b => b.onclick = () => { tableMode = b.dataset.tmode; updateTablePreview(); });
  $('tableApply').onclick = applyTableImport;
  $('tableTemplate').onclick = downloadTableTemplate;
  $('cancelTeamPicker').onclick = closeTeamPicker;
  $('cancelFinal').onclick = () => $('finalModal').classList.add('hidden');
  $('scrSound').onclick = () => { if (Sfx.enabled && !Sfx.running) Sfx.unlock(); else Sfx.enabled = !Sfx.enabled; setTimeout(render, 80); };
  $('scrFull').onclick = toggleFullscreen;
  document.addEventListener('keydown', e => {
    if (current.mode === 'screen' && (e.key === 'f' || e.key === 'F') && !e.metaKey && !e.ctrlKey) toggleFullscreen();
    if (e.key === 'Escape') { document.querySelectorAll('.modal:not(.hidden)').forEach(m => { if (m.id !== 'authModal') m.classList.add('hidden'); else closeAuthModal(); }); return; }
    onHostKey(e);
  });
  document.addEventListener('pointerdown', () => { if (hostLike()) { const was = Sfx.running; Sfx.unlock(); if (!was && current.mode === 'screen') setTimeout(render, 80); } }, { passive: true });
}
const SHORTCUTS = [
  ['Leertaste', 'Timer pausieren oder fortsetzen'], ['L', 'Lösung allen zeigen oder verbergen'], ['A', 'Antworten jetzt aufdecken'],
  ['V', 'Vorschläge übernehmen oder automatisch bewerten'], ['+', '10 Sekunden mehr'], ['P', 'Audio abspielen oder pausieren'],
  ['B', 'Zurück zum Board'], ['R', 'Rangliste zeigen oder ausblenden'], ['?', 'Diese Übersicht'],
];
function openKeys() {
  $('keysList').innerHTML = SHORTCUTS.map(([k, d]) => `<div class="key-row"><kbd>${safe(k)}</kbd><span>${safe(d)}</span></div>`).join('');
  $('keysModal').classList.remove('hidden');
}
function onHostKey(e) {
  if (current.mode !== 'host' || !roomState || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target, tag = t?.tagName || '';
  if (t?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
  if ($('host').classList.contains('hidden') || document.querySelector('.modal:not(.hidden)')) return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key, q = roomState.active_question_id ? activeQuestion : null;
  const rem = remainingSeconds(), winner = roomState.buzzer_winner_team_id;
  let act = null;
  if (k === ' ' && tag !== 'BUTTON' && q && (q.question_type !== 'buzzer' || winner) && rem > 0 && !roomState.question_revealed) act = togglePause;
  else if (k === 'l' && q) act = toggleSolution;
  else if (k === 'a' && q?.question_type === 'all' && !roomState.question_revealed && rem !== 0) act = revealAnswers;
  else if (k === 'v' && q) act = () => applySuggestions(!!parseMC(q.prompt));
  else if (k === '+' && q && rem != null) act = () => addTime(10);
  else if (k === 'p' && q?.audio_url) act = () => hostAudio('toggle');
  else if (k === 'b' && q) act = finishQuestion;
  else if (k === 'r' && !q && !ui.podium && roomState.quiz_set_id) act = toggleRanking;
  else if (k === '?') act = openKeys;
  if (act) { e.preventDefault(); act(); }
}
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.(); else document.documentElement.requestFullscreen?.().catch(() => {});
  Sfx.unlock();
}
async function resumeHost() { loadHostUi(); show('host'); render(); await startLive(); }

(async function init() {
  exposeGlobals(); bindStatic(); renderEmojiPicker();
  const url = new URL(location.href);
  const path = location.pathname.replace(/^\/+|\/+$/g, '');
  const pathCode = /^[A-Za-z0-9]{4}$/.test(path) ? normaliseCode(path) : '';
  const joinCode = pathCode || normaliseCode(url.searchParams.get('join') || '');
  const token = location.hash.length > 1 ? decodeToken(location.hash.slice(1)) : null;
  const wantsScreen = url.searchParams.has('beamer');
  const wantsControl = url.searchParams.has('steuerung');
  const wantsTeam = url.searchParams.has('team');
  if (joinCode) $('joinCode').value = joinCode;
  show(wantsScreen ? 'screen' : 'home'); updateAuthUI();

  try {
    await ensureDb();
    const { data: { session } } = await db.auth.getSession();
    authUser = session?.user || null; updateAuthUI();
    db.auth.onAuthStateChange((_event, newSession) => {
      authUser = newSession?.user || null; updateAuthUI();
      if (authUser) setTimeout(() => { claimLegacyQuizSets().then(() => loadQuizSets()).catch(() => {}); }, 0);
    });
    if (authUser) { await claimLegacyQuizSets(); try { await loadQuizSets(); } catch { /* später */ } }
  } catch (e) {
    console.error(e); setMsg(wantsScreen ? 'hostError' : 'hostHomeError', connectionErrorText());
  }

  /* Beamer-Ansicht */
  if (wantsScreen) {
    const saved = readSavedSession();
    const src = token?.r ? { roomId: token.r, code: token.c, hostSecret: token.s } : saved?.mode === 'host' ? saved : null;
    if (!src) { setHtml('screenBody', screenMessage('Öffne die Beamer-Ansicht über die Host-Steuerung («Beamer-Ansicht öffnen»).')); return; }
    current = { mode: 'screen', roomId: src.roomId, code: src.code, hostSecret: src.hostSecret, teamId: null, teamToken: null };
    document.title = 'MOQUIZ Beamer · ' + src.code;
    render(); await startLive(); return;
  }

  /* Steuerung von einem anderen Gerät übernehmen */
  if (wantsControl && token?.r) {
    current = { mode: 'host', roomId: token.r, code: token.c, hostSecret: token.s, teamId: null, teamToken: null }; saveSession();
    if (token.q && Array.isArray(token.d)) storageSet('moquizDoubles:' + token.r + ':' + token.q, JSON.stringify({ count: token.n ?? token.d.length, ids: token.d }));
    history.replaceState(null, '', '/');
  }

  /* Weiteres Handy für ein bestehendes Team */
  if (wantsTeam && token?.r && token.t && token.k) {
    const before = readSavedSession();
    if (before?.mode === 'host' && before.roomId === token.r) { /* Host-Gerät bleibt Host */ }
    else { current = { mode: 'player', roomId: token.r, code: token.c, hostSecret: null, teamId: token.t, teamToken: token.k }; saveSession(); }
    history.replaceState(null, '', '/');
  } else if (wantsTeam) history.replaceState(null, '', '/');

  const saved = readSavedSession();
  if (saved) {
    const scannedOtherRoom = saved.mode === 'player' && joinCode && joinCode !== saved.code;
    if (!scannedOtherRoom) {
      current = saved;
      if (current.mode === 'host') {
        if (!authUser) { show('home'); openAuthModal(resumeHost); return; }
        await resumeHost(); return;
      }
      show('player'); render(); await startLive(); return;
    }
  }
  show('home');
  if (joinCode) setTimeout(() => $('teamName').focus(), 50);
})();
