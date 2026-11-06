#!/usr/bin/env bash
# =============================================================================
# CocktailBot - Erst-Installation vom USB-Stick.
#
# Dieses Skript auf den Raspberry Pi 5 kopieren (z. B. per USB) und EINMAL
# ausfuehren. Es holt die AKTUELLSTE Version aus GitHub (n3rdz/n3rdzBot),
# installiert alles (Dienst, Kiosk, Menue-Update) und startet den Bot - danach
# laeuft die Maschine mit echter Hardware (GPIOs, Pumpen).
#
# Aufruf auf dem Pi:
#     sudo bash cocktailbot-setup.sh
#
# Bei PRIVATEM GitHub-Repo wird nach einem Token gefragt (fine-grained,
# Contents: Read-only fuer n3rdz/n3rdzBot). Ist das Repo oeffentlich, einfach
# leer lassen.
# =============================================================================
set -Eeuo pipefail

REPO_URL="https://github.com/n3rdz/n3rdzBot.git"
BRANCH="main"

info(){ echo -e "\033[0;34m[INFO]\033[0m $*"; }
ok(){   echo -e "\033[0;32m[OK]\033[0m $*"; }
err(){  echo -e "\033[0;31m[FEHLER]\033[0m $*" >&2; }

if [ "$EUID" -ne 0 ]; then
  echo "Bitte mit sudo ausfuehren:  sudo bash cocktailbot-setup.sh"; exit 1
fi

TARGET_USER="${SUDO_USER:-pi}"
if ! id "$TARGET_USER" >/dev/null 2>&1; then TARGET_USER="pi"; fi
APP_DIR="/home/${TARGET_USER}/cocktailbot-app"
export DEBIAN_FRONTEND=noninteractive

# Ordner, in dem dieses Skript liegt (der USB-Stick) - dort suchen wir nach
# vorbereiteten Zugangsdaten (paypal.env / mail.env), die der Nutzer am PC
# ausgefuellt und mitgebracht hat.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

info "Installiere fuer Benutzer '${TARGET_USER}' nach ${APP_DIR}"

# --- git sicherstellen -------------------------------------------------------
if ! command -v git >/dev/null 2>&1; then
  info "git wird installiert..."
  apt-get update -yq && apt-get install -yq git
fi

# --- optionaler Token fuer privates Repo ------------------------------------
echo
echo "Ist dein GitHub-Repo privat? Dann hier einen Token eingeben"
echo "(fine-grained, Contents: Read-only fuer n3rdz/n3rdzBot)."
echo "Oeffentliches Repo -> einfach leer lassen und Enter druecken."
read -rsp "GitHub-Token: " GH_TOKEN
echo

CLONE_URL="$REPO_URL"
if [ -n "${GH_TOKEN}" ]; then
  CLONE_URL="https://x-access-token:${GH_TOKEN}@${REPO_URL#https://}"
fi

# --- vorhandene Installation beiseitelegen ----------------------------------
if [ -e "${APP_DIR}" ]; then
  BK="${APP_DIR}.bak-$(date +%Y%m%d-%H%M%S)"
  info "Vorhandenen Ordner sichern nach ${BK}"
  mv "${APP_DIR}" "${BK}"
fi

# --- klonen (als Zielbenutzer) ----------------------------------------------
info "Hole aktuellste Version aus GitHub (${BRANCH})..."
if ! sudo -u "${TARGET_USER}" git clone --branch "${BRANCH}" --depth 1 "${CLONE_URL}" "${APP_DIR}"; then
  err "Klonen fehlgeschlagen."
  if [ -z "${GH_TOKEN}" ]; then
    err "Falls das Repo PRIVAT ist: Skript erneut starten und einen Token eingeben,"
    err "oder das Repo auf GitHub oeffentlich stellen."
  else
    err "Token pruefen (Contents: Read-only fuer n3rdz/n3rdzBot) und erneut versuchen."
  fi
  exit 1
fi

# Token nicht im Klartext in der Git-Konfiguration lassen -> saubere Remote-URL.
sudo -u "${TARGET_USER}" git -C "${APP_DIR}" remote set-url origin "${REPO_URL}"

# Token fuer das spaetere Menue-Update hinterlegen (sicher, nur root).
if [ -n "${GH_TOKEN}" ]; then
  mkdir -p /etc/cocktailbot
  umask 177
  printf 'GH_UPDATE_TOKEN=%s\n' "${GH_TOKEN}" > /etc/cocktailbot/update.env
  chmod 600 /etc/cocktailbot/update.env
  ok "Token fuer Menue-Updates gespeichert (/etc/cocktailbot/update.env)."
fi

# --- vorbereitete Zugangsdaten vom USB-Stick uebernehmen --------------------
# Echte paypal.env / mail.env, die der Nutzer am PC ausgefuellt und neben dieses
# Skript gelegt hat, werden sicher nach /etc/cocktailbot/ kopiert (0600).
# Sie stehen nie im Git-Repo.
mkdir -p /etc/cocktailbot
for secret in paypal.env mail.env; do
  if [ -f "${SCRIPT_DIR}/${secret}" ]; then
    # Beim Kopieren Windows-Zeilenenden (CRLF) entfernen - sonst landet ein \r
    # im Secret und die Anmeldung schlaegt fehl.
    umask 077
    sed 's/\r$//' "${SCRIPT_DIR}/${secret}" > "/etc/cocktailbot/${secret}"
    chmod 0600 "/etc/cocktailbot/${secret}"
    ok "Zugangsdaten uebernommen: /etc/cocktailbot/${secret}"
  fi
done

# --- eigentliche Installation ------------------------------------------------
chmod +x "${APP_DIR}/install_pi5.sh" 2>/dev/null || true
export SUDO_USER="${TARGET_USER}"     # install_pi5.sh ermittelt daraus den Benutzer
info "Starte Installation..."
bash "${APP_DIR}/install_pi5.sh"

echo
ok "Fertig! CocktailBot ist installiert und laeuft."
echo "   Oberflaeche am Pi:     http://localhost:3000"
echo "   Im Netzwerk:           http://<Pi-IP>:3000"
echo
echo "Optional:"
echo "   PayPal einrichten:     sudo ${APP_DIR}/configure-paypal.sh"
echo "   Mail-Backup-Passwort:  sudo ${APP_DIR}/configure-mail.sh"
echo "   Spaetere Updates:      in der App unter Einstellungen -> Updates"
echo
echo "Neustart empfohlen:       sudo reboot"
