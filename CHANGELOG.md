# Changelog – CocktailBot App

Format: [MAJOR.MINOR.PATCH] – Datum. Neueste Version oben.
Backups liegen als nummerierte ZIPs in `versions/` im Projektordner.

## [1.11.0] – 2026-11-05
### Geändert
- „Pumpen & GPIO" und „Kalibrierung" zu **einer Seite „Pumpen"** zusammengefasst
  (Karten-Layout): pro Pumpe Zutat zuordnen, aktivieren, Test-Lauf und
  Kalibrieren an einer Stelle; Active-Low + Speichern darunter. Alter Menüpunkt
  „Kalibrierung" entfällt (Deep-Link leitet auf „Pumpen").

## [1.10.6] – 2026-11-05
### Neu
- Fertig-Meldung nach dem Zubereiten schließt automatisch nach 20 s.

## [1.10.5] – 2026-11-05
### Geändert
- Kiosk-Cocktailkarten: Bildhöhe 5:4 (zweite Zeile füllt den Bildschirm besser).

## [1.10.3] – 2026-11-05
### Geändert
- Scrollleiste im App-Design (dunkle Spur, grüner Schieber).

## [1.10.2] – 2026-11-05
### Geändert
- Kiosk-Ansicht (Pi-Display): Cocktail-Karten jetzt **4 pro Zeile** (statt vieler
  kleiner), größere quadratische Bilder und Schrift; vertikal scrollbar.

## [1.10.1] – 2026-11-05
### Behoben
- Vollbild-Starter: echtes Vollbild (Taskbar wird abgedeckt) – `--app` entfernt,
  `--kiosk --start-fullscreen` mit positionaler URL.

## [1.10.0] – 2026-11-05
### Neu
- **Desktop-Starter**: Icon „CocktailBot" auf dem Pi-Desktop startet die App im
  echten **Vollbild** (Kiosk, ohne Browser-Leisten). Neues Skript
  `cocktailbot-desktop.sh` legt Starter + Vollbild-Startskript an.
- **„CocktailBot beenden"** im Menü (Einstellungen → ganz unten, nur auf dem
  Pi-Bildschirm sichtbar) schließt den Vollbild-Browser und bringt den Pi zurück
  zum Desktop. Endpunkt `/api/kiosk/quit` (nur lokal).
- **Weißer Rum** als Standard-Zutat ergänzt (inkl. Icon).
### Geändert
- Installer startet den Kiosk nicht mehr automatisch beim Booten, sondern legt
  den Desktop-Starter an (manuelles Starten per Icon). Doppeltes `git` im
  Paket-Setup entfernt.

## [1.9.0] – 2026-11-05
### Neu
- PayPal: **Sandbox- und Live-Zugangsdaten gleichzeitig** hinterlegbar
  (`COCKTAILBOT_PAYPAL_SANDBOX_*` und `COCKTAILBOT_PAYPAL_LIVE_*`), Umschalten
  der Umgebung direkt in der App unter Einstellungen → Preise → PayPal. Der
  „Testmodus" (Simulation) bleibt davon unabhängig. Verbindung je Umgebung
  testbar; die gewählte Umgebung wird pro Bestellung gespeichert.
- Mail-Backup: **alle SMTP-Angaben** (Host, Port, Sicherheit, Benutzer, From,
  To, Passwort) lassen sich in `/etc/cocktailbot/mail.env` vorbelegen und
  bleiben in der App änderbar (App-Einstellung hat Vorrang vor der Datei).
- Vorlagen `paypal.env.example` (beide Umgebungen) und `mail.env.example`
  (alle Felder) erweitert.
### Technik
- `payments.py` komplett umgebungsabhängig (base_url/creds/Token je mode,
  Rückwärtskompatibilität über generische Variablen).
- `/api/pay/config` liefert `credentials` (sandbox/live), `/api/pay/test`
  akzeptiert `mode`; `/api/state` zeigt die wirksame Mail-Konfiguration.

## [1.8.0] – 2026-11-05
### Neu
- Backup der Einstellungen unter „Einstellungen → Backup": Sicherung aller
  Daten (Rezepte, Zutaten, Pumpen, Preise, Einstellungen) als Zip **lokal auf
  dem Pi**, mit Liste, Download, Wiederherstellen (inkl. automatischer
  Sicherheitskopie vorher) und Löschen. Wiederherstellen auch aus einer
  hochgeladenen Datei (USB/Mail).
- **Passwörter (Admin/Mail) werden aus dem Backup entfernt** – es kann gefahrlos
  verschickt werden; beim Wiederherstellen bleiben die laufenden Secrets erhalten.
- Backup **per Mail** versenden (SMTP-Einstellungen in der Oberfläche; Passwort
  wird serverseitig gehalten, alternativ in `/etc/cocktailbot/mail.env`).
- **USB-Erstinstallation**: `cocktailbot-setup.sh` holt die aktuellste Version
  aus Git und installiert alles; vorbereitete `paypal.env`/`mail.env` neben dem
  Skript werden automatisch übernommen (Secrets nie im Repo).
- Vorlagen `paypal.env.example` und `mail.env.example` zum Vorbereiten am PC.
- `configure-mail.sh` zum Hinterlegen des Mail-Passworts.
### Technik
- Neue Endpunkte `/api/backup/create|list|download|delete|restore|mail`;
  `/api/state` versteckt jetzt auch `smtp_password` (nur `smtp_password_set`).
- Installer legt `backups/` an und lädt zusätzlich `mail.env` als EnvironmentFile.

## [1.7.0] – 2026-11-05
### Neu
- Menü-Update: unter „Einstellungen → Updates" lässt sich direkt am Gerät nach
  einer neuen Version suchen und mit einem Tipp aktualisieren (holt den Code aus
  Git und startet den Bot neu). **Live-Daten (Rezepte, Füllstände, Preise,
  Verbrauch) bleiben beim Update erhalten.**
- Bilder sind jetzt endungsunabhängig: liegt z. B. `mojito.png` im Ordner,
  findet die App es auch, wenn im Rezept `mojito.jpg` steht (neue Routen
  `/img/cocktail/<name>` und `/img/ingredient/<name>`).
### Technik
- Installer richtet App als Git-Checkout ein, legt `cocktailbot-update.sh`,
  `/etc/cocktailbot/update.conf` und eine eng begrenzte sudo-Regel an.
- `configure-update.sh` hinterlegt optional einen GitHub-Token (nur für ein
  privates Repo nötig).
- `/api/state` liefert die Version; neue Endpunkte `/api/update/status|check|apply`.

## [1.6.2] – 2026-11-05
### Behoben
- Speichern-Meldung unter „Pumpen & GPIO" erwähnt den Neustart-Hinweis nur
  noch, wenn Active-Low tatsächlich geändert wurde (vorher irritierend beim
  reinen Speichern der Pumpenzuordnung).

## [1.6.1] – 2026-11-05
### Geändert
- Option „Relais Active-Low" von „Allgemein" in den Reiter „Pumpen & GPIO"
  verschoben (thematisch passender), mit kurzer Erklärung.

## [1.6.0] – 2026-11-05
### Neu
- Partykarte (Getränkekarte): teil- und druckbare Karte aller verfügbaren
  Cocktails unter /menu, mit QR-Code zum Teilen (Gäste öffnen sie am Handy).
- Partyplaner mit Einkaufsliste: aus Gästezahl, Getränken pro Gast und
  Cocktail-Auswahl wird der Zutatenbedarf berechnet und gegen den Vorrat
  gestellt – Ausgabe als Einkaufsliste (Liter und benötigte Flaschen).

## [1.5.0] – 2026-11-05
### Neu
- Danke-Seite als PayPal-Return-URL: nach erfolgreicher Zahlung sieht der Gast
  am Handy „Danke, [Name]! [Cocktail] wird zubereitet". Return-URL wird
  automatisch gebaut (LAN-IP des Pi; optional per paypal.public_base).
- Konsum-Übersicht pro Gast auf der Danke-Seite: Anzahl Cocktails, Menge und
  geschätzter Alkohol (g und Standardgläser), mit sachlichem Hinweis.
  Zähler je PayPal-Zahler; /api/pay/tally/reset setzt ihn zurück.
- Testmodus leitet ebenfalls auf die Danke-Seite (statt der nackten
  Simulations-Meldung).
### Behoben
- Teil-Updates der Einstellungen überschreiben verschachtelte Blöcke
  (prices/paypal/wled) nicht mehr versehentlich.

## [1.4.1] – 2026-11-05
### Neu
- Ist eine Pumpe deaktiviert, werden alle Cocktails mit dieser Zutat komplett
  ausgeblendet. Ist die Zutat nur leer, bleiben sie sichtbar (als nicht zapfbar
  markiert).
- Knopf auf der Füllstände-Seite: „Nicht zapfbare ausblenden" versteckt alle
  aktuell nicht zapfbaren Cocktails (umschaltbar).

## [1.4.0] – 2026-11-04
### Neu
- PayPal-Kassenmodus (Einstellungen → Preise → PayPal): Gast bezahlt per
  QR-Code/PayPal, danach wird zubereitet. Ablauf wie im Original: Bestellung
  erstellen → QR scannen → bezahlen → Zubereitung. Doppelte Nutzung einer
  Zahlung wird verhindert; Gratis-Getränke überspringen die Bezahlung.
- Testmodus: der komplette Ablauf ist ohne echtes PayPal-Konto prüfbar
  („Zahlung simulieren"). Echte Zugangsdaten kommen auf dem Pi in
  /etc/cocktailbot/paypal.env (Skript configure-paypal.sh), nie ins Frontend.
- QR-Code serverseitig (python3-qrcode); fehlt die Lib, wird ein Zahlungslink
  gezeigt.

## [1.3.1] – 2026-11-04
### Geändert
- Kiosk-Ansicht auf das tatsächliche 7"-Display 800×480 abgestimmt (kompaktere
  Kopfzeile, engeres Kartenraster, 4:3-Bilder, scrollende Dialoge).

## [1.3.0] – 2026-11-04
### Neu
- Preise-Seite (Einstellungen → Preise): Standardpreis pro Kategorie,
  Preis pro Kategorie+Größe (überschreibt Einzelpreise), Preis pro Cocktail+Größe
  und „Gratis" pro Cocktail. Preis erscheint auf Karten und im Detail.
- LED & WLED-Seite: zusätzlich zur Pico-LED können pro Status (bereit/läuft/
  Fehler/fertig) WLED-URLs hinterlegt und getestet werden; werden bei
  Statuswechsel automatisch aufgerufen.
### Geändert
- Kiosk-Ansicht auf die echte Displayauflösung 1024×600 abgestimmt.
- LED-Einstellungen von „Allgemein" auf die neue LED & WLED-Seite verschoben.

## [1.2.0] – 2026-11-04
### Neu
- Zutaten können Bilder haben (Editor-Feld + Vorschau in Zutatenliste und
  Füllständen). Für jede Zutat ein sauberes, eigenes Flaschen-Icon als Standard.
- Kiosk-Ansicht: Das lokale 10-Zoll-Pi-Display (Aufruf über localhost) bekommt
  automatisch größere Touch-Ziele; Tablets/PC im LAN die normale Ansicht.
- Stärkeregler mit Rastpunkten 25/50/100/125/150 % (Zwischenwerte weiter möglich),
  standardmäßig aktiv.
- Stop-Knopf bei Reinigung und Entlüften (hält sofort alle Pumpen an).
- Verstecktes Master-Admin-Passwort (immer gültig, nicht änderbar/angezeigt).
### Geändert
- Kalibrierung: Default-Testdauer 2 s; GPIO-Spalte an zweite Stelle (nach Pumpe).
### Behoben
- Abgeschnittene Cocktail-Beschreibungen werden jetzt vollständig umbrochen.

## [1.1.4] – 2026-11-04
### Geändert
- „+ Neue Zutat" wird jetzt oben (statt unten) angezeigt.

## [1.1.3] – 2026-11-04
### Neu
- Füllstände: Knopf „Alle auffüllen" oben rechts setzt alle automatischen
  Zutaten in einem Schritt auf voll (Stand = Kapazität).

## [1.1.2] – 2026-11-04
### Behoben
- Fertig-Dialog zeigte bei manuellen Zutaten zwei Mengen (hochgerechnete ml
  plus die ml im Hinweistext). Jetzt hat der Hinweis Vorrang; die hochgerechnete
  Menge entfällt für manuelle Zutaten (z. B. „+ Cola – 150ml Cola hinzufügen").

## [1.1.1] – 2026-11-04
### Geändert
- Für die 17 Drinks mit älteren Bildern wieder die alten (bevorzugten) Fotos
  verwendet; die neuen optimierten Bilder bleiben nur dort, wo vorher keins war.

## [1.1.0] – 2026-11-04
### Neu
- 52 Cocktailbilder eingebunden (fast alle Rezepte, inkl. alkoholfreie).
- Bilder fürs Kiosk-Display optimiert: auf max. 800 px verkleinert und als
  JPEG komprimiert (gesamt ~100 MB → ~5,4 MB). Originale bleiben im Bilderordner.
- Nur „Almond Citrus Cooler" hat noch kein eigenes Bild (Platzhalter).

## [1.0.2] – 2026-11-04
### Geändert
- Flaschengröße (Kapazität) aller alkoholfreien Zutaten auf 1000 ml gesetzt
  (Säfte, Sirupe, Cola, Tonic, Sprudelwasser usw.). Spirituosen und reine
  Garnituren unverändert.

## [1.0.1] – 2026-11-04
### Behoben
- Zubereitungsdialog zeigte faktisch nur eine Zutat (die parallelen Meldungen
  überschrieben sich). Jetzt werden alle automatisch dosierten Zutaten
  angezeigt und einzeln abgehakt (✓ fertig, • läuft, „zum Schluss" für delayed).

## [1.0.0] – 2026-11-04
Erste versionierte Fassung. Fasst die bisherigen Iterationen zusammen.

### Enthalten
- Eigenständige App für Raspberry Pi 5 (Flask-Backend + Touch-Oberfläche), Mock-Modus für den PC.
- Hardware identisch zum bestehenden Aufbau: 18 Pumpen, Active-Low,
  GPIO-Belegung 17,18,27,22,23,24,25,4,5,6,13,19,26,16,20,21,12,15; Pi 5 über rpi-lgpio.
- Überlappende Dosierung (100 ms Versatz), „delayed"-Zutaten zuletzt.
- 53 Rezepte (49 aus dem Original-Image + 4 aus der CSV), 24 Zutaten, echte Pumpenbelegung.
- 17 eigene Cocktailbilder eingebunden, Rest mit Platzhalter.
- Editoren für Zutaten (Name, Alkohol/-frei, Preis/L) und Rezepte
  (ml, automatisch/manuell, „erst am Ende", Hinweise).
- Kalibrierung, Reinigung, Entlüften, Füllstände.
- API/Webhook zum Auslösen jedes Cocktails, optionales Token.
- Einstellungs-Passwort (Sperre im Partybetrieb).
- Kostenstatistik aus Preis pro Liter.
- Sortierung der Cocktailkarten inkl. eigener Reihenfolge (wie im Original).
- Durchgehend Umlaute in Oberfläche und Meldungen.

### Behoben
- Leere Einstellungs-Tabellen (fehlerhaftes `<tr>`-Parsing).
- Unsichtbar überlagernde Modals (CSS `[hidden]`).
- Doppelt kodierte Umlaute (68 Stellen).

<!--
Vorlage für die nächste Version (oben einfügen):

## [1.0.1] – JJJJ-MM-TT
### Neu
- ...
### Geändert
- ...
### Behoben
- ...
-->
