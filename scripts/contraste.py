"""Confere o contraste (WCAG) das cores do painel nos dois temas.

Uso: python scripts/contraste.py
Lê os tokens do bloco :root e do tema claro em painel/src/estilo.css e confere
cada par texto/fundo que aparece nas telas. Mínimo: 4.5:1 (AA, texto normal).
"""
import re
import sys
from pathlib import Path

CSS = (Path(__file__).resolve().parent.parent / "painel" / "src" / "estilo.css").read_text(encoding="utf-8")


def tokens(bloco: str) -> dict:
    return {nome: valor.strip() for nome, valor in re.findall(r"--([\w-]+):\s*(#[0-9A-Fa-f]{6})", bloco)}


def bloco(seletor: str) -> str:
    inicio = CSS.index(seletor)
    return CSS[inicio:CSS.index("}", inicio)]


ESCURO = tokens(bloco(":root {"))
CLARO = {**ESCURO, **tokens(bloco(':root[data-tema="claro"] {'))}


def luminancia(cor: str) -> float:
    canais = [int(cor[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    lin = [c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in canais]
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]


def contraste(a: str, b: str) -> float:
    la, lb = sorted([luminancia(a), luminancia(b)], reverse=True)
    return (la + 0.05) / (lb + 0.05)


# (texto, fundos onde ele aparece)
PARES = [
    ("texto", ["fundo", "painel", "painel-2", "campo-fundo"]),
    ("texto-2", ["fundo", "painel", "painel-2", "campo-fundo"]),
    ("texto-3", ["fundo", "painel", "painel-2"]),
    ("texto-forte", ["fundo", "painel"]),
    ("titulo", ["fundo", "painel"]),
    ("link", ["fundo", "painel", "painel-2"]),
    ("limao-texto", ["fundo", "painel", "painel-2", "pronto-solido"]),
    ("atencao", ["fundo", "painel", "atencao-solido"]),
    ("critico", ["fundo", "painel", "critico-solido"]),
    ("selecao-texto", ["selecao-fundo"]),
    ("limao-tinta", ["limao"]),
    ("texto", ["bolha-ia", "bolha-corretor"]),
]

falhas = 0
for nome_tema, t in (("escuro", ESCURO), ("claro", CLARO)):
    print(f"\nTema {nome_tema}")
    for texto, fundos in PARES:
        for fundo in fundos:
            if texto not in t or fundo not in t:
                print(f"  ?  {texto} sobre {fundo}: token faltando")
                falhas += 1
                continue
            razao = contraste(t[texto], t[fundo])
            ok = razao >= 4.5
            falhas += not ok
            print(f"  {'ok ' if ok else 'RUIM'} {razao:5.2f}  {texto} ({t[texto]}) sobre {fundo} ({t[fundo]})")

print(f"\n{'Tudo passa no AA.' if not falhas else f'{falhas} par(es) abaixo de 4.5:1.'}")
sys.exit(1 if falhas else 0)
