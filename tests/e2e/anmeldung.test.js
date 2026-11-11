// Konto erstellen und anmelden mit Benutzername (Edge Function und Ersatzweg).
const { chromium } = require('playwright');
const { startServer, createWorld } = require('./backend');
const { BASE, sleep, runner, expect } = require('./lib');

(async () => {
  const server = await startServer(); const W = createWorld(); const browser = await chromium.launch();
  const { step, done } = runner('Anmeldung');
  for (const status of [200, 404]) {
    await step(`Konto erstellen (Edge Function antwortet ${status})`, async () => {
      const ctx = await browser.newContext(); await W.attachContext(ctx, { name: 'auth' });
      const calls = [];
      await ctx.route('**/functions/v1/**', r => { calls.push(r.request().postDataJSON()); r.fulfill({ status, contentType: 'application/json', body: status === 200 ? '{"ok":true}' : '{}' }); });
      const p = await ctx.newPage(); await p.goto(BASE + '/'); await p.waitForLoadState('networkidle'); await sleep(300);
      await p.click('#accountButton'); await p.fill('#authUsername', 'Neuer User'); await p.fill('#authPassword', 'geheim123');
      await p.click('#authSignup');
      await p.waitForFunction(() => (window.__authCalls || []).length > 0, null, { timeout: 8000 }).catch(() => {}); await sleep(300);
      const ac = await p.evaluate(() => window.__authCalls || []);
      expect(calls.length === 1 && calls[0].username === 'Neuer User', 'Edge Function nicht aufgerufen');
      expect(ac.some(c => c[0] === (status === 200 ? 'signIn' : 'signUp')), 'falscher Anmeldeweg: ' + JSON.stringify(ac));
      expect((await p.textContent('#accountButton')).trim() !== 'Anmelden', 'nicht angemeldet');
      const email = ac[ac.length - 1][1];
      await p.evaluate(() => { window.__mockUser = null; }); await p.reload(); await sleep(300);
      await p.click('#accountButton'); await p.fill('#authUsername', '  neuer   USER '); await p.fill('#authPassword', 'falsch'); await p.click('#authLogin');
      await p.waitForFunction(n => (window.__authCalls || []).length > n, 0, { timeout: 8000 }).catch(() => {}); await sleep(300);
      const ac2 = await p.evaluate(() => window.__authCalls || []);
      expect(ac2[ac2.length - 1][1] === email, 'Benutzername wird nicht einheitlich umgewandelt');
      expect((await p.textContent('#authError')).length > 0, 'keine Fehlermeldung bei falschem Passwort');
      await ctx.close();
    });
  }
  await browser.close(); server.close();
  process.exit(done() ? 1 : 0);
})();
