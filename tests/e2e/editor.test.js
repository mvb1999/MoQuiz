// Editor, Handy-Steuerung, Wiederaufnahme nach Neuladen und Sonderfälle.
const { chromium, devices } = require('playwright');
const { startServer, createWorld } = require('./backend');
const { BASE, sleep, runner, expect } = require('./lib');

(async () => {
  const server = await startServer();
  const W = createWorld();
  const browser = await chromium.launch();
  const { step, shot, done } = runner('Editor und Sonderfälle');
  const phone = devices['iPhone 13'];
  const hostCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await W.attachContext(hostCtx, { user: true, name: 'host' });
  const host = await hostCtx.newPage();
  host.on('dialog', d => d.accept());
  await host.goto(BASE + '/'); await sleep(500);

  await step('Multiple-Choice-Quiz erstellen und speichern', async () => {
    await host.click('#homeBuilder'); await sleep(500);
    await host.click('#newQuiz'); await sleep(300);
    await host.fill('#quizTitle', 'Test MC');
    await host.fill('[data-cat-title="0"]', 'Städte');
    await host.fill('[data-q="0:0:prompt"]', 'Hauptstadt der Schweiz?');
    await host.click('[data-format="0:0:mc"]'); await sleep(200);
    await host.fill('[data-opt="0:0:0"]', 'Zürich'); await host.fill('[data-opt="0:0:2"]', 'Bern'); await host.fill('[data-opt="0:0:3"]', 'Genf');
    await host.check('[data-correct="0:0:2"]');
    expect(await host.isVisible('#dirtyNote'), 'Hinweis «Nicht gespeichert» fehlt');
    await host.click('#saveQuiz'); await sleep(700);
    const q = JSON.parse(W.log.filter(l => l[0] === 'save').pop()[1])[0].questions[0];
    expect(q.prompt === 'Hauptstadt der Schweiz?\n\nA) Zürich\nB) Bern\nC) Genf', 'Frage ' + JSON.stringify(q.prompt));
    expect(q.correct_answer === 'B) Bern', 'Lösung ' + q.correct_answer);
  });
  await step('Gespeichertes Multiple Choice wird wieder erkannt', async () => {
    await host.click('.library-item:has-text("Test MC") >> text=Bearbeiten'); await sleep(500);
    await host.click('.question-editor summary'); await sleep(200);
    expect(await host.inputValue('[data-opt="0:0:1"]') === 'Bern', 'Option B falsch');
    expect(await host.isChecked('[data-correct="0:0:1"]'), 'richtige Option nicht B');
    await host.fill('[data-q="0:0:prompt"]', 'Hauptstadt der Schweiz (Bundesstadt)?');
    let warned = false; host.once('dialog', () => { warned = true; });
    await host.click('#editorCancel'); await sleep(300);
    expect(warned, 'keine Warnung bei ungespeicherten Änderungen');
  });
  await step('Prüfung: Multiple Choice braucht zwei Optionen', async () => {
    await host.click('#newQuiz'); await sleep(300);
    await host.fill('#quizTitle', 'Kaputt'); await host.fill('[data-q="0:0:prompt"]', 'Frage');
    await host.click('[data-format="0:0:mc"]'); await sleep(100);
    await host.fill('[data-opt="0:0:0"]', 'Nur eine');
    await host.click('#saveQuiz'); await sleep(300);
    expect((await host.textContent('#builderError')).includes('mindestens zwei'), 'keine Fehlermeldung');
    await host.click('#editorCancel'); await sleep(200);
    await host.click('#builderBack'); await sleep(300);
  });

  let code;
  await step('Steuerung aufs Handy übernehmen', async () => {
    await host.click('#createRoom'); await sleep(700);
    code = (await host.textContent('#hostCode')).trim();
    await host.click('text=Dieses Quiz spielen >> nth=0'); await sleep(800);
    await host.click('#phoneControl'); await sleep(300);
    const link = await host.evaluate(() => controlLink());
    const phoneCtx = await browser.newContext({ ...phone, hasTouch: true });
    await W.attachContext(phoneCtx, { user: true, name: 'phoneHost' });
    const ph = await phoneCtx.newPage(); ph.on('dialog', d => d.accept());
    await ph.goto(link); await sleep(1000);
    expect(await ph.isVisible('#host'), 'Handy nicht in der Steuerung');
    expect(!ph.url().includes('#'), 'Schlüssel bleibt in der Adresse');
    const a = await host.evaluate(() => JSON.stringify(hostDoubles.ids)), b = await ph.evaluate(() => JSON.stringify(hostDoubles.ids));
    expect(a === b, 'Überraschungsfelder unterschiedlich');
    await host.click('#closePhone');
  });
  await step('Spieler kommt nach Neuladen zurück ins Spiel', async () => {
    const pCtx = await browser.newContext({ ...phone, hasTouch: true }); await W.attachContext(pCtx, { name: 'p' });
    const p = await pCtx.newPage();
    await p.goto(BASE + '/' + code); await p.fill('#teamName', 'Reloader'); await p.click('#joinRoom'); await sleep(700);
    await p.reload(); await sleep(900);
    expect(await p.isVisible('#player'), 'nicht wieder im Spiel');
    await p.goto(BASE + '/ZZZZ'); await sleep(600);
    expect(await p.isVisible('#home') && await p.inputValue('#joinCode') === 'ZZZZ', 'anderer Code zeigt kein Beitrittsformular');
    await p.fill('#teamName', 'X'); await p.click('#joinRoom'); await sleep(500);
    expect((await p.textContent('#joinError')).includes('nicht gefunden'), 'keine Fehlermeldung');
  });
  await step('Beamer ohne Schlüssel zeigt Hinweis', async () => {
    const c = await browser.newContext(); await W.attachContext(c, { name: 'lonely' });
    const s = await c.newPage(); await s.goto(BASE + '/?beamer'); await sleep(500);
    expect((await s.textContent('#screenBody')).includes('Host-Steuerung'), 'kein Hinweis');
  });
  await step('Host schliesst den Raum', async () => {
    await host.click('#leaveHost'); await sleep(400);
    expect(await host.isVisible('#home'), 'nicht auf der Startseite');
    await host.reload(); await sleep(600); expect(await host.isVisible('#home'), 'Raum nach Neuladen wieder offen');
  });

  await browser.close(); server.close();
  process.exit(done() ? 1 : 0);
})();
