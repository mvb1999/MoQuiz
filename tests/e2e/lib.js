// Gemeinsame Hilfsfunktionen für die Oberflächentests.
const fs = require('fs');
const path = require('path');
const { PORT } = require('./backend');

const BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.MOQUIZ_SHOTS ? path.resolve(process.env.MOQUIZ_SHOTS) : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

function runner(name) {
  let fails = 0, passed = 0;
  return {
    async step(label, fn) {
      try { await fn(); passed++; console.log('OK  ', label); }
      catch (e) { fails++; console.log('FAIL', label, '->', String(e.message || e).split('\n')[0]); }
    },
    async shot(page, file, full = false) { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, file + '.png'), fullPage: full }).catch(() => {}); },
    done() { console.log(`${name}: ${passed} bestanden, ${fails} fehlgeschlagen`); return fails; },
  };
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

module.exports = { BASE, sleep, runner, expect };
