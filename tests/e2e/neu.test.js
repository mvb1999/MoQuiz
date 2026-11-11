// Neue Funktionen: Einsatz-Joker, 50:50, Hörfragen, weiteres Handy, Rückblick,
// Tastenkürzel, Export und Import, Fragen aus Tabelle, Kurzlink.
const fs = require('fs');
const { chromium, devices } = require('playwright');
const { startServer, createWorld } = require('./backend');
const { BASE, sleep, runner, expect } = require('./lib');

(async () => {
  const server = await startServer();
  const W = createWorld();
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const { step, shot, done } = runner('Neue Funktionen');
  const team = part => Object.values(W.teams).find(t => t.name.includes(part));
  const phone = devices['iPhone 13'];

  const hostCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await W.attachContext(hostCtx, { user: true, name: 'host' });
  const host = await hostCtx.newPage(); host.on('dialog', d => d.accept());
  const p1Ctx = await browser.newContext({ ...phone, hasTouch: true }); await W.attachContext(p1Ctx, { name: 'p1' });
  const p2Ctx = await browser.newContext({ ...phone, hasTouch: true }); await W.attachContext(p2Ctx, { name: 'p2' });
  const p1 = await p1Ctx.newPage(), p2 = await p2Ctx.newPage();
  p1.on('dialog', d => d.accept()); p2.on('dialog', d => d.accept());

  let code, screen;
  await step('Raum, Beamer und zwei Teams', async () => {
    await host.goto(BASE + '/'); await sleep(400);
    await host.click('#createRoom'); await sleep(700);
    code = (await host.textContent('#hostCode')).trim();
    const [popup] = await Promise.all([hostCtx.waitForEvent('page'), host.click('#openScreen')]);
    screen = popup; await screen.setViewportSize({ width: 1920, height: 1080 }); await sleep(600);
    for (const [p, name] of [[p1, 'Die Quizzards'], [p2, 'Team Fondue']]) {
      await p.goto(BASE + '/' + code); await p.fill('#teamName', name); await p.click('#joinRoom'); await sleep(600);
    }
    await host.click('text=Dieses Quiz spielen'); await sleep(900);
    await host.selectOption('.board-legend select', '0'); await sleep(300);
    expect(Object.values(W.teams).length === 2, 'Teams fehlen');
  });
  await step('Kurzlink ohne www und mit Code', async () => {
    expect(await host.evaluate(c => joinUrl(c), code) === BASE + '/' + code, 'falscher Link');
  });
  await step('Joker braucht zuerst Punkte', async () => {
    expect((await p2.textContent('#playerBody')).includes('sobald ihr Punkte habt'), 'Hinweis fehlt');
  });
  await step('Erste Frage bringt Team 1 auf 100 Punkte', async () => {
    await host.click('button.qcell[aria-label="Geografie 100 Punkte"]'); await sleep(900);
    await p1.fill('#playerAnswer', 'biel'); await p1.click('#submitAnswer');
    await p2.fill('#playerAnswer', 'Bern'); await p2.click('#submitAnswer'); await sleep(700);
    await host.click('text=Antworten jetzt aufdecken'); await sleep(600);
    await host.click('text=/Vorschläge übernehmen/'); await sleep(800);
    await host.click('text=Zurück zum Board'); await sleep(800);
    expect(team('Quizzards').score === 100, 'Punkte ' + team('Quizzards').score);
  });
  await step('Team 1 setzt den Joker, bevor es die Frage sieht', async () => {
    await p1.click('#jokerOpen'); await sleep(200); await shot(p1, 'n01-joker-open', true);
    await p1.click('#playerBody [data-jw="50"]'); await p1.click('#jokerArm'); await sleep(800);
    expect(team('Quizzards').joker_state === 'armed' && team('Quizzards').joker_amount === 50, 'Joker nicht gesetzt');
    expect((await host.textContent('#hostTeams')).includes('Joker gesetzt: 50'), 'Host sieht Joker nicht');
    expect(await screen.isVisible('.scr-jokers'), 'Beamer zeigt Joker nicht');
    await shot(p1, 'n02-joker-armed', true); await shot(screen, 'n02-screen-joker');
  });
  await step('Einsatz ändern, Joker gilt bei der nächsten Frage', async () => {
    await p1.click('#jokerEdit'); await sleep(200);
    await p1.click('#playerBody [data-jw="100"]'); await p1.click('#jokerArm'); await sleep(800);
    expect(team('Quizzards').joker_amount === 100, 'Einsatz nicht geändert');
    await host.click('button.qcell[aria-label="Geografie 200 Punkte"]'); await sleep(1000);
    const t = team('Quizzards');
    expect(t.joker_state === 'used' && t.joker_question_id === 'c0q2', 'Joker nicht eingesetzt');
    expect((await p1.textContent('.player-badges')).includes('Joker: 100 Punkte'), 'Spieler sieht Joker-Einsatz nicht');
  });
  await step('50:50 blendet zwei falsche Antworten aus', async () => {
    await p1.click('#fiftyBtn'); await sleep(900);
    const gone = await p1.$$eval('#playerBody .mc-opt.is-gone', els => els.map(e => e.dataset.mc));
    expect(gone.length === 2 && !gone.includes('B'), 'ausgeblendet: ' + gone);
    expect(team('Quizzards').fifty_used, '50:50 nicht gespeichert');
    await shot(p1, 'n03-fifty', true);
    await p1.click('#playerBody [data-mc="B"]'); await p2.click('#playerBody [data-mc="A"]'); await sleep(800);
    await host.click('text=Antworten jetzt aufdecken'); await sleep(600);
    expect((await host.textContent('#hostQuestion')).includes('Joker 100'), 'Host sieht Joker bei der Antwort nicht');
    await host.click('text=Automatisch bewerten'); await sleep(900);
    expect(team('Quizzards').score === 200, 'Joker-Gewinn falsch: ' + team('Quizzards').score);
    expect(team('Fondue').score === 0, 'Team 2: ' + team('Fondue').score);
    await host.click('text=Zurück zum Board'); await sleep(800);
    expect((await p1.textContent('#playerBody')).includes('Joker eingesetzt'), 'Joker nicht als eingesetzt markiert');
  });
  await step('Joker kostet bei falscher Antwort den Einsatz', async () => {
    await host.click('.teamrow:has-text("Fondue") >> text=+100'); await sleep(700);
    await p2.click('#jokerOpen'); await p2.click('#playerBody [data-jw="100"]'); await p2.click('#jokerArm'); await sleep(700);
    await host.click('button.qcell[aria-label="Geografie 400 Punkte"]'); await sleep(900);
    await p1.fill('#playerAnswer', 'Biel'); await p1.click('#submitAnswer');
    await p2.fill('#playerAnswer', 'Zürich'); await p2.click('#submitAnswer'); await sleep(700);
    await host.click('text=Antworten jetzt aufdecken'); await sleep(600);
    await host.click('.submission:has-text("Fondue") >> text=/Falsch/'); await sleep(700);
    expect(team('Fondue').score === 0, 'Einsatz nicht abgezogen: ' + team('Fondue').score);
    await host.click('text=/Vorschläge übernehmen/'); await sleep(700);
    expect(team('Quizzards').score === 600, 'normale Punkte falsch: ' + team('Quizzards').score);
    await host.click('text=Zurück zum Board'); await sleep(700);
  });
  await step('Hörfrage läuft auf dem Beamer und lässt sich steuern', async () => {
    expect((await host.textContent('button.qcell[aria-label="Musik 200 Punkte"]')).includes('Audio'), 'Board zeigt Audio nicht');
    await host.click('button.qcell[aria-label="Musik 200 Punkte"]'); await sleep(1800);
    expect(await screen.evaluate(() => audioPlaying()), 'Audio läuft nicht auf dem Beamer');
    expect((await p1.textContent('.player-badges')).includes('Hörfrage'), 'Spieler sieht Hörfrage nicht');
    expect((await host.textContent('.audio-bar')).includes('Pause'), 'Host sieht Wiedergabe nicht');
    await shot(host, 'n04-host-audio', true);
    await host.click('.audio-bar >> text=Pause'); await sleep(600);
    expect(!(await screen.evaluate(() => audioPlaying())), 'Pause wirkt nicht');
    await host.click('.audio-bar >> text=Von vorne'); await sleep(600);
    expect(await screen.evaluate(() => audioPlaying()), 'Von vorne wirkt nicht');
    await host.keyboard.press('b'); await sleep(800);
    expect(await host.isVisible('#hostBoard'), 'Taste B führt nicht zum Board');
    expect(!(await screen.evaluate(() => audioPlaying())), 'Audio läuft nach der Frage weiter');
  });
  await step('Tastenkürzel in der Host-Steuerung', async () => {
    await host.click('button.qcell[aria-label="Geografie 500 Punkte"]'); await sleep(900);
    await host.keyboard.press('l'); await sleep(600);
    expect(await screen.isVisible('.scr-solution'), 'Taste L zeigt Lösung nicht');
    await host.keyboard.press(' '); await sleep(500);
    expect(W.rooms[Object.keys(W.rooms)[0]].question_paused, 'Leertaste pausiert nicht');
    await host.keyboard.press('?'); await sleep(200);
    expect(await host.isVisible('#keysModal'), 'Übersicht öffnet nicht');
    await host.keyboard.press('Escape'); await host.keyboard.press('b'); await sleep(700);
    expect(await host.isVisible('#hostBoard'), 'nicht zurück zum Board');
  });
  await step('Weiteres Handy spielt im gleichen Team', async () => {
    await p1.click('#addPhone'); await sleep(200);
    expect(await p1.isVisible('#teamPhoneQr svg'), 'kein QR-Code');
    const link = await p1.evaluate(() => teamLink());
    const c = await browser.newContext({ ...phone, hasTouch: true }); await W.attachContext(c, { name: 'p1b' });
    const p1b = await c.newPage(); await p1b.goto(link); await sleep(900);
    expect(await p1b.isVisible('#player'), 'zweites Handy nicht im Spiel');
    expect((await p1b.textContent('#playerTeam')).includes('Quizzards'), 'falsches Team');
    expect(!p1b.url().includes('#'), 'Schlüssel bleibt in der Adresse');
    expect(Object.values(W.teams).length === 2, 'neues Team angelegt');
    await p1.click('#closeTeamPhone');
  });
  await step('Rückblick nach der Siegerehrung', async () => {
    await host.click('text=Spiel beenden'); await sleep(900);
    await host.click('text=Rückblick zeigen'); await sleep(900);
    expect(await screen.isVisible('.recap-chart'), 'kein Punkteverlauf auf dem Beamer');
    expect((await host.textContent('#hostPodium')).includes('Meiste richtige Antworten'), 'keine Auszeichnungen');
    expect((await host.textContent('#hostPodium')).includes('Mutigster Joker'), 'Joker-Auszeichnung fehlt');
    expect(await p1.isVisible('.player-recap'), 'Spieler sieht Rückblick nicht');
    await shot(screen, 'n05-screen-recap'); await shot(p1, 'n05-player-recap', true);
    await host.click('text=Zurück zur Siegerehrung'); await sleep(500);
    expect(await screen.isVisible('.podium'), 'nicht zurück zur Siegerehrung');
  });
  let exported;
  await step('Quiz als Datei exportieren', async () => {
    await host.click('#hostBuilderShortcut'); await sleep(700);
    const [dl] = await Promise.all([host.waitForEvent('download'), host.click('.library-item:has-text("Freitagabend") >> text=Exportieren')]);
    exported = await dl.path(); const doc = JSON.parse(fs.readFileSync(exported, 'utf8'));
    expect(doc.format === 'moquiz' && doc.quizzes.length === 1, 'falsches Format');
    expect(doc.quizzes[0].categories[1].questions[1].audio_url.includes('ton.wav'), 'Audio fehlt im Export');
    expect(dl.suggestedFilename() === 'moquiz-freitagabend-quiz.json', 'Dateiname ' + dl.suggestedFilename());
  });
  await step('Datei wieder importieren', async () => {
    await host.setInputFiles('#importFile', exported); await sleep(900);
    const imp = Object.values(W.quizSets).find(q => q.title === 'Freitagabend Quiz (Import)');
    expect(imp && imp.categories.length === 5 && imp.categories[0].questions.length === 5, 'Import unvollständig');
    expect((await host.textContent('#quizLibrary')).includes('(Import)'), 'Bibliothek zeigt Import nicht');
  });
  await step('Fragen aus einer Tabelle einfügen', async () => {
    await host.click('#newQuiz'); await sleep(300);
    await host.fill('#quizTitle', 'Aus Excel');
    await host.click('#openTableImport'); await sleep(200);
    const tsv = ['Kategorie\tFrage\tAntwort\tPunkte\tTyp\tZeit\tOptionen',
      'Geografie\tHauptstadt der Schweiz?\tBern\t100\tAlle\t30\t',
      'Geografie\tFluss durch Basel?\tRhein\t200\tAlle\t20\tAare | Rhein | Rhone',
      'Musik\tWer sang Hallelujah?\tLeonard Cohen\t\tBuzzer\t15\t'].join('\n');
    await host.fill('#tableInput', tsv); await sleep(200);
    const prev = await host.textContent('#tablePreview');
    expect(prev.includes('2 Kategorien mit 3 Fragen') && prev.includes('1 Multiple Choice'), 'Vorschau: ' + prev);
    await shot(host, 'n06-table-import');
    await host.click('#tableApply'); await sleep(300);
    await host.click('#saveQuiz'); await sleep(800);
    const board = JSON.parse(W.log.filter(l => l[0] === 'save').pop()[1]);
    expect(board.length === 2 && board[0].questions.length === 2, 'Kategorien ' + board.length);
    expect(board[0].questions[1].prompt.endsWith('C) Rhone') && board[0].questions[1].correct_answer === 'B) Rhein', 'Multiple Choice falsch');
    expect(board[1].questions[0].question_type === 'buzzer' && board[1].questions[0].points === 100 && board[1].questions[0].duration_seconds === 15, 'Buzzer-Frage falsch');
  });
  await step('CSV mit Semikolon und Anführungszeichen', async () => {
    const r = await host.evaluate(() => { const x = tableToCategories('Kategorie;Frage;Antwort\n"Geo";"Frage mit ""Zitat""; und Semikolon";Bern'); return { n: x.count, p: x.cats[0]?.questions[0]?.prompt }; });
    expect(r.n === 1 && r.p === 'Frage mit "Zitat"; und Semikolon', JSON.stringify(r));
    const r2 = await host.evaluate(() => tableToCategories('Geo\tWelche Farbe?\tC\t\t\t\tRot\tGrün\tBlau').cats[0].questions[0]);
    expect(r2.format === 'mc' && r2.correctLetter === 'C' && r2.options[2] === 'Blau', 'Optionen in eigenen Spalten: ' + JSON.stringify(r2.options));
  });
  await step('Vorlage für Excel herunterladen', async () => {
    await host.click('#newQuiz'); await sleep(300);
    await host.click('#openTableImport'); await sleep(200);
    const [dl] = await Promise.all([host.waitForEvent('download'), host.click('#tableTemplate')]);
    const txt = fs.readFileSync(await dl.path(), 'utf8');
    expect(txt.startsWith('﻿Kategorie;Frage;Antwort'), 'Vorlage beginnt falsch');
    await host.keyboard.press('Escape');
  });

  await browser.close(); server.close();
  process.exit(done() ? 1 : 0);
})();
