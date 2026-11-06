#!/usr/bin/env bash
# =============================================================================
# CocktailBot - Mail-Passwort fuer den Backup-Versand sicher hinterlegen.
# Legt /etc/cocktailbot/mail.env (0600) mit MAIL_PASSWORD an. Alternativ kann
# das Passwort auch direkt in der Oberflaeche (Einstellungen -> Backup)
# eingegeben werden - dieses Skript ist nur fuer alle, die das Passwort lieber
# ausserhalb der App ablegen.
#
# Aufruf:  sudo ./configure-mail.sh
# =============================================================================
set -Eeuo pipefail

if [ "$EUID" -ne 0 ]; then echo "Bitte mit sudo ausfuehren."; exit 1; fi

ENV_FILE="/etc/cocktailbot/mail.env"
mkdir -p /etc/cocktailbot

echo "SMTP-Zugangsdaten (Server/Port/Benutzer/Empfaenger) werden in der App unter"
echo "Einstellungen -> Backup eingetragen. Hier nur das Passwort."
echo
read -rsp "SMTP-Passwort eingeben (leer = Eintrag entfernen): " PW
echo

if [ -n "${PW}" ]; then
  umask 177
  printf 'MAIL_PASSWORD=%s\n' "${PW}" > "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
  echo "Passwort gespeichert in ${ENV_FILE} (nur root lesbar)."
  echo "Dienst neu starten:  sudo systemctl restart cocktailbot"
else
  rm -f "${ENV_FILE}"
  echo "Kein Passwort gesetzt - ${ENV_FILE} entfernt."
fi
