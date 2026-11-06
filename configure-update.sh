#!/usr/bin/env bash
# =============================================================================
# CocktailBot - GitHub-Token fuer das Menue-Update hinterlegen (nur noetig,
# wenn das Repository PRIVAT ist). Bei einem oeffentlichen Repo wird kein
# Token gebraucht - dann dieses Skript einfach nicht ausfuehren.
#
# Aufruf:  sudo ./configure-update.sh
# =============================================================================
set -Eeuo pipefail

if [ "$EUID" -ne 0 ]; then echo "Bitte mit sudo ausfuehren."; exit 1; fi

ENV_FILE="/etc/cocktailbot/update.env"
mkdir -p /etc/cocktailbot

echo "Fuer ein privates Repo brauchst du einen Fine-grained Personal Access Token"
echo "mit Leserecht 'Contents: Read-only' NUR fuer n3rdz/n3rdzBot."
echo "(GitHub -> Settings -> Developer settings -> Fine-grained tokens)"
echo
read -rsp "GitHub-Token eingeben (leer lassen = kein Token / oeffentliches Repo): " TOK
echo

if [ -n "${TOK}" ]; then
  umask 177
  printf 'GH_UPDATE_TOKEN=%s\n' "${TOK}" > "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
  echo "Token gespeichert in ${ENV_FILE} (nur root lesbar, 0600)."
else
  rm -f "${ENV_FILE}"
  echo "Kein Token gesetzt - Update laeuft anonym (funktioniert nur bei oeffentlichem Repo)."
fi

echo "Fertig. Test:  sudo /usr/local/bin/cocktailbot-update.sh check"
