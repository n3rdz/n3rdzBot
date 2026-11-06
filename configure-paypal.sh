#!/usr/bin/env bash
# =============================================================================
# CocktailBot - PayPal-Zugang einrichten (lokale Zahlung ueber den Raspberry Pi)
# Schreibt /etc/cocktailbot/paypal.env und startet den Dienst neu.
# =============================================================================
set -Eeuo pipefail

ENV_FILE=/etc/cocktailbot/paypal.env
[[ $EUID -eq 0 ]] || { echo "Bitte mit sudo ausfuehren." >&2; exit 1; }

CURRENT_MODE=sandbox; CURRENT_ID=""; CURRENT_BRAND="CocktailBot"
if [[ -f "$ENV_FILE" ]]; then
  CURRENT_MODE="$(grep -E '^COCKTAILBOT_PAYPAL_MODE=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
  CURRENT_ID="$(grep -E '^COCKTAILBOT_PAYPAL_CLIENT_ID=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
fi

read -r -p "PayPal Modus [sandbox/live] (${CURRENT_MODE:-sandbox}): " MODE
MODE="${MODE:-${CURRENT_MODE:-sandbox}}"
[[ "$MODE" == sandbox || "$MODE" == live ]] || { echo "Ungueltiger Modus." >&2; exit 2; }

read -r -p "PayPal Client-ID${CURRENT_ID:+ [vorhanden]}: " CLIENT_ID
CLIENT_ID="${CLIENT_ID:-$CURRENT_ID}"
[[ -n "$CLIENT_ID" ]] || { echo "Client-ID darf nicht leer sein." >&2; exit 2; }

read -r -s -p "PayPal Client-Secret: " CLIENT_SECRET; echo
[[ -n "$CLIENT_SECRET" ]] || { echo "Client-Secret darf nicht leer sein." >&2; exit 2; }

read -r -p "Marken-/Anzeigename (${CURRENT_BRAND}): " BRAND
BRAND="${BRAND:-$CURRENT_BRAND}"

install -d -m 0755 /etc/cocktailbot
umask 077
cat > "$ENV_FILE" <<ENV
COCKTAILBOT_PAYPAL_MODE=$MODE
COCKTAILBOT_PAYPAL_CLIENT_ID=$CLIENT_ID
COCKTAILBOT_PAYPAL_CLIENT_SECRET=$CLIENT_SECRET
COCKTAILBOT_PAYPAL_BRAND_NAME=$BRAND
ENV
chmod 0600 "$ENV_FILE"

systemctl restart cocktailbot.service 2>/dev/null || true
sleep 2
echo
echo "Gespeichert in $ENV_FILE. Teste PayPal-Verbindung ..."
if curl -fsS -X POST http://127.0.0.1:3000/api/pay/test | grep -q '"ok": *true'; then
  echo "PayPal-Verbindung erfolgreich ($MODE)."
  echo "Jetzt noch in der App unter Einstellungen -> Preise den PayPal-Kassenmodus"
  echo "aktivieren und 'Testmodus' ausschalten."
else
  echo "PayPal-Test fehlgeschlagen. Pruefe Zugangsdaten und: journalctl -u cocktailbot -n 80" >&2
  exit 1
fi
