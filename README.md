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
| `vercel.json` | Kurzlinks: `/ABCD` öffnet die Startseite mit vorausgefülltem Raumcode |
| `vendor/qrcode.js` | QR-Code-Generator (qrcode-generator 1.4.4, MIT) |
| `fonts/` | Inter Tight als Ersatzschrift (OFL). Alte Haas Grotesk wird zuerst verwendet, falls `AlteHaasGroteskRegular.ttf` und `AlteHaasGroteskBold.ttf` im Hauptordner liegen oder lokal installiert sind. |

## Ablauf

1. **Host:** «Raum erstellen» (Konto nötig), Quiz wählen. «Beamer-Ansicht öffnen» öffnet ein zweites Fenster ohne Lösungen und Steuerknöpfe (`/?beamer`). Mit «Steuerung aufs Handy» übernimmt das Handy die Steuerung (`/?steuerung`), der Laptop zeigt dann nur noch die Beamer-Ansicht.
2. **Teams:** QR-Code scannen oder Adresse öffnen, Raumcode und Teamname eingeben, Emoji wählen.
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
- **Siegerehrung:** Podest mit Konfetti auf Beamer und Handys.

## Datenbank (Supabase)

- Projekt: `ottfpxtkgjkesidwfoxn` (Frankfurt). URL und öffentlicher Schlüssel stehen oben in `app.js`.
- Die komplette Struktur liegt in `supabase/migrations/`. Damit lässt sich die Datenbank jederzeit neu aufsetzen: neues Projekt erstellen, die SQL-Datei im SQL Editor ausführen, Edge Function `supabase/functions/signup-username` deployen (JWT-Prüfung aus), URL und Schlüssel in `app.js` eintragen.
- `public.rooms` und `public.teams` sind für alle lesbar (Live-Updates). Quiz, Lösungen, Antworten und Geheimnisse liegen im Schema `private` und sind nur über die Funktionen erreichbar.
- Konten: Benutzername und Passwort. Supabase Auth braucht eine E-Mail-Adresse, darum wird aus dem Benutzernamen eine interne Adresse `u<hash>@users.moquiz.ch` abgeleitet. Es werden keine E-Mails verschickt.
- Gratis-Plan: Supabase pausiert Projekte nach rund einer Woche ohne Nutzung. Dann im Dashboard «Restore project» wählen.

## Geteilter Zustand ohne Datenbank

Lösung zeigen, Rangliste, Überraschungsfelder, Finalrunde und Siegerehrung verteilt der Host über einen Supabase-Broadcast-Kanal (`moquiz-ui-<roomId>`). Dafür sind keine Tabellen oder Funktionen nötig. Alle Daten zu Räumen, Teams, Antworten und Punkten laufen weiterhin über die bestehenden RPC-Funktionen.
