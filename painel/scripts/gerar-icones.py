"""Gera os ícones do painel instalável (PWA) a partir do desenho do favicon:
casa azul com porta verde-limão sobre o azul-marinho da LFG.
Uso: python painel/scripts/gerar-icones.py (grava em painel/public)."""
import struct
import zlib
from pathlib import Path

PASTA = Path(__file__).resolve().parent.parent / "public"
MARINHO, AZUL, LIMAO, BRANCO = (0x00, 0x36, 0x54, 255), (0x00, 0x5D, 0x92, 255), (0x94, 0xBF, 0x0B, 255), (255, 255, 255, 255)
VAZIO = (0, 0, 0, 0)


def dentro_da_casa(x, y):
    # Mesmo desenho do favicon, numa grade de 64: telhado de (14,34) a (32,18) a (50,34), paredes até 48.
    if 34 <= y <= 48:
        return 14 <= x <= 50
    if 18 <= y < 34:
        meia = (y - 18) * 18 / 16
        return 32 - meia <= x <= 32 + meia
    return False


def na_porta(x, y):
    return 28 <= x <= 36 and 36 <= y <= 48


def desenhar(tamanho, fundo, casa, porta):
    linhas = []
    for py in range(tamanho):
        linha = bytearray([0])
        for px in range(tamanho):
            x, y = (px + 0.5) * 64 / tamanho, (py + 0.5) * 64 / tamanho
            cor = porta if na_porta(x, y) and porta else casa if dentro_da_casa(x, y) else fundo
            linha.extend(cor)
        linhas.append(bytes(linha))
    return b"".join(linhas)


def gravar(nome, tamanho, fundo, casa, porta):
    def bloco(tipo, dados):
        return struct.pack(">I", len(dados)) + tipo + dados + struct.pack(">I", zlib.crc32(tipo + dados) & 0xFFFFFFFF)

    cabecalho = struct.pack(">IIBBBBB", tamanho, tamanho, 8, 6, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + bloco(b"IHDR", cabecalho) + bloco(b"IDAT", zlib.compress(desenhar(tamanho, fundo, casa, porta), 9)) + bloco(b"IEND", b"")
    (PASTA / nome).write_bytes(png)
    print(nome, len(png), "bytes")


gravar("icone-192.png", 192, MARINHO, AZUL, LIMAO)
gravar("icone-512.png", 512, MARINHO, AZUL, LIMAO)
gravar("apple-touch-icon.png", 180, MARINHO, AZUL, LIMAO)
# Ícone pequeno da barra de notificações do Android: só a silhueta, em branco.
gravar("icone-notificacao.png", 96, VAZIO, BRANCO, None)
