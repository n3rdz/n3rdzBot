# CocktailBot – eigenständige App

Komplett eigene, offene Steuer- und Bedien-Software für die Cocktailmaschine.
Keine Lizenzprüfung, keine Bezahlschranke. Läuft auf dem Raspberry Pi 5 mit
deiner **bestehenden Verdrahtung** – die GPIO-Belegung ist unverändert
übernommen.

## Hardware (unverändert übernommen)

- **18 Pumpen**, Relais **Active-Low** (GPIO HIGH = Pumpe AUS, LOW = EIN)
- **Pin-Belegung Pumpe 1 → 18 (BCM):**
  `17, 18, 27, 22, 23, 24, 25, 4, 5, 6, 13, 19, 26, 16, 20, 21, 12, 15`
- Pi 5: `RPi.GPIO` über `python3-rpi-lgpio`, RP1-Chip wird automatisch erkannt
- Optionale LED-Beleuchtung über den **Pico 2** (USB-Serial, dein `main.py`-Protokoll)

Diese Zuordnung steht in `cocktailbot/hardware/pumps.py` (`PUMP_PINS`). Solange
sich an der Verdrahtung nichts ändert, bleibt sie unverändert.

## Schnellstart auf dem PC (Test, ohne echte Pumpen)

```bash
pip install Flask pyserial
COCKTAILBOT_MOCK_GPIO=1 python3 -m cocktailbot.app
# Browser: http://localhost:3000
```

Im Mock-Modus laufen keine GPIOs; alle Abläufe (Dosierzeiten, Reinigung,
Kalibrierung) werden nur zeitlich simuliert. Oben rechts leuchtet der Punkt
gelb = Mock.

## Installation auf dem Raspberry Pi 5

```bash
sudo ./install_pi5.sh
sudo reboot
```

Richtet ein: App-Dienst (`cocktailbot.service`), einen **Pump-Safety-Dienst**
(zieht beim Booten alle Relais auf AUS) und den **Kiosk** (Chromium im
Vollbild, Wayland/labwc). Oberfläche danach unter `http://<Pi-IP>:3000`.

## Funktionen

- **Cocktails / Alkoholfrei / Shots** mit Größen- und Stärkewahl
- **Überlappende Dosierung**: Pumpen starten um je 100 ms versetzt parallel,
  `delayed`-Zutaten (z. B. Grenadine) erst danach – wie im Originalaufbau
- **Kalibrierung**: Pumpe X Sekunden laufen lassen, gemessene ml eintragen → ml/s
- **Füllstände**: Stand setzen, „Voll" nach dem Nachfüllen, Warnung bei < 100 ml
- **Reinigung**: ausgewählte/alle Pumpen mit Wasser spülen
- **Entlüften**: Schläuche befüllen, bis Flüssigkeit kommt
- **Zutaten & Rezepte** verwalten, **Pumpen↔Zutat** zuordnen
- **Statistik**: Zähler pro Cocktail und Gesamtmenge
- **Not-Aus**: stoppt sofort alle Pumpen

## API / Webhook – jeden Cocktail per URL auslösen

Ideal für Home Assistant, Node-RED, Stream Deck, NFC-Tags.

```
GET/POST  /api/trigger/<id-oder-name>[?token=...&size_ml=300&strength=1.0]
```

Beispiele:
```
http://<Pi-IP>:3000/api/trigger/1
http://<Pi-IP>:3000/api/trigger/screwdriver?size_ml=300
```

Weitere Endpunkte (JSON):
```
POST /api/prepare   {"recipe_id":1,"size_ml":300,"strength":1.0}
POST /api/stop      # Not-Aus
POST /api/clean     {"pump_ids":[1,2],"seconds":20}
POST /api/vent      {"pump_ids":[1,2],"seconds":5}
GET  /api/status    # Fortschritt
GET  /api/state     # kompletter Zustand
```

**Token:** Unter Einstellungen → API & Webhook ein Token setzen. Dann ist bei
`/api/prepare` und `/api/trigger` `?token=…` (oder Header `X-API-Token`)
nötig. Leer = offen im lokalen Netz. **Keine Portfreigabe ins Internet.**

## Cocktailbilder

Die App sucht Bilder unter `cocktailbot/static/images/cocktails/<dateiname>`
(Dateiname steht je Rezept im Feld `image`). Fehlt das Bild, zeigt die Karte
automatisch einen farbigen Platzhalter. Zum provisorischen Befüllen einfach
deine Bilder aus dem Repo in diesen Ordner kopieren (Dateinamen in
`data/recipes.json` anpassen bzw. umgekehrt).

## Datenablage

Alles liegt als JSON in `cocktailbot/data/` (`recipes`, `ingredients`,
`pumps`, `settings`, `stats`). Einfach sicherbar und editierbar.

## Projektstruktur

```
cocktailbot/
  app.py              Flask-Backend + API/Webhook
  core/
    dosing.py         Rezeptskalierung, Verfügbarkeit, Startversatz
    preparation.py    Ausführung (Zubereitung/Reinigung/Entlüften)
    storage.py        JSON-Persistenz
  hardware/
    pumps.py          GPIO-Pumpensteuerung (Pi 5 + Mock)  <- PUMP_PINS hier
    leds.py           Pico-2-LED (optional)
  data/               JSON-Daten
  static/, templates/ Oberfläche
install_pi5.sh        Setup für Raspberry Pi 5
```
