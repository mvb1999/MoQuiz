// Führt alle Oberflächentests nacheinander aus und meldet Fehler mit Exit-Code 1.
const { spawnSync } = require('child_process');
const fs = require('fs');
const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort();
let failed = 0;
for (const f of files) {
  console.log(`\n=== ${f} ===`);
  let r = spawnSync(process.execPath, [__dirname + '/' + f], { stdio: 'inherit', timeout: 240000 });
  if (r.status !== 0) {
    // Ein zweiter Versuch fängt Zeitprobleme auf langsamen Rechnern ab
    console.log(`--- ${f}: zweiter Versuch ---`);
    r = spawnSync(process.execPath, [__dirname + '/' + f], { stdio: 'inherit', timeout: 240000 });
  }
  if (r.status !== 0) failed++;
}
console.log(failed ? `\n${failed} von ${files.length} Testdateien mit Fehlern.` : `\nAlle ${files.length} Testdateien bestanden.`);
process.exit(failed ? 1 : 0);
