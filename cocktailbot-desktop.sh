#!/usr/bin/env bash
# =============================================================================
# CocktailBot - Desktop-Icon + Vollbild-Starter einrichten.
#
# Legt einen Starter "CocktailBot" auf den Desktop. Ein Doppelklick oeffnet die
# App im echten Vollbild (Kiosk). Beenden nur ueber den Knopf im Menue
# (Einstellungen -> ganz unten "CocktailBot beenden").
#
# Aufruf (als normaler Benutzer, NICHT mit sudo noetig):
#     bash ~/cocktailbot-app/cocktailbot-desktop.sh
# =============================================================================
set -Eeuo pipefail

# Zielbenutzer/Home bestimmen (auch wenn versehentlich mit sudo gestartet).
RUN_USER="${SUDO_USER:-$(id -un)}"
USER_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
USER_HOME="${USER_HOME:-/home/$RUN_USER}"
PORT="${COCKTAILBOT_PORT:-3000}"
APP_DIR="${USER_HOME}/cocktailbot-app"
KIOSK="${USER_HOME}/cocktailbot-kiosk.sh"
ICON="${APP_DIR}/cocktailbot/static/app-icon.svg"

run_as(){ if [ "$(id -un)" = "$RUN_USER" ]; then "$@"; else sudo -u "$RUN_USER" "$@"; fi; }

# --- Vollbild-Starter (Kiosk) schreiben -------------------------------------
cat > "${KIOSK}" <<EOF
#!/usr/bin/env bash
# Startet CocktailBot im Vollbild. Beenden ueber den Knopf im App-Menue.
URL="http://localhost:${PORT}"
# schon offen? dann nicht doppelt starten
pgrep -f -- "--kiosk" >/dev/null 2>&1 && exit 0
# auf den Dienst warten (max. ~30s)
for i in \$(seq 1 30); do curl -sf "\$URL" >/dev/null 2>&1 && break; sleep 1; done
command -v unclutter >/dev/null 2>&1 && unclutter -idle 3 &
xset s off -dpms 2>/dev/null || true
BROWSER="\$(command -v chromium-browser || command -v chromium)"
exec "\$BROWSER" --kiosk --start-fullscreen \\
  --noerrdialogs --disable-infobars --disable-session-crashed-bubble \\
  --disable-pinch --overscroll-history-navigation=0 \\
  --check-for-update-interval=31536000 --ozone-platform-hint=auto \\
  "\$URL"
EOF
chmod +x "${KIOSK}"
chown "${RUN_USER}:${RUN_USER}" "${KIOSK}" 2>/dev/null || true

# --- Desktop-Icon anlegen ----------------------------------------------------
DESK="${USER_HOME}/Desktop"
mkdir -p "${DESK}"
LAUNCHER="${DESK}/CocktailBot.desktop"
cat > "${LAUNCHER}" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=CocktailBot
Comment=CocktailBot im Vollbild starten
Exec=${KIOSK}
Icon=${ICON}
Terminal=false
Categories=Utility;
EOF
chmod +x "${LAUNCHER}"
chown "${RUN_USER}:${RUN_USER}" "${LAUNCHER}" 2>/dev/null || true
# Datei als vertrauenswuerdig markieren (sonst fragt der Dateimanager nach)
run_as gio set "${LAUNCHER}" metadata::trusted true 2>/dev/null || true

echo "Fertig. Auf dem Desktop liegt jetzt der Starter 'CocktailBot'."
echo "Doppelklick -> Vollbild. Beenden ueber Einstellungen -> 'CocktailBot beenden'."
