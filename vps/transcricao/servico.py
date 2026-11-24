"""Transcrição dos áudios do WhatsApp para a IA da LFG (Whisper rodando na VPS)
e conversão dos áudios que o corretor grava no painel.

POST /transcrever     Authorization: Bearer <token>     corpo: o arquivo de áudio
  -> {"texto": "...", "duracao_s": 12.3, "processamento_s": 4.1}
POST /converter       Authorization: Bearer <token>     corpo: áudio gravado no navegador
  -> o mesmo áudio em Ogg/Opus mono (audio/ogg), a mensagem de voz do WhatsApp
GET  /transcrever/saude -> {"ok": true, "modelo": "small"}

O token fica no Vault do Supabase; aqui guardamos só o hash SHA-256 (TOKEN_SHA256).
O serviço escuta só em 127.0.0.1: o Caddy publica o caminho /transcrever com https.
"""
import hashlib
import hmac
import json
import os
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from faster_whisper import WhisperModel

from conversao import para_ogg_opus

MODELO = os.environ.get("WHISPER_MODELO", "small")
TOKEN_SHA256 = os.environ["TOKEN_SHA256"]
PORTA = int(os.environ.get("PORTA", "8090"))
LIMITE_BYTES = 16 * 1024 * 1024  # maior áudio que o WhatsApp aceita

modelo = WhisperModel(MODELO, device="cpu", compute_type="int8", cpu_threads=os.cpu_count() or 2,
                      download_root="/opt/lfg-transcricao/modelos")
# A VPS tem 2 núcleos: um áudio por vez transcreve mais rápido que dois juntos.
trava = threading.Lock()


class Servico(BaseHTTPRequestHandler):
    def responder(self, status, corpo):
        dados = json.dumps(corpo, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(dados)))
        self.end_headers()
        self.wfile.write(dados)

    def do_GET(self):
        if self.path == "/transcrever/saude":
            return self.responder(200, {"ok": True, "modelo": MODELO})
        self.responder(404, {"erro": "não encontrado"})

    def do_POST(self):
        if self.path not in ("/transcrever", "/converter"):
            return self.responder(404, {"erro": "não encontrado"})
        token = self.headers.get("Authorization", "").removeprefix("Bearer ").strip()
        if not hmac.compare_digest(hashlib.sha256(token.encode()).hexdigest(), TOKEN_SHA256):
            return self.responder(401, {"erro": "token inválido"})
        tamanho = int(self.headers.get("Content-Length") or 0)
        if tamanho <= 0 or tamanho > LIMITE_BYTES:
            return self.responder(413, {"erro": "áudio vazio ou maior que 16 MB"})
        audio = self.rfile.read(tamanho)
        if self.path == "/converter":
            return self.converter(audio)

        with tempfile.NamedTemporaryFile(suffix=".audio") as arquivo:
            arquivo.write(audio)
            arquivo.flush()
            inicio = time.monotonic()
            try:
                with trava:
                    segmentos, info = modelo.transcribe(arquivo.name, language="pt", vad_filter=True, beam_size=1)
                    texto = " ".join(s.text.strip() for s in segmentos).strip()
            except Exception as erro:  # áudio corrompido ou formato que o decodificador não lê
                return self.responder(422, {"erro": f"não foi possível transcrever: {erro}"})
        self.responder(200, {
            "texto": texto,
            "duracao_s": round(info.duration, 1),
            "processamento_s": round(time.monotonic() - inicio, 1),
        })

    def converter(self, audio):
        try:
            ogg = para_ogg_opus(audio)
        except Exception as erro:  # arquivo que não é áudio ou veio corrompido
            return self.responder(422, {"erro": f"não foi possível converter: {erro}"})
        self.send_response(200)
        self.send_header("Content-Type", "audio/ogg")
        self.send_header("Content-Length", str(len(ogg)))
        self.end_headers()
        self.wfile.write(ogg)

    def log_message(self, formato, *args):
        # Registra só o pedido e o status, nunca o conteúdo do áudio.
        print(f"{self.address_string()} {formato % args}", flush=True)


ThreadingHTTPServer(("127.0.0.1", PORTA), Servico).serve_forever()
