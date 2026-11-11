// MOQUIZ: Konto mit Benutzername erstellen.
// Supabase Auth braucht eine E-Mail-Adresse. Aus dem Benutzernamen wird eine feste, interne
// Adresse abgeleitet (gleicher Algorithmus wie usernameToEmail in app.js). Das Konto wird sofort
// freigeschaltet, es werden keine E-Mails verschickt. Die Anmeldung läuft danach direkt über
// supabase.auth.signInWithPassword im Browser.
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const normUsername = (u: string) => String(u ?? "").normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
async function usernameToEmail(username: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("moquiz:" + normUsername(username)));
  return "u" + [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40) + "@users.moquiz.ch";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Nur POST erlaubt." }, 405);
  let body: { username?: string; password?: string };
  try { body = await req.json(); } catch { return json({ error: "Ungültige Anfrage." }, 400); }

  const username = String(body.username ?? "").normalize("NFC").trim().replace(/\s+/g, " ");
  const password = String(body.password ?? "");
  if (username.length < 3 || username.length > 24) return json({ error: "Der Benutzername muss 3 bis 24 Zeichen lang sein." }, 400);
  if (!/^[\p{L}\p{N}._ -]+$/u.test(username)) return json({ error: "Erlaubt sind Buchstaben, Zahlen, Leerzeichen, Punkt, Unterstrich und Bindestrich." }, 400);
  if (password.length < 6 || password.length > 72) return json({ error: "Das Passwort muss 6 bis 72 Zeichen lang sein." }, 400);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await admin.auth.admin.createUser({
    email: await usernameToEmail(username),
    password,
    email_confirm: true,
    user_metadata: { username },
  });
  if (error) {
    const msg = /already|exists|registered/i.test(error.message) ? "Dieser Benutzername ist schon vergeben." : error.message;
    return json({ error: msg }, 400);
  }
  return json({ ok: true });
});
