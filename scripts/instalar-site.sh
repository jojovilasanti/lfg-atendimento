#!/usr/bin/env bash
# Instala ou atualiza na VPS o gerador do site da imobiliária (vps/site) e a
# configuração do Caddy. O gerador confere a cada minuto e só refaz as páginas
# quando o estoque ou os textos do painel mudam.
# Uso: bash scripts/instalar-site.sh
#
# O endereço do site fica em vps/Caddyfile. Antes de apontar um domínio novo, crie
# o registro A dele para o IP da VPS: o Caddy pede o certificado HTTPS sozinho.
set -euo pipefail

SERVIDOR="root@200.141.19.215"
CHAVE="$HOME/.ssh/lfg_vps_ed25519"
VPS="$(cd "$(dirname "$0")/../vps" && pwd)"

tar -C "$VPS" --exclude='__pycache__' -czf - Caddyfile site | ssh -i "$CHAVE" -o BatchMode=yes "$SERVIDOR" '
set -e
rm -rf /root/lfg-implantacao && mkdir -p /root/lfg-implantacao && tar -xzf - -C /root/lfg-implantacao
cd /root/lfg-implantacao

mkdir -p /opt/lfg-site
cp site/gerar.py site/estilo.css site/site.js site/logo-lfg.png site/logo-lfg-branca.png /opt/lfg-site/

python3 /opt/lfg-site/gerar.py --saida /var/www/lfg-site --forcar
printf "%s\n" "* * * * * root python3 /opt/lfg-site/gerar.py --saida /var/www/lfg-site >> /var/log/lfg-site.log 2>&1" > /etc/cron.d/lfg-site
chmod 644 /etc/cron.d/lfg-site

cp Caddyfile /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy
rm -rf /root/lfg-implantacao
'
echo "Gerador do site instalado."
