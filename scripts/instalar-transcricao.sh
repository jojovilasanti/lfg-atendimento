#!/usr/bin/env bash
# Instala ou atualiza na VPS o serviço que transcreve os áudios do WhatsApp
# (faster-whisper, modelo "small") e a configuração do Caddy.
# Uso: bash scripts/instalar-transcricao.sh
#
# O token fica no Vault do Supabase (segredo "transcricao_token"); a VPS guarda
# só o hash, em /etc/lfg-transcricao.env. Para gerar o hash sem ver o token:
#   select encode(extensions.digest(decrypted_secret, 'sha256'), 'hex')
#   from vault.decrypted_secrets where name = 'transcricao_token';
set -euo pipefail

SERVIDOR="root@200.141.19.215"
CHAVE="$HOME/.ssh/lfg_vps_ed25519"
VPS="$(cd "$(dirname "$0")/../vps" && pwd)"

tar -C "$VPS" -czf - Caddyfile transcricao | ssh -i "$CHAVE" -o BatchMode=yes "$SERVIDOR" '
set -e
rm -rf /root/lfg-implantacao && mkdir -p /root/lfg-implantacao && tar -xzf - -C /root/lfg-implantacao
cd /root/lfg-implantacao

if [ ! -f /etc/lfg-transcricao.env ]; then
  echo "Falta /etc/lfg-transcricao.env (TOKEN_SHA256, WHISPER_MODELO=small, PORTA=8090, HF_HOME=/opt/lfg-transcricao/hf)." >&2
  exit 1
fi

id lfg-transcricao >/dev/null 2>&1 || useradd --system --home-dir /opt/lfg-transcricao --shell /usr/sbin/nologin lfg-transcricao
mkdir -p /opt/lfg-transcricao
cp transcricao/servico.py transcricao/conversao.py transcricao/requirements.txt /opt/lfg-transcricao/
chown -R lfg-transcricao: /opt/lfg-transcricao
chown root:lfg-transcricao /etc/lfg-transcricao.env && chmod 640 /etc/lfg-transcricao.env

cd /opt/lfg-transcricao
[ -d venv ] || runuser -u lfg-transcricao -- python3 -m venv venv
runuser -u lfg-transcricao -- venv/bin/pip install -q --disable-pip-version-check -r requirements.txt
# Baixa o modelo agora, para o primeiro áudio não esperar o download.
runuser -u lfg-transcricao -- env HF_HOME=/opt/lfg-transcricao/hf venv/bin/python -c "from faster_whisper import WhisperModel; WhisperModel(\"small\", device=\"cpu\", compute_type=\"int8\", download_root=\"/opt/lfg-transcricao/modelos\")"

cp /root/lfg-implantacao/transcricao/lfg-transcricao.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now lfg-transcricao
systemctl restart lfg-transcricao

cp /root/lfg-implantacao/Caddyfile /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy
systemctl is-active lfg-transcricao
'
