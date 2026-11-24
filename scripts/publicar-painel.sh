#!/usr/bin/env bash
# Compila o painel e publica na VPS da Hostinger (https://lfg.jojodigitals.com).
# O endereço antigo (srv2083149.hstgr.cloud) só redireciona para cá (vps/Caddyfile).
# A troca é atômica: a versão anterior fica em /var/www/lfg-crm.anterior.
# Pare o servidor de desenvolvimento antes: com ele aberto, o npm ci falha no Windows.
# Uso: bash scripts/publicar-painel.sh
set -euo pipefail

SERVIDOR="root@200.141.19.215"
CHAVE="$HOME/.ssh/lfg_vps_ed25519"
DESTINO="/var/www/lfg-crm"
PASTA="$(cd "$(dirname "$0")/../painel" && pwd)"

cd "$PASTA"
npm ci --no-audit --no-fund
npm run build

tar -C dist -czf - . | ssh -i "$CHAVE" -o BatchMode=yes "$SERVIDOR" "
  set -e
  rm -rf '$DESTINO.nova' && mkdir -p '$DESTINO.nova'
  tar -xzf - -C '$DESTINO.nova'
  rm -rf '$DESTINO.anterior'
  if [ -d '$DESTINO' ]; then mv '$DESTINO' '$DESTINO.anterior'; fi
  mv '$DESTINO.nova' '$DESTINO'
"
echo "Painel publicado em https://lfg.jojodigitals.com"
