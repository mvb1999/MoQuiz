// Hält die Supabase-Datenbank wach. Supabase pausiert Gratis-Projekte nach einer
// Woche ohne Zugriffe; Vercel ruft diese Funktion deshalb täglich auf (siehe vercel.json).
// Die Werte sind dieselben öffentlichen Schlüssel wie in app.js.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ottfpxtkgjkesidwfoxn.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_QL_3phtu_z8r8NMaIhBtig_yvxyOV6V';

module.exports = async (req, res) => {
  const started = Date.now();
  let status = 0, ok = false, error = null;
  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/rooms?select=id&limit=1', {
      headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY },
      signal: AbortSignal.timeout(15000),
    });
    status = r.status; ok = r.ok;
    if (!ok) error = (await r.text()).slice(0, 200);
  } catch (e) { error = String(e && e.message || e); }
  res.statusCode = ok ? 200 : 502;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ ok, datenbank: ok ? 'wach' : 'nicht erreichbar', status, ms: Date.now() - started, error }));
};
