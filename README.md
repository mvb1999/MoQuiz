# MOQUIZ

Live-Quiz für Teams im Jeopardy-Stil. Der Host zeigt das Board auf dem Beamer, die Teams spielen auf dem Handy.
Backend: Supabase. Hosting: Vercel (statische Dateien, keine Build-Schritte).

Workflow: Änderungen werden auf `main` committet. Ist Vercel mit diesem Repository verbunden, geht jede Änderung auf `main` automatisch live, andere Branches erhalten eine Vorschau-URL.

## Dateien

| Datei | Inhalt |
| --- | --- |
| `index.html` | Markup aller Ansichten (Startseite, Editor, Host, Spieler, Beamer, Dialoge) |
| `app.css` | Gestaltung |
| `app.js` | Logik, Supabase-Anbindung, Realtime |
| `vercel.json` | Kurzlinks (`/ABCD` öffnet die Startseite mit vorausgefülltem Raumcode) und täglicher Weckruf für die Datenbank |
| `api/keepalive.js` | Vercel-Funktion, die einmal täglich die Datenbank abfragt, damit Supabase sie nicht pausiert |
| `tests/` | Automatische Tests (Oberfläche und Datenbank), siehe unten |
| `.github/workflows/tests.yml` | Führt die Tests bei jedem Push auf GitHub aus |
| `vendor/qrcode.js` | QR-Code-Generator (qrcode-generator 1.4.4, MIT) |
| `fonts/` | Alte Haas Grotesk (Hausschrift) und Inter Tight als Ersatzschrift (OFL) |

## Ablauf

1. **Host:** «Raum erstellen» (Konto nötig), Quiz wählen. Die Teams treten über `moquiz.ch/CODE` bei (ohne www). «Beamer-Ansicht öffnen» öffnet ein zweites Fenster ohne Lösungen und Steuerknöpfe (`/?beamer`). Mit «Steuerung aufs Handy» übernimmt das Handy die Steuerung (`/?steuerung`), der Laptop zeigt dann nur noch die Beamer-Ansicht.
2. **Teams:** QR-Code scannen oder Adresse öffnen, Raumcode und Teamname eingeben, Emoji wählen. Über «Weiteres Handy verbinden» spielen mehrere Handys im gleichen Team mit.
3. **Spiel:** Fragen auf dem Board anklicken. Antworten werden automatisch mit der Lösung verglichen und als Vorschlag markiert, der Host bestätigt mit einem Klick.

## Spielelemente

- **Fragetypen** (in der Datenbank): Alle antworten, Ein Team, Buzzer.
- **Multiple Choice:** wird als lesbarer Text in der Frage gespeichert, ohne eigene Datenbankspalte:
  ```
  Welcher Fluss fliesst durch Basel?

  A) Aare
  B) Rhein
  ```
  Die Lösung wird als `B) Rhein` gespeichert. Der Editor erstellt dieses Format automatisch.
- **Mehrere richtige Antworten:** in der Lösung mit `/` trennen, z.B. `Biel / Bienne`.
- **Schätzfragen:** Ist die Lösung eine Zahl, schlägt MOQUIZ die Antwort vor, die am nächsten liegt.
- **Überraschungsfelder:** Pro Spiel werden zufällig Felder mit doppelten Punkten verteilt (Anzahl unter dem Board einstellbar). Nur der Host sieht die Markierung.
- **Finalrunde:** Die Teams sehen zuerst nur die Kategorie und setzen einen Teil ihrer Punkte. Der Einsatz wird vor die Antwort geschrieben (`Einsatz 300 | Antwort`).
- **Einsatz-Joker** (einmal pro Spiel und Team): Zwischen zwei Fragen setzt ein Team einen Teil seiner Punkte auf die nächste Frage, ohne sie zu kennen. Richtig: Einsatz gewonnen, falsch: Einsatz verloren. Der Einsatz ersetzt die normalen Punkte der Frage (auch bei doppelten Punkten). Bei Buzzer-Fragen gilt er nur, wenn das Team zuerst buzzert, bei «Ein Team» nur für das ausgewählte Team. Sonst bleibt er für eine spätere Frage gesetzt. In der Finalrunde wird kein Joker verbraucht. Zurücknehmen geht nur zwischen den Fragen.
- **50:50-Joker** (einmal pro Spiel und Team): blendet bei Multiple Choice (ab drei Optionen) falsche Antworten aus, bis zwei übrig bleiben. Die Datenbank wählt die Optionen aus, die Lösung erfährt das Handy dabei nicht.
- **Hörfragen:** Im Editor lässt sich pro Frage eine Audiodatei hochladen (MP3, M4A, WAV, OGG, max. 15 MB). Sie läuft auf dem Beamer (ohne offenen Beamer in der Host-Steuerung) und startet automatisch. Der Host steuert sie mit «Abspielen», «Pause» und «Von vorne». Ein Buzzer stoppt die Musik. Die Handys erfahren nur, dass es eine Hörfrage ist.
- **Siegerehrung:** Podest mit Konfetti auf Beamer und Handys. Danach zeigt «Rückblick zeigen» den Punkteverlauf und Auszeichnungen (meiste richtige Antworten, schnellster Buzzer, grösster Sprung, mutigster Joker).

## Quiz verwalten

- **Exportieren und importieren:** In «Meine Quiz» lässt sich jedes Quiz als `.json`-Datei sichern («Exportieren», «Alle Quiz als Datei sichern») und über «Datei importieren» wieder einlesen, auch in einem anderen Konto.
- **Aus Tabelle einfügen:** Im Editor Zeilen aus Excel, Numbers oder Google Sheets kopieren und einfügen. Spalten: Kategorie, Frage, Antwort, Punkte, Typ, Zeit, Optionen (mit oder ohne Überschrift; Pflicht sind Kategorie und Frage). Multiple-Choice-Optionen mit `|` trennen oder in eigene Spalten schreiben, als Antwort den Buchstaben oder den Text angeben. «Vorlage herunterladen» liefert eine CSV-Datei für Excel.

## Tastenkürzel (Host-Steuerung)

| Taste | Aktion |
| --- | --- |
| Leertaste | Timer pausieren oder fortsetzen |
| L | Lösung allen zeigen oder verbergen |
| A | Antworten jetzt aufdecken |
| V | Vorschläge übernehmen oder automatisch bewerten |
| + | 10 Sekunden mehr |
| P | Audio abspielen oder pausieren |
| B | Zurück zum Board |
| R | Rangliste zeigen oder ausblenden |
| ? | Übersicht der Tastenkürzel |
| F | Vollbild (in der Beamer-Ansicht) |

## Datenbank (Supabase)

- Projekt: `ottfpxtkgjkesidwfoxn` (Frankfurt). URL und öffentlicher Schlüssel stehen oben in `app.js`.
- Die komplette Struktur liegt in `supabase/migrations/`. Damit lässt sich die Datenbank jederzeit neu aufsetzen: neues Projekt erstellen, die SQL-Datei im SQL Editor ausführen, Edge Function `supabase/functions/signup-username` deployen (JWT-Prüfung aus), URL und Schlüssel in `app.js` eintragen.
- `public.rooms` und `public.teams` sind für alle lesbar (Live-Updates). Quiz, Lösungen, Antworten und Geheimnisse liegen im Schema `private` und sind nur über die Funktionen erreichbar.
- Konten: Benutzername und Passwort. Supabase Auth braucht eine E-Mail-Adresse, darum wird aus dem Benutzernamen eine interne Adresse `u<hash>@users.moquiz.ch` abgeleitet. Es werden keine E-Mails verschickt.
- Gratis-Plan: Supabase pausiert Projekte nach rund einer Woche ohne Nutzung. Dagegen ruft Vercel jeden Morgen `/api/keepalive` auf (Cron in `vercel.json`). Ob es funktioniert, zeigt `https://moquiz.ch/api/keepalive` (Antwort `"datenbank":"wach"`). Falls das Projekt trotzdem pausiert ist: im Dashboard «Restore project» wählen.

## Geteilter Zustand ohne Datenbank

Lösung zeigen, Rangliste, Überraschungsfelder, Finalrunde und Siegerehrung verteilt der Host über einen Supabase-Broadcast-Kanal (`moquiz-ui-<roomId>`). Dafür sind keine Tabellen oder Funktionen nötig. Alle Daten zu Räumen, Teams, Antworten und Punkten laufen weiterhin über die bestehenden RPC-Funktionen.

## Tests

Die Tests laufen bei jedem Push automatisch auf GitHub (Reiter «Actions»). Ein roter Haken heisst: Etwas ist kaputt.

- **Oberfläche** (`tests/e2e/`): Ein nachgebildetes Backend ersetzt Supabase. Playwright spielt ganze Runden mit Host, Beamer und zwei Handys durch (Freitext, Multiple Choice, Schätzfrage, Buzzer, Joker, 50:50, Hörfrage, Finalrunde, Rückblick, Editor, Import, Tastenkürzel, Anmeldung).
  ```
  cd tests && npm ci && npx playwright install chromium && npm test
  ```
  Mit `MOQUIZ_SHOTS=ordner npm test` werden zusätzlich Screenshots gespeichert.
- **Datenbank** (`tests/sql/`): Spielt alle Migrationen in eine leere PostgreSQL-Datenbank ein und prüft Rechte und Funktionen mit den Rollen `anon` und `authenticated`.
  ```
  PGHOST=localhost PGPORT=5432 PGPASSWORD=… bash tests/sql/run.sh
  ```
