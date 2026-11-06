#!/usr/bin/env bash
# =============================================================================
# CocktailBot (Eigenbau-App) - Installation Raspberry Pi 5 / Raspberry Pi OS
# Bookworm (64-bit). Richtet Dienst + Kiosk ein. Hardware (GPIOs) unveraendert.
# =============================================================================
set -Eeuo pipefail

USER_NAME="${SUDO_USER:-pi}"
APP_SRC="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="/home/${USER_NAME}/cocktailbot-app"
PORT=3000
UPDATE_BIN="/usr/local/bin/cocktailbot-update.sh"
GIT_REPO="https://github.com/n3rdz/n3rdzBot.git"
GIT_BRANCH="main"

info(){ echo -e "\033[0;34m[INFO]\033[0m $*"; }
ok(){   echo -e "\033[0;32m[OK]\033[0m $*"; }

if [ "$EUID" -ne 0 ]; then echo "Bitte mit sudo ausfuehren."; exit 1; fi

export DEBIAN_FRONTEND=noninteractive

info "Pakete installieren..."
apt-get update -yq
# Pi 5: python3-rpi-lgpio liefert die RPi.GPIO-Kompatibilitaet ueber lgpio (RP1).
apt-get install -yq python3 python3-flask python3-serial python3-rpi-lgpio \
                    python3-qrcode gpiod chromium unclutter git

# Pumpen-Sicherheit: alle Relaispins beim Boot auf HIGH (= AUS) ziehen.
info "App installieren nach ${APP_DIR}..."
if [ "${APP_SRC}" != "${APP_DIR}" ]; then
  mkdir -p "${APP_DIR}"
  # Vorhandene Live-Daten (Rezepte, Fuellstaende, Preise, Verbrauch) retten.
  KEEP_DATA=0
  if ls "${APP_DIR}/cocktailbot/data"/*.json >/dev/null 2>&1; then
    KEEP_DATA=1; TMPD="$(mktemp -d)"; cp -a "${APP_DIR}/cocktailbot/data" "${TMPD}/"
  fi
  # Komplettes Projekt inkl. .git kopieren -> ermoeglicht Menue-Updates (git pull).
  cp -a "${APP_SRC}/." "${APP_DIR}/"
  if [ "${KEEP_DATA}" = "1" ]; then
    cp -a "${TMPD}/data/." "${APP_DIR}/cocktailbot/data/"; rm -rf "${TMPD}"
    info "Bestehende Live-Daten beibehalten."
  fi
fi
chown -R "${USER_NAME}:${USER_NAME}" "${APP_DIR}"
if [ -d "${APP_DIR}/.git" ]; then
  git config --global --add safe.directory "${APP_DIR}" 2>/dev/null || true
  sudo -u "${USER_NAME}" git -C "${APP_DIR}" config --add safe.directory "${APP_DIR}" 2>/dev/null || true
  sudo -u "${USER_NAME}" git -C "${APP_DIR}" remote set-url origin "${GIT_REPO}" 2>/dev/null \
    || sudo -u "${USER_NAME}" git -C "${APP_DIR}" remote add origin "${GIT_REPO}" 2>/dev/null || true
  ok "Git-Checkout erkannt - Menue-Updates sind aktiv."
else
  info "Hinweis: Kein .git in ${APP_DIR} - fuer Menue-Updates das Projekt per 'git clone' holen."
fi

# --- Backup-Ordner -----------------------------------------------------------
mkdir -p "${APP_DIR}/backups"
chown "${USER_NAME}:${USER_NAME}" "${APP_DIR}/backups"

# --- Menue-Update: Konfiguration, Skript, sudo-Regel -----------------------
info "Menue-Update einrichten..."
mkdir -p /etc/cocktailbot
cat > /etc/cocktailbot/update.conf <<EOF
APP_DIR="${APP_DIR}"
APP_USER="${USER_NAME}"
BRANCH="${GIT_BRANCH}"
REPO_URL="${GIT_REPO}"
SERVICE="cocktailbot"
EOF
chmod 644 /etc/cocktailbot/update.conf

cat > "${UPDATE_BIN}" <<'UPDEOF'
#!/usr/bin/env bash
# Menue-Update fuer CocktailBot: holt die neueste Version aus Git und startet
# den Dienst neu. Live-Daten bleiben erhalten. Aufruf durch die App per
#   sudo -n /usr/local/bin/cocktailbot-update.sh check|apply
# Laeuft als root; git selbst als App-Benutzer.
set -Eeuo pipefail
CONF=/etc/cocktailbot/update.conf
[ -r "$CONF" ] && . "$CONF"
[ -r /etc/cocktailbot/update.env ] && . /etc/cocktailbot/update.env   # optional: GH_UPDATE_TOKEN
: "${APP_DIR:?APP_DIR fehlt}"; : "${APP_USER:?APP_USER fehlt}"
: "${BRANCH:=main}"; : "${SERVICE:=cocktailbot}"
: "${REPO_URL:=https://github.com/n3rdz/n3rdzBot.git}"

# Bei privatem Repo: Token aus update.env in die URL einsetzen.
AUTH_URL="$REPO_URL"
if [ -n "${GH_UPDATE_TOKEN:-}" ]; then
  AUTH_URL="https://x-access-token:${GH_UPDATE_TOKEN}@${REPO_URL#https://}"
fi

run_git(){ sudo -u "$APP_USER" git -C "$APP_DIR" -c safe.directory="$APP_DIR" "$@"; }

case "${1:-check}" in
  check)
    run_git fetch --quiet "$AUTH_URL" "$BRANCH" 2>/dev/null || true
    LOCAL="$(run_git rev-parse HEAD 2>/dev/null || echo '')"
    REMOTE="$(run_git rev-parse FETCH_HEAD 2>/dev/null || echo '')"
    BEHIND="$(run_git rev-list --count "${LOCAL}..${REMOTE}" 2>/dev/null || echo 0)"
    CUR="$(tr -d '[:space:]' < "$APP_DIR/VERSION" 2>/dev/null || echo '?')"
    LAT="$(run_git show "FETCH_HEAD:VERSION" 2>/dev/null | tr -d '[:space:]' || echo '')"
    LOG="$(run_git log --pretty=format:'%h %s' "${LOCAL}..${REMOTE}" 2>/dev/null | head -20 || true)"
    python3 - "$CUR" "$LAT" "$BEHIND" "$LOG" <<'PY'
import json, sys
cur, lat, behind, log = (sys.argv + ["", "", "0", ""])[1:5]
print(json.dumps({"current": cur or "?", "latest": lat or cur or "?",
                  "behind": int(behind or 0), "log": log}))
PY
    ;;
  apply)
    BAK="$(mktemp -d)"
    cp -a "$APP_DIR/cocktailbot/data" "$BAK/data"          # Live-Daten sichern
    run_git fetch --quiet "$AUTH_URL" "$BRANCH"
    run_git reset --hard FETCH_HEAD                        # Code auf neueste Version
    cp -a "$BAK/data/." "$APP_DIR/cocktailbot/data/"       # Nutzerdaten haben Vorrang
    rm -rf "$BAK"
    chown -R "$APP_USER":"$APP_USER" "$APP_DIR"
    systemctl restart "$SERVICE"
    echo '{"ok":true}'
    ;;
  *) echo "usage: $0 check|apply" >&2; exit 2 ;;
esac
UPDEOF
chmod 755 "${UPDATE_BIN}"

cat > /etc/sudoers.d/cocktailbot-update <<EOF
${USER_NAME} ALL=(root) NOPASSWD: ${UPDATE_BIN}
EOF
chmod 440 /etc/sudoers.d/cocktailbot-update
if visudo -cf /etc/sudoers.d/cocktailbot-update >/dev/null 2>&1; then
  ok "Menue-Update eingerichtet."
else
  echo "sudoers-Regel fehlerhaft - wird sicherheitshalber entfernt."
  rm -f /etc/sudoers.d/cocktailbot-update
fi

# --- Pumpen-Safety-Dienst: GPIOs beim Start sicher auf AUS -------------------
cat > /usr/local/bin/cocktailbot-pump-safety.sh <<'EOF'
#!/usr/bin/env bash
PINS=(17 18 27 22 23 24 25 4 5 6 13 19 26 16 20 21 12 15)
if command -v pinctrl >/dev/null 2>&1; then
  for p in "${PINS[@]}"; do pinctrl set "$p" op dh; done
elif command -v raspi-gpio >/dev/null 2>&1; then
  for p in "${PINS[@]}"; do raspi-gpio set "$p" op dh; done
fi
EOF
chmod +x /usr/local/bin/cocktailbot-pump-safety.sh

cat > /etc/systemd/system/cocktailbot-safety.service <<EOF
[Unit]
Description=CocktailBot Pump Safety (alle Relais AUS)
DefaultDependencies=no
After=local-fs.target
Before=cocktailbot.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/cocktailbot-pump-safety.sh

[Install]
WantedBy=multi-user.target
EOF

# --- App-Dienst -------------------------------------------------------------
cat > /etc/systemd/system/cocktailbot.service <<EOF
[Unit]
Description=CocktailBot App
After=network.target cocktailbot-safety.service
Wants=cocktailbot-safety.service

[Service]
Type=simple
User=${USER_NAME}
WorkingDirectory=${APP_DIR}
Environment=COCKTAILBOT_PORT=${PORT}
# PayPal-Zugangsdaten (optional; vom Skript configure-paypal.sh erzeugt)
EnvironmentFile=-/etc/cocktailbot/paypal.env
# Optionales Mail-Passwort fuer den Backup-Versand (von configure-mail.sh)
EnvironmentFile=-/etc/cocktailbot/mail.env
ExecStart=/usr/bin/python3 -m cocktailbot.app
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable cocktailbot-safety.service cocktailbot.service
systemctl restart cocktailbot-safety.service
systemctl restart cocktailbot.service
ok "Dienst laeuft auf Port ${PORT}."

# --- Desktop-Starter + Vollbild (Kiosk) -------------------------------------
# Legt einen "CocktailBot"-Starter auf den Desktop. Doppelklick -> Vollbild.
# Beenden nur ueber den Knopf im App-Menue. Kein Auto-Start beim Booten.
info "Desktop-Starter einrichten..."
export COCKTAILBOT_PORT="${PORT}"
if [ -f "${APP_DIR}/cocktailbot-desktop.sh" ]; then
  sudo -u "${USER_NAME}" --preserve-env=COCKTAILBOT_PORT \
    bash "${APP_DIR}/cocktailbot-desktop.sh" || true
fi

ok "Fertig. Oberflaeche: http://localhost:${PORT}  (im Netz: http://<Pi-IP>:${PORT})"
echo "Neu starten empfohlen: sudo reboot"
echo "Logs: journalctl -u cocktailbot -f"
