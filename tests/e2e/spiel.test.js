// Ganzes Spiel: Host (Laptop), Beamer-Fenster und zwei Teams (Handys).
const { chromium, devices } = require('playwright');
const { startServer, createWorld } = require('./backend');
const { BASE, sleep, runner, expect } = require('./lib');

(async () => {
  const server = await startServer();
  const W = createWorld();
  const browser = await chromium.launch();
  const { step, shot, done } = runner('Spielablauf');
  const team = part => Object.values(W.teams).find(t => t.name.includes(part));

  const hostCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await W.attachContext(hostCtx, { user: true, name: 'host' });
  const host = await hostCtx.newPage();
  host.on('dialog', d => d.accept());
  const phone = devices['iPhone 13'];
  const p1Ctx = await browser.newContext({ ...phone, hasTouch: true }); await W.attachContext(p1Ctx, { name: 'p1' });
  const p2Ctx = await browser.newContext({ ...phone, hasTouch: true }); await W.attachContext(p2Ctx, { name: 'p2' });
  const p1 = await p1Ctx.newPage(), p2 = await p2Ctx.newPage();

  await step('Startseite lädt auf Laptop und Handy', async () => {
    await host.goto(BASE + '/'); await p1.goto(BASE + '/'); await sleep(400);
    expect(await host.isVisible('#joinForm'), 'Formular fehlt'); await shot(host, '01-home-desktop', true); await shot(p1, '01-home-mobile', true);
  });
  let code, screen;
  await step('Host erstellt einen Raum', async () => {
    await host.click('#createRoom'); await sleep(700);
    code = (await host.textContent('#hostCode')).trim(); expect(code.length === 4, 'kein Code: ' + code);
  });
  await step('Beamer-Fenster öffnet sich', async () => {
    const [popup] = await Promise.all([hostCtx.waitForEvent('page'), host.click('#openScreen')]);
    screen = popup; await screen.setViewportSize({ width: 1920, height: 1080 }); await sleep(900);
    expect((await screen.textContent('#screenBody')).includes(code), 'Code nicht auf dem Beamer'); await shot(screen, '03-screen-lobby');
  });
  await step('Team 1 tritt über den Kurzlink bei', async () => {
    await p1.goto(BASE + '/' + code); await sleep(500);
    expect(await p1.inputValue('#joinCode') === code, 'Code nicht vorausgefüllt');
    await p1.fill('#teamName', 'Die Quizzards'); await p1.click('#emojiPicker button:nth-child(1)');
    await p1.click('#joinRoom'); await sleep(700); expect(await p1.isVisible('#player'), 'nicht im Spiel');
  });
  await step('Team 2 tritt mit dem Code bei (Enter)', async () => {
    await p2.goto(BASE + '/'); await p2.fill('#joinCode', code.toLowerCase()); await p2.fill('#teamName', 'Team Fondue');
    await p2.click('#emojiPicker button:nth-child(5)'); await p2.press('#teamName', 'Enter'); await sleep(700);
    expect(Object.values(W.teams).length === 2, 'Teams: ' + Object.values(W.teams).length);
  });
  await step('Host wählt das Quiz', async () => {
    await host.click('text=Dieses Quiz spielen'); await sleep(900);
    await host.selectOption('.board-legend select', '0'); await sleep(300);
    expect(await host.isVisible('.board'), 'kein Board'); await shot(host, '07-host-board', true); await shot(screen, '07-screen-board');
  });
  await step('Freitext-Frage mit Vorschlägen', async () => {
    await host.click('button.qcell[aria-label="Geografie 100 Punkte"]'); await sleep(900);
    await p1.fill('#playerAnswer', 'biel'); await p1.click('#submitAnswer');
    await p2.fill('#playerAnswer', 'Bern'); await p2.click('#submitAnswer'); await sleep(800);
    await host.click('text=Antworten jetzt aufdecken'); await sleep(700);
    await host.click('text=/Vorschläge übernehmen/'); await sleep(900);
    expect(team('Quizzards').score === 100, 'Punkte ' + team('Quizzards').score);
    await host.click('text=Lösung allen zeigen'); await sleep(500);
    expect((await screen.textContent('#screenBody')).includes('Biel'), 'Lösung nicht auf dem Beamer');
    await host.click('text=Zurück zum Board'); await sleep(700);
  });
  await step('Multiple Choice wird automatisch bewertet', async () => {
    await host.click('button.qcell[aria-label="Geografie 200 Punkte"]'); await sleep(900);
    await p1.click('#playerBody [data-mc="B"]'); await p2.click('#playerBody [data-mc="A"]'); await sleep(900);
    await host.click('text=Antworten jetzt aufdecken'); await sleep(600);
    await host.click('text=Automatisch bewerten'); await sleep(900);
    expect(team('Quizzards').score === 300, 'Punkte ' + team('Quizzards').score);
    await host.click('text=Zurück zum Board'); await sleep(700);
  });
  await step('Schätzfrage schlägt die nächste Antwort vor', async () => {
    await host.click('button.qcell[aria-label="Geografie 300 Punkte"]'); await sleep(900);
    await p1.fill('#playerAnswer', "4'500 m"); await p1.click('#submitAnswer');
    await p2.fill('#playerAnswer', '3800'); await p2.click('#submitAnswer'); await sleep(800);
    await host.click('text=Antworten jetzt aufdecken'); await sleep(700);
    expect((await host.textContent('#hostQuestion')).includes('Am nächsten'), 'kein Vorschlag «Am nächsten»');
    await host.click('text=/Vorschläge übernehmen/'); await sleep(800);
    await host.click('text=Zurück zum Board'); await sleep(700);
  });
  await step('Buzzer-Frage', async () => {
    await host.click('button.qcell[aria-label="Musik 100 Punkte"]'); await sleep(900);
    await p2.click('#buzzButton'); await sleep(900);
    expect((await p1.textContent('#playerBody')).includes('war zuerst'), 'Team 1 sieht Gewinner nicht');
    await p2.fill('#playerAnswer', 'Leonard Cohen'); await p2.click('#submitAnswer'); await sleep(800);
    await host.click('text=/Vorschläge übernehmen/'); await sleep(800);
    expect(team('Fondue').score === 100, 'Punkte ' + team('Fondue').score);
    await host.click('text=Zurück zum Board'); await sleep(700);
  });
  await step('Frage an ein Team', async () => {
    await host.click('button.qcell[aria-label="Film & Serien 100 Punkte"]'); await sleep(400);
    await host.click('#teamPicker button:first-child'); await sleep(900);
    expect((await p2.textContent('#playerBody')).includes('geht an'), 'anderes Team sieht Hinweis nicht');
    await host.click('text=Zurück zum Board'); await sleep(600);
  });
  await step('Überraschungsfeld mit doppelten Punkten', async () => {
    await host.selectOption('.board-legend select', '1'); await sleep(300);
    const label = await host.$eval('.qcell .dbl', el => el.closest('button').getAttribute('aria-label'));
    await host.click(`button.qcell[aria-label="${label}"]`); await sleep(1400);
    expect((await p1.textContent('#playerBody')).includes('Doppelte Punkte'), 'Spieler sieht doppelte Punkte nicht');
    await host.click('text=Zurück zum Board'); await sleep(600);
  });
  await step('Rangliste auf Beamer und Handy', async () => {
    await host.click('text=Rangliste zeigen'); await sleep(600);
    expect(await screen.isVisible('.scr-rank'), 'keine Rangliste auf dem Beamer');
    await host.click('text=Rangliste ausblenden'); await sleep(300);
  });
  await step('Verbindungsabbruch zeigt Hinweis und verbindet neu', async () => {
    await p1.evaluate(() => window.__mockKill()); await sleep(300);
    expect(await p1.isVisible('#liveBanner'), 'kein Hinweis');
    await sleep(3200); expect(!(await p1.isVisible('#liveBanner')), 'Hinweis bleibt');
  });
  await step('Finalrunde mit Einsätzen und Siegerehrung', async () => {
    await host.click('button:has-text("Finalrunde")'); await sleep(400);
    await host.click('#finalPicker button:has-text("Schweiz")'); await sleep(900);
    await p1.click('#playerBody [data-w]:last-child'); await p1.click('#wagerSubmit'); await sleep(600);
    await p2.click('#playerBody [data-w="0"]'); await p2.click('#wagerSubmit'); await sleep(600);
    const before = team('Quizzards').score;
    await host.click('text=Frage starten'); await sleep(900);
    await p1.fill('#playerAnswer', '1291'); await p1.click('#submitAnswer');
    await p2.fill('#playerAnswer', '1515'); await p2.click('#submitAnswer'); await sleep(800);
    await host.click('text=Antworten jetzt aufdecken'); await sleep(700);
    await host.click('text=/Vorschläge übernehmen/'); await sleep(800);
    expect(team('Quizzards').score === before * 2, `Einsatz falsch verrechnet: ${before} -> ${team('Quizzards').score}`);
    await host.click('text=Zur Siegerehrung'); await sleep(1200);
    expect(await screen.isVisible('.podium'), 'kein Podest'); await shot(screen, '26-screen-podium');
  });

  await browser.close(); server.close();
  process.exit(done() ? 1 : 0);
})();
