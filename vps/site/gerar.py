#!/usr/bin/env python3
"""Gera o site da imobiliária em páginas estáticas e publica na pasta de saída.

Lê tudo de public.site_dados (estoque ativo + textos do painel) e só refaz as
páginas quando algo mudou. Se o banco falhar ou vier sem imóveis, o site que está
no ar continua como está.

Uso: python gerar.py --saida /var/www/lfg-site [--forcar]
"""
import argparse
import hashlib
import html
import json
import re
import shutil
import sys
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

SUPABASE_URL = "https://nlbonjxmzmwsyuirxnzu.supabase.co"
# Chave pública do projeto (a mesma do painel). A função só devolve dados públicos.
CHAVE_PUBLICA = "sb_publishable_oKbJ2oePBC6Lc916feMfSQ_qlsizS69"
AQUI = Path(__file__).resolve().parent

# Aparência que o gestor escolhe na tela Site do painel. Sem escolha, fica a da LFG.
# A mesma conta está em painel/src/siteTema.js, que monta a prévia.
CORES_PADRAO = {"principal": "#003654", "secundaria": "#005d92", "destaque": "#94bf0b", "fundo": "#f5f8fa"}
COR_VALIDA = re.compile(r"^#[0-9a-fA-F]{6}$")
FONTES = {
    "moderna": (["Unbounded:wght@500;700", "Manrope:wght@400;500;600;700;800"], '"Unbounded"', '"Manrope"'),
    "classica": (["Playfair+Display:wght@500;700", "Manrope:wght@400;500;600;700;800"], '"Playfair Display", Georgia', '"Manrope"'),
    "simples": (["Manrope:wght@400;500;600;700;800"], '"Manrope"', '"Manrope"'),
}
BOTOES_PADRAO = {
    "topo": "WhatsApp", "busca": "Buscar imóveis", "interesse": "Quero saber mais",
    "sobre": "Conheça a imobiliária", "contato": "Conversar no WhatsApp",
}
SECOES_PADRAO = [
    {"id": "destaques", "visivel": True, "titulo": "Imóveis em destaque"},
    {"id": "empreendimentos", "visivel": True, "titulo": "Lançamentos e empreendimentos"},
    {"id": "numeros", "visivel": True},
    {"id": "bairros", "visivel": True, "titulo": "Bairros para começar"},
    {"id": "chamadas", "visivel": True},
    {"id": "sobre", "visivel": True, "titulo": ""},
    {"id": "equipe", "visivel": True, "titulo": "Nossa equipe"},
]

TIPOS = {
    "CASA": "Casa", "APARTAMENTO": "Apartamento", "TERRENO": "Terreno", "CHACARA": "Chácara", "SALAO": "Salão",
    "BARRACAO": "Barracão", "SALA": "Sala", "GALPAO": "Galpão", "PONTO": "Ponto comercial", "AREA": "Área", "COMERCIAL": "Comercial",
    "TWO STORY HOUSE": "Sobrado", "SOBRADO": "Sobrado",
}
COMODIDADES = {
    "Piscina": "Piscina", "Arealazer": "Área de lazer", "Varandagourmet": "Varanda gourmet", "Gourmet": "Espaço gourmet",
    "Portaria24horas": "Portaria 24 horas", "Quintal": "Quintal", "Varanda": "Varanda", "Arcondicionado": "Ar-condicionado",
    "Armariocozinha": "Armários na cozinha", "Lavanderia": "Lavanderia", "Suitemaster": "Suíte master", "Murado": "Murado",
    "Portaoeletronico": "Portão eletrônico", "Alarme": "Alarme", "Interforne": "Interfone", "Salafesta": "Salão de festas",
    "Porcelanato": "Porcelanato", "Copa": "Copa", "Banheiroauxiliar": "Banheiro auxiliar",
}
SEGMENTO_VALIDO = re.compile(r"^[\w.-]+$")
FINALIDADES = {
    "venda": {"caminho": "/comprar/", "titulo": "Imóveis para comprar", "acao": "comprar", "campo": "valor_venda"},
    "locacao": {"caminho": "/alugar/", "titulo": "Imóveis para alugar", "acao": "alugar", "campo": "valor_locacao"},
}


def e(texto):
    return html.escape(str(texto if texto is not None else ""), quote=True)


def chamar(funcao):
    pedido = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/rpc/{funcao}",
        data=b"{}",
        headers={"apikey": CHAVE_PUBLICA, "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(pedido, timeout=60) as resposta:
        return json.load(resposta)


def buscar_dados():
    return chamar("site_dados")


# --- Aparência ---------------------------------------------------------------

def cor(config, chave):
    valor = str((config.get("cores") or {}).get(chave) or "").strip()
    return valor.lower() if COR_VALIDA.match(valor) else CORES_PADRAO[chave]


def rgb(hexa):
    return tuple(int(hexa[i:i + 2], 16) for i in (1, 3, 5))


def misturar(hexa, outra, peso):
    """Cor `hexa` com `peso` (0 a 1) da `outra`."""
    return "#" + "".join(f"{round(a * (1 - peso) + b * peso):02x}" for a, b in zip(rgb(hexa), rgb(outra)))


def luminancia(hexa):
    def canal(valor):
        valor /= 255
        return valor / 12.92 if valor <= 0.03928 else ((valor + 0.055) / 1.055) ** 2.4
    r, g, b = (canal(c) for c in rgb(hexa))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contraste(uma, outra):
    clara, escura = sorted((luminancia(uma), luminancia(outra)), reverse=True)
    return (clara + 0.05) / (escura + 0.05)


def tinta_sobre(fundo):
    """Texto legível em cima da cor: um tom bem escuro dela mesma ou branco."""
    escura = misturar(fundo, "#000000", 0.8)
    return escura if contraste(fundo, escura) >= contraste(fundo, "#ffffff") else "#ffffff"


def escolha(config, grupo, chave, padrao):
    valor = (config.get(grupo) or {}).get(chave)
    return valor.strip() if isinstance(valor, str) and valor.strip() else padrao


def botao(config, chave):
    return escolha(config, "botoes", chave, BOTOES_PADRAO[chave])


def texto_extra(config, chave, padrao=""):
    return escolha(config, "textos", chave, padrao)


def abertura(config):
    dados = config.get("abertura") or {}
    try:
        escurecer = min(95, max(0, int(dados.get("escurecer", 92))))
    except (TypeError, ValueError):
        escurecer = 92
    return {
        "escurecer": escurecer,
        "centro": dados.get("alinhamento") == "centro",
        "busca": dados.get("mostrar_busca", True) is not False,
    }


def tema(config):
    principal, secundaria, destaque, fundo = (cor(config, c) for c in ("principal", "secundaria", "destaque", "fundo"))
    fontes, titulo, texto = FONTES.get(config.get("fonte"), FONTES["moderna"])
    r, g, b = rgb(principal)
    variaveis = {
        "--marinho": principal,
        "--marinho-fundo": misturar(principal, "#000000", 0.5),
        "--azul": secundaria,
        "--limao": destaque,
        "--limao-tinta": tinta_sobre(destaque),
        "--fundo": fundo,
        "--linha": f"rgba({r}, {g}, {b}, 0.13)",
        "--fonte-titulo": f'{titulo}, "Segoe UI", system-ui, sans-serif',
        "--fonte-texto": f'{texto}, "Segoe UI", system-ui, sans-serif',
    }
    return {
        "principal": principal,
        "css": ":root { " + " ".join(f"{k}: {v};" for k, v in variaveis.items()) + " }",
        "fontes": "https://fonts.googleapis.com/css2?" + "&".join(f"family={f}" for f in fontes) + "&display=swap",
        "icone": (
            "data:image/svg+xml," + urllib.parse.quote(
                "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>"
                f"<rect width='64' height='64' rx='14' fill='{principal}'/>"
                f"<path d='M14 34 32 18l18 16v14H14z' fill='{secundaria}'/>"
                f"<rect x='28' y='36' width='8' height='12' fill='{destaque}'/></svg>"
            )
        ),
    }


def fundo_da_abertura(config, imagem):
    """Escurece a foto para o título branco aparecer."""
    if not imagem:
        return ""
    forca = abertura(config)["escurecer"] / 100
    escura = rgb(misturar(cor(config, "principal"), "#000000", 0.5))
    principal = rgb(cor(config, "principal"))
    return (
        f' style="background-image: linear-gradient(100deg, rgba({escura[0]},{escura[1]},{escura[2]},{forca:.2f}) 20%, '
        f"rgba({principal[0]},{principal[1]},{principal[2]},{forca * 0.6:.2f})), url('{e(imagem)}')\""
    )


def reais(valor):
    return f"R$ {int(round(float(valor))):,}".replace(",", ".")


def numero(valor):
    try:
        return float(valor) if valor is not None and float(valor) > 0 else None
    except (TypeError, ValueError):
        return None


def nome_tipo(tipo):
    return TIPOS.get(tipo, (tipo or "Imóvel").capitalize())


def area(imovel):
    return numero(imovel.get("area_construida")) or numero(imovel.get("area_util")) or numero(imovel.get("area_terreno"))


def metros(valor):
    return f"{int(round(valor)):,}".replace(",", ".") + " m²"


# Ícones simples (traço) para os dados do imóvel.
ICONES = {
    "quartos": '<path d="M3 18v-6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6M3 18h18M5 10V6h14v4"/>',
    "suites": '<path d="M3 18v-6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6M3 18h18M5 10V6h14v4M15 6v4"/>',
    "banheiros": '<path d="M4 12h16v3a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4v-3zM6 12V6a2 2 0 0 1 4 0"/>',
    "vagas": '<path d="M5 17h14M6 17l1.5-6h9L18 17M8 17v2M16 17v2"/>',
    "area": '<path d="M4 4h16v16H4zM4 9h5M15 20v-5"/>',
    "terreno": '<path d="M3 20l6-10 4 6 3-4 5 8z"/>',
    "local": '<path d="M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12z"/><circle cx="12" cy="9" r="2.5"/>',
    "fotos": '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    "camera": '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
    "agenda": '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
    "zap": '<path d="M12 3a9 9 0 0 0-7.8 13.4L3 21l4.7-1.2A9 9 0 1 0 12 3z"/><path d="M9 9.5c0 3 2.5 5.5 5.5 5.5l1-1.5-2-1-1 .8a4 4 0 0 1-1.8-1.8l.8-1-1-2z"/>',
    "filtro": '<path d="M4 6h16M7 12h10M10 18h4"/>',
}


def icone(nome, classe="icone"):
    return f'<svg class="{classe}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{ICONES[nome]}</svg>'


PREPOSICAO_NA = {"vila", "chácara", "chacara", "cidade", "colônia", "colonia", "fazenda", "rua", "avenida", "estância", "estancia"}


def no_bairro(bairro):
    """"no Centro", "na Vila Glória": a preposição certa antes do bairro."""
    bairro = (bairro or "").strip()
    if not bairro:
        return ""
    return f"{'na' if bairro.split()[0].lower() in PREPOSICAO_NA else 'no'} {bairro}"


def miolo_do_titulo(imovel):
    """"Casa com 3 suítes", "Terreno de 360 m²": o que é o imóvel, sem o bairro."""
    tipo = nome_tipo(imovel.get("tipo"))
    quartos = int(imovel.get("dormitorios") or 0)
    suites = int(imovel.get("suites") or 0)
    if imovel.get("tipo") in ("TERRENO", "AREA", "CHACARA"):
        tamanho = numero(imovel.get("area_terreno")) or area(imovel)
        return f"{tipo} de {metros(tamanho)}" if tamanho else tipo
    if quartos:
        if suites and suites >= quartos:
            return f"{tipo} com {suites} suíte{'s' if suites != 1 else ''}"
        return f"{tipo} com {quartos} quarto{'s' if quartos != 1 else ''}"
    if area(imovel):
        return f"{tipo} de {metros(area(imovel))}"
    return tipo


def titulo_do_imovel(imovel):
    """Título curto e claro, montado dos dados (o título do Univen é longo e varia muito).
    Ex.: "Casa com 3 suítes no Alphaville", "Terreno de 360 m² no Jardim Noroeste"."""
    return f"{miolo_do_titulo(imovel)} {no_bairro(imovel.get('bairro'))}".strip()


def caminho_do_imovel(imovel):
    """Mesmo endereço do site atual, para os links antigos continuarem valendo."""
    caminho = urllib.parse.urlparse(imovel.get("link_site") or "").path
    partes = [p for p in urllib.parse.unquote(caminho).split("/") if p]
    if len(partes) >= 2 and all(SEGMENTO_VALIDO.match(p) and p not in (".", "..") for p in partes):
        return "/" + "/".join(partes) + "/"
    return f"/imovel/{re.sub(r'[^A-Za-z0-9-]', '', str(imovel.get('referencia') or imovel['codigo']))}/"


def href(caminho):
    return urllib.parse.quote(caminho)


def so_https(endereco):
    return endereco if isinstance(endereco, str) and endereco.startswith("https://") else ""


def link_whatsapp(config, texto):
    numero_oficial = re.sub(r"\D", "", config.get("whatsapp") or "")
    return f"https://wa.me/{numero_oficial}?text={urllib.parse.quote(texto)}"


def preco_do_imovel(imovel, finalidade=None):
    if finalidade == "locacao" or (finalidade is None and not imovel.get("venda")):
        valor = numero(imovel.get("valor_locacao"))
        return f"{reais(valor)}/mês" if valor else "Consulte"
    valor = numero(imovel.get("valor_venda"))
    return reais(valor) if valor else "Consulte"


def resumo_do_imovel(imovel):
    partes = []
    if imovel.get("dormitorios"):
        partes.append(f"{imovel['dormitorios']} quarto{'s' if imovel['dormitorios'] != 1 else ''}")
    if imovel.get("vagas"):
        partes.append(f"{imovel['vagas']} vaga{'s' if imovel['vagas'] != 1 else ''}")
    if area(imovel):
        partes.append(metros(area(imovel)))
    return partes


def descricao_curta(imovel):
    texto = re.sub(r"\s+", " ", imovel.get("descricao") or "").strip()
    if len(texto) > 155:
        texto = texto[:154].rsplit(" ", 1)[0] + "…"
    return texto or f"{nome_tipo(imovel.get('tipo'))} em {imovel.get('bairro')}, {imovel.get('cidade')}."


# Configurações gerais da empresa (nome, logo, marca d'água, rodapé); preenchida em gerar().
EMPRESA = {}
# Corretores e gestores ativos (nome, papel, CRECI e foto); preenchida em gerar().
EQUIPE = []
# Empreendimentos e banners ativos, cadastrados no painel; preenchidas em gerar().
EMPREENDIMENTOS = []
BANNERS = []


def iniciais(nome):
    partes = [p for p in re.split(r"\s+", (nome or "").strip()) if p]
    return "".join(p[0] for p in (partes[:1] + partes[1:][-1:])).upper() or "?"


def retrato(pessoa, classe):
    """Foto redonda da pessoa; sem foto, as iniciais no lugar."""
    foto = so_https(pessoa.get("foto_url"))
    if foto:
        return f'<img class="{classe}" src="{e(foto)}" alt="" loading="lazy" decoding="async">'
    return f'<span class="{classe} sem-retrato" aria-hidden="true">{e(iniciais(pessoa.get("nome")))}</span>'


def cartao_da_equipe(pessoa):
    """Só nome e CRECI no site; o cargo fica no sistema."""
    creci = (pessoa.get("creci") or "").strip()
    linha = f"CRECI {creci}" if creci and not creci.upper().startswith("CRECI") else creci
    return f"""<li class="pessoa">{retrato(pessoa, 'pessoa-foto')}<b>{e(pessoa.get('nome'))}</b>{f'<span>{e(linha)}</span>' if linha else ''}</li>"""


# Até 4 pessoas ficam paradas; com mais, a fileira vira carrossel (site.js).
MAXIMO_SEM_CARROSSEL = 4


def secao_equipe(titulo):
    cartoes = "".join(cartao_da_equipe(p) for p in EQUIPE)
    if len(EQUIPE) <= MAXIMO_SEM_CARROSSEL:
        corpo = f'<ul class="grade-equipe">{cartoes}</ul>'
    else:
        corpo = f"""<div class="carrossel" data-carrossel>
    <div class="carrossel-janela"><ul class="carrossel-trilho" aria-label="{e(titulo)}">{cartoes}</ul></div>
    <button class="seta anterior" type="button" aria-label="Pessoas anteriores" data-carrossel-seta="-1" hidden>‹</button>
    <button class="seta proxima" type="button" aria-label="Próximas pessoas" data-carrossel-seta="1" hidden>›</button>
  </div>"""
    return f"""<section class="largura secao equipe">
  <h2>{e(titulo)}</h2>
  {corpo}
</section>"""
POSICOES_DA_MARCA = {"centro", "superior_esquerdo", "superior_direito", "inferior_esquerdo", "inferior_direito"}


def marca_dagua(imovel):
    """Marca d'água por cima da foto, só nos imóveis cadastrados no sistema
    (as fotos do Univen já chegam com a marca de lá)."""
    marca = EMPRESA.get("marca") or {}
    if imovel.get("origem") != "proprio" or marca.get("ativa") is False:
        return ""
    imagem = so_https(marca.get("imagem_url")) or so_https(EMPRESA.get("logo_url")) or "/logo-lfg.png"
    posicao = marca.get("posicao") if marca.get("posicao") in POSICOES_DA_MARCA else "centro"
    tamanho = min(80, max(10, int(numero(marca.get("tamanho")) or 42)))
    opacidade = min(100, max(10, int(numero(marca.get("opacidade")) or 55))) / 100
    return f'<img class="marca-dagua m-{posicao}" src="{e(imagem)}" alt="" aria-hidden="true" style="width:{tamanho}%;opacity:{opacidade}">'


def com_rodape(imovel):
    """Descrição do imóvel + rodapé das Configurações gerais, com o código e o captador."""
    rodape = (EMPRESA.get("rodape_descricao") or "").strip()
    if not rodape:
        return imovel.get("descricao")
    trocas = {
        "codigo": imovel.get("referencia") or "", "código": imovel.get("referencia") or "",
        "codigo_de_referencia": imovel.get("referencia") or "", "código_de_referência": imovel.get("referencia") or "",
        "captador": (imovel.get("captador") or EMPRESA.get("nome") or "").strip(),
    }
    rodape = re.sub(r"\[\[\s*([^\]]+?)\s*\]\]", lambda m: trocas.get(m.group(1).lower(), m.group(0)), rodape)
    return f"{(imovel.get('descricao') or '').rstrip()}\n\n{rodape}"


def paragrafos(texto):
    return "".join(f"<p>{e(p).replace(chr(10), '<br>')}</p>" for p in re.split(r"\n\s*\n", (texto or "").strip()) if p.strip())


def pagina(config, versao, titulo, descricao, corpo, imagem=None, barra_movel="", caminho="/", tipo_og="website", capa=False):
    nome = config.get("nome") or "Imobiliária"
    logo_propria = so_https(config.get("logo_url"))
    # Na página inicial o topo fica por cima da foto: usa a logo branca da LFG.
    capa = capa and not logo_propria
    logo = logo_propria or (f"/logo-lfg-branca.png?v={versao}" if capa else f"/logo-lfg.png?v={versao}")
    itens_do_menu = [("/comprar/", "Comprar"), ("/alugar/", "Alugar")]
    if EMPREENDIMENTOS:
        itens_do_menu.append(("/empreendimentos/", "Empreendimentos"))
    itens_do_menu += [("/sobre/", "Sobre"), ("/contato/", "Contato")]
    atual = href(caminho)
    links_do_menu = "\n      ".join(
        f'<a href="{c}"{" aria-current=" + chr(34) + "page" + chr(34) if atual.startswith(c) else ""}>{r}</a>' for c, r in itens_do_menu
    )
    base = (config.get("endereco_site") or "").rstrip("/")
    telefones = "".join(f'<li><a href="tel:+55{re.sub(chr(92) + "D", "", t)}">{e(t)}</a></li>' for t in config.get("telefones") or [])
    redes = "".join(
        f'<li><a href="{e(so_https(config.get(rede)))}" rel="noopener" target="_blank">{rotulo}</a></li>'
        for rede, rotulo in (("instagram", "Instagram"), ("facebook", "Facebook")) if so_https(config.get(rede))
    )
    email = f'<li><a href="mailto:{e(config["email"])}">{e(config["email"])}</a></li>' if config.get("email") else ""
    conversa = link_whatsapp(config, f"Olá! Vim pelo site da {nome}.")
    aparencia = tema(config)
    rodape = texto_extra(config, "rodape")
    return f"""<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{e(titulo)}</title>
<meta name="description" content="{e(descricao)}">
<meta name="theme-color" content="{aparencia['principal']}">
{'' if config.get('indexar') else '<meta name="robots" content="noindex, nofollow">'}
{f'<link rel="canonical" href="{e(base + href(caminho))}">' if base else ''}
<meta property="og:title" content="{e(titulo)}">
<meta property="og:description" content="{e(descricao)}">
<meta property="og:type" content="{e(tipo_og)}">
<meta property="og:site_name" content="{e(nome)}">
<meta property="og:locale" content="pt_BR">
{f'<meta property="og:url" content="{e(base + href(caminho))}">' if base else ''}
{f'<meta property="og:image" content="{e(imagem)}">' if imagem else ''}
{f'<meta name="twitter:card" content="summary_large_image">' if imagem else ''}
<link rel="icon" href="{e(aparencia['icone'])}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="{e(aparencia['fontes'])}">
<link rel="stylesheet" href="/estilo.css?v={versao}">
<style>{aparencia['css']}</style>
</head>
<body>
<a class="pular" href="#conteudo">Pular para o conteúdo</a>
<header class="topo{' sobre-capa' if capa else ''}" data-topo>
  <div class="largura topo-linha">
    <a class="marca" href="/"><img src="{e(logo)}" alt="{e(nome)}" height="40"{'' if logo_propria else f' data-logo-branca="/logo-lfg-branca.png?v={versao}"'}></a>
    <nav class="menu-principal" id="menu-principal" aria-label="Principal">
      {links_do_menu}
      <a class="botao zap menu-zap" href="{e(conversa)}" rel="noopener" target="_blank">{icone('zap')}Falar no WhatsApp</a>
    </nav>
    <a class="botao topo-botao" href="{e(conversa)}" rel="noopener" target="_blank">{e(botao(config, 'topo'))}</a>
    <button class="menu-botao" type="button" aria-expanded="false" aria-controls="menu-principal" data-menu><span class="menu-risco" aria-hidden="true"></span><span class="invisivel">Abrir o menu</span></button>
  </div>
</header>
<main id="conteudo">
{corpo}
</main>
<footer class="rodape">
  <div class="largura rodape-grade">
    <div>
      <b class="rodape-nome">{e(nome)}</b>
      <p>{e(config.get('creci'))}</p>
      {f'<p class="rodape-texto">{e(rodape)}</p>' if rodape else ''}
    </div>
    <div>
      <b>Escritório</b>
      <p>{e(config.get('endereco'))}</p>
      <p>{e(config.get('horario'))}</p>
    </div>
    <div>
      <b>Fale com a gente</b>
      <ul>
        <li><a href="{e(conversa)}" rel="noopener" target="_blank">WhatsApp</a></li>
        {telefones}{email}{redes}
      </ul>
    </div>
  </div>
</footer>
{barra_movel}
<script src="/site.js?v={versao}" defer></script>
</body>
</html>
"""


def dados_do_cartao(imovel):
    """Quartos, vagas e área com ícone, numa linha só."""
    itens = []
    if imovel.get("dormitorios"):
        n = imovel["dormitorios"]
        itens.append(("quartos", f"{n} quarto{'s' if n != 1 else ''}"))
    if imovel.get("vagas"):
        n = imovel["vagas"]
        itens.append(("vagas", f"{n} vaga{'s' if n != 1 else ''}"))
    if area(imovel):
        itens.append(("area", metros(area(imovel))))
    return "".join(f"<span>{icone(i)}{e(t)}</span>" for i, t in itens)


def cartao(imovel, finalidade=None, ordem=0):
    foto = so_https(imovel.get("foto_mini")) or so_https(imovel.get("foto_principal"))
    imagem = (
        f'<img src="{e(foto)}" alt="{e(nome_tipo(imovel.get("tipo")))} em {e(imovel.get("bairro"))}" loading="lazy" decoding="async">'
        if foto else '<span class="sem-foto">Sem foto</span>'
    )
    total_fotos = len(imovel.get("fotos") or [])
    qtd = f'<span class="cartao-qtd">{icone("camera")}{total_fotos}</span>' if total_fotos > 1 else ""
    valor = numero(imovel.get("valor_locacao" if finalidade == "locacao" else "valor_venda")) or 0
    return f"""<a class="cartao" href="{e(href(caminho_do_imovel(imovel)))}" data-tipo="{e(imovel.get('tipo'))}" data-bairro="{e(imovel.get('bairro'))}" data-valor="{int(valor)}" data-quartos="{imovel.get('dormitorios') or 0}" data-ordem="{ordem}">
  <span class="cartao-foto">{imagem}{marca_dagua(imovel) if foto else ''}{qtd}</span>
  <span class="cartao-corpo">
    <span class="cartao-bairro">{e(imovel.get('bairro'))}</span>
    <span class="cartao-titulo">{e(miolo_do_titulo(imovel))}</span>
    <b class="cartao-preco">{e(preco_do_imovel(imovel, finalidade))}</b>
    <span class="cartao-dados">{dados_do_cartao(imovel)}</span>
    <span class="cartao-ref">{e(imovel.get('referencia'))}</span>
  </span>
</a>"""


def opcoes(valores, rotulo=lambda v: v):
    return "".join(f'<option value="{e(v)}">{e(rotulo(v))}</option>' for v in valores)


def quantidade_de_destaques(config):
    try:
        return min(12, max(3, int(config.get("quantidade_destaques") or 6)))
    except (TypeError, ValueError):
        return 6


def escolher_destaques(config, imoveis):
    limite = quantidade_de_destaques(config)
    pedidos = [str(r).strip().upper() for r in config.get("destaques") or [] if str(r).strip()]
    por_referencia = {str(i.get("referencia")).upper(): i for i in imoveis}
    escolhidos = [por_referencia[r] for r in pedidos if r in por_referencia]
    usados = {i["codigo"] for i in escolhidos}
    # O que o gestor não escolheu é completado com os mais recentes com boas fotos.
    for imovel in imoveis:
        if len(escolhidos) >= limite:
            break
        if imovel["codigo"] not in usados and len(imovel.get("fotos") or []) >= 5 and numero(imovel.get("valor_venda") or imovel.get("valor_locacao")):
            escolhidos.append(imovel)
            usados.add(imovel["codigo"])
    return escolhidos[:limite]


def secoes_da_inicial(config):
    """Seções da página inicial na ordem escolhida; as que faltarem entram no fim."""
    conhecidas = {s["id"]: s for s in SECOES_PADRAO}
    escolhidas = [
        {**conhecidas[s["id"]], **s} for s in config.get("secoes") or []
        if isinstance(s, dict) and s.get("id") in conhecidas
    ]
    vistas = {s["id"] for s in escolhidas}
    if escolhidas and "empreendimentos" not in vistas:
        depois = next((n + 1 for n, s in enumerate(escolhidas) if s["id"] == "destaques"), 0)
        escolhidas.insert(depois, dict(conhecidas["empreendimentos"]))
        vistas.add("empreendimentos")
    if escolhidas:
        # Seções novas que o painel ainda não lista entram perto de onde fazem sentido.
        for nova, vizinha, depois in (("bairros", "numeros", True), ("chamadas", "sobre", False)):
            if nova in vistas:
                continue
            posicao = next((n + (1 if depois else 0) for n, s in enumerate(escolhidas) if s["id"] == vizinha), len(escolhidas))
            escolhidas.insert(posicao, dict(conhecidas[nova]))
            vistas.add(nova)
    return [s for s in escolhidas + [s for s in SECOES_PADRAO if s["id"] not in vistas] if s.get("visivel", True)]


PLURAL_DO_TIPO = {"CASA": "Casas", "APARTAMENTO": "Apartamentos", "TERRENO": "Terrenos", "CHACARA": "Chácaras", "COMERCIAL": "Imóveis comerciais", "SOBRADO": "Sobrados"}
VALORES_DA_BUSCA = {
    "venda": [300000, 500000, 800000, 1000000, 1500000, 2000000, 3000000],
    "locacao": [1000, 1500, 2000, 2500, 3500, 5000, 8000],
}


def valor_curto(valor):
    """R$ 500 mil, R$ 1,5 milhão, R$ 2.500."""
    if valor >= 1000000:
        milhoes = valor / 1000000
        texto = f"{milhoes:.1f}".rstrip("0").rstrip(".").replace(".", ",")
        return f"R$ {texto} {'milhão' if milhoes < 2 else 'milhões'}"
    if valor >= 100000:
        return f"R$ {valor // 1000} mil"
    return reais(valor)


def opcoes_de_valor(finalidade):
    return '<option value="">Qualquer valor</option>' + "".join(
        f'<option value="{v}">{e(valor_curto(v))}</option>' for v in VALORES_DA_BUSCA[finalidade]
    )


def busca_da_inicial(config, imoveis):
    tipos = sorted({i["tipo"] for i in imoveis if i.get("tipo")}, key=nome_tipo)
    bairros = sorted({i["bairro"] for i in imoveis if i.get("bairro")})
    contagem = {}
    for i in imoveis:
        if i.get("venda") and i.get("tipo") in PLURAL_DO_TIPO:
            contagem[i["tipo"]] = contagem.get(i["tipo"], 0) + 1
    atalhos = [
        f'<a class="procura-atalho" href="/comprar/?tipo={e(urllib.parse.quote(t))}">{e(PLURAL_DO_TIPO[t])}</a>'
        for t, _ in sorted(contagem.items(), key=lambda x: -x[1])[:3]
    ]
    if any(i.get("venda") and (i.get("dormitorios") or 0) >= 3 for i in imoveis):
        atalhos.append('<a class="procura-atalho" href="/comprar/?quartos=3">3 quartos ou mais</a>')
    if any(i.get("locacao") and 0 < (numero(i.get("valor_locacao")) or 0) <= 2500 for i in imoveis):
        atalhos.append('<a class="procura-atalho" href="/alugar/?valor=2500">Aluguel até R$ 2.500</a>')
    lancamentos = '<a class="procura-aba" href="/empreendimentos/">Lançamentos</a>' if EMPREENDIMENTOS else ""
    valores = html.escape(json.dumps({"venda": opcoes_de_valor("venda"), "locacao": opcoes_de_valor("locacao")}, ensure_ascii=False), quote=True)
    return f"""<form class="procura" action="/comprar/" method="get" data-busca data-valores="{valores}">
      <fieldset class="procura-abas">
        <legend class="invisivel">O que você procura</legend>
        <label><input type="radio" name="finalidade" value="/comprar/" data-tipo-valor="venda" checked><span class="procura-aba">Comprar</span></label>
        <label><input type="radio" name="finalidade" value="/alugar/" data-tipo-valor="locacao"><span class="procura-aba">Alugar</span></label>
        {lancamentos}
      </fieldset>
      <div class="procura-campos">
        <label class="procura-campo"><span>Bairro</span><select name="bairro"><option value="">Todos os bairros</option>{opcoes(bairros)}</select></label>
        <label class="procura-campo"><span>Tipo</span><select name="tipo"><option value="">Todos os tipos</option>{opcoes(tipos, nome_tipo)}</select></label>
        <label class="procura-campo"><span>Até</span><select name="valor">{opcoes_de_valor("venda")}</select></label>
        <button class="botao procura-botao" type="submit">{e(botao(config, 'busca'))}</button>
      </div>
      {f'<div class="procura-atalhos" aria-label="Buscas rápidas">{"".join(atalhos)}</div>' if atalhos else ''}
    </form>"""


def selo_da_capa(config):
    partes = ["Campo Grande (MS)"]
    if config.get("creci"):
        partes.append(str(config["creci"]))
    return " · ".join(partes)


def capa_da_inicial(config, fundo, chamada):
    opcoes_abertura = abertura(config)
    forca = opcoes_abertura["escurecer"] / 100
    r, g, b = rgb(misturar(cor(config, "principal"), "#000000", 0.5))
    foto = f'<img class="capa-foto" src="{e(fundo)}" alt="" fetchpriority="high" decoding="async">' if fundo else ""
    return f"""<section class="capa{' centro' if opcoes_abertura['centro'] else ''}" style="--capa-cor: {r}, {g}, {b}; --capa-forca: {forca:.2f}">
  {foto}
  <div class="largura capa-miolo">
    <p class="capa-selo">{e(selo_da_capa(config))}</p>
    <h1 data-revelar>{e(config.get('titulo'))}</h1>
    {f'<p class="capa-sub">{e(config.get("subtitulo"))}</p>' if config.get('subtitulo') else ''}
    {chamada}
  </div>
</section>"""


def bairros_em_destaque(imoveis, limite=4):
    grupos = {}
    for i in imoveis:
        if i.get("bairro"):
            grupos.setdefault(i["bairro"], []).append(i)
    escolhidos = []
    for bairro, lista in sorted(grupos.items(), key=lambda x: (-len(x[1]), x[0])):
        # Casas com muitas fotos costumam ter a fachada de verdade na capa; apartamento
        # de lançamento às vezes abre com a arte do empreendimento.
        ordem_do_tipo = {"CASA": 0, "SOBRADO": 0, "TWO STORY HOUSE": 0, "APARTAMENTO": 1}
        com_foto = sorted(
            (i for i in lista if so_https(i.get("foto_principal"))),
            key=lambda i: (ordem_do_tipo.get(i.get("tipo"), 2), -len(i.get("fotos") or [])),
        )
        if len(lista) < 3 or not com_foto:
            continue
        venda = sum(1 for i in lista if i.get("venda"))
        escolhidos.append({
            "bairro": bairro,
            "total": len(lista),
            "foto": so_https(com_foto[0].get("foto_mini")) or so_https(com_foto[0].get("foto_principal")),
            "imovel": com_foto[0],
            "caminho": "/comprar/" if venda * 2 >= len(lista) else "/alugar/",
        })
        if len(escolhidos) >= limite:
            break
    return escolhidos


def secao_bairros(titulo, imoveis):
    bairros = bairros_em_destaque(imoveis)
    if len(bairros) < 3:
        return ""
    itens = "".join(
        f"""<a class="bairro-item" href="{b['caminho']}?bairro={e(urllib.parse.quote(b['bairro']))}">
      <img src="{e(b['foto'])}" alt="" loading="lazy" decoding="async">{marca_dagua(b['imovel'])}
      <span class="bairro-texto"><b>{e(b['bairro'])}</b><small>{b['total']} imóve{'is' if b['total'] != 1 else 'l'}</small></span>
    </a>"""
        for b in bairros
    )
    return f"""<section class="largura secao sobe">
  <div class="secao-cabeca">
    <div><h2>{e(titulo)}</h2><p class="secao-sub">Os bairros com mais opções hoje. Toque para ver o que está disponível.</p></div>
    <a href="/comprar/">Ver todos</a>
  </div>
  <div class="bairros-sanfona">{itens}</div>
</section>"""


def faixa_de_numeros(imoveis):
    venda = sum(1 for i in imoveis if i.get("venda"))
    locacao = sum(1 for i in imoveis if i.get("locacao"))
    bairros = len({i["bairro"] for i in imoveis if i.get("bairro")})
    itens = [
        ("/comprar/", venda, "imóveis para comprar"),
        ("/alugar/", locacao, "imóveis para alugar"),
    ]
    if EMPREENDIMENTOS:
        n = len(EMPREENDIMENTOS)
        itens.append(("/empreendimentos/", n, "lançamento" if n == 1 else "lançamentos"))
    itens.append((None, bairros, "bairros com imóveis"))
    html_itens = "".join(
        (f'<a class="numero-item" href="{c}">' if c else '<div class="numero-item">')
        + f'<b data-contar="{n}">{n}</b><small>{e(t)}</small>'
        + ("</a>" if c else "</div>")
        for c, n, t in itens
    )
    return f"""<section class="faixa-numeros"><div class="largura numeros-grade">{html_itens}</div></section>"""


def faixa_do_lancamento(emp):
    fotos = fotos_do_empreendimento(emp)
    tipo = TIPOS_DE_EMPREENDIMENTO.get(emp.get("tipo"), "Empreendimento")
    linha = " · ".join(x for x in [tipo, emp.get("bairro"), preco_do_empreendimento(emp)] if x)
    status = emp.get("status") if emp.get("status") in STATUS_DO_EMPREENDIMENTO else "lancamento"
    return f"""<a class="faixa-lancamento sobe" href="{e(href(caminho_do_empreendimento(emp)))}">
    {f'<img src="{e(fotos[0])}" alt="" loading="lazy" decoding="async">' if fotos else ''}
    <span class="faixa-lancamento-texto">
      <span class="capa-selo">{e(STATUS_DO_EMPREENDIMENTO[status])}</span>
      <b>{e(emp['nome'])}</b>
      {f'<span>{e(linha)}</span>' if linha else ''}
      <span class="botao">Conhecer o empreendimento</span>
    </span>
  </a>"""


def secao_chamadas(config):
    anunciar = link_whatsapp(config, f"Olá! Quero vender ou alugar meu imóvel com a {config.get('nome') or 'imobiliária'}.")
    procurar = link_whatsapp(config, "Olá! Não achei no site o imóvel que procuro. Posso contar o que preciso?")
    return f"""<section class="largura secao chamadas">
  <div class="chamada-bloco claro sobe">
    <h2>Quer vender ou alugar o seu imóvel?</h2>
    <p>Conte para a gente como ele é. A equipe avalia, anuncia e acompanha as visitas com você.</p>
    <a class="botao" href="{e(anunciar)}" rel="noopener" target="_blank">Anunciar meu imóvel</a>
  </div>
  <div class="chamada-bloco escuro sobe">
    <h2>Não achou o que procura?</h2>
    <p>Diga o que você precisa e um corretor procura por você e avisa pelo WhatsApp.</p>
    <a class="botao zap" href="{e(procurar)}" rel="noopener" target="_blank">{icone('zap')}Falar com um corretor</a>
  </div>
</section>"""


def pagina_inicial(config, imoveis, versao):
    destaques = escolher_destaques(config, imoveis)
    fundo = so_https(config.get("banner_url")) or next((so_https(i.get("foto_principal")) for i in destaques if i.get("foto_principal")), "")
    opcoes_abertura = abertura(config)
    if opcoes_abertura["busca"]:
        chamada = busca_da_inicial(config, imoveis)
    else:
        chamada = """<p class="abertura-botoes"><a class="botao" href="/comprar/">Imóveis para comprar</a> <a class="botao claro" href="/alugar/">Imóveis para alugar</a></p>"""
    capa = not BANNERS
    if BANNERS:
        # Com banners ligados, o carrossel abre a página; a busca fica logo abaixo.
        fundo = BANNERS[0]["imagem_url"]
        partes = [carrossel_de_banners(config)]
        if opcoes_abertura["busca"]:
            partes.append(f"""<section class="faixa-busca"><div class="largura"><h1 class="invisivel">{e(config.get('titulo'))}</h1>{chamada}</div></section>""")
        else:
            partes.append(f"""<h1 class="invisivel">{e(config.get('titulo'))}</h1>""")
    else:
        partes = [capa_da_inicial(config, fundo, chamada)]
    total_venda = sum(1 for i in imoveis if i.get("venda"))
    for secao in secoes_da_inicial(config):
        if secao["id"] == "destaques" and destaques:
            partes.append(f"""<section class="largura secao">
  <div class="secao-cabeca sobe">
    <div><h2>{e(secao.get('titulo') or 'Imóveis em destaque')}</h2><p class="secao-sub">Escolhidos pela equipe, com fotos e dados conferidos.</p></div>
    <a href="/comprar/">Ver os {total_venda} imóveis</a>
  </div>
  <div class="grade-imoveis destaques">{''.join(cartao(i).replace('class="cartao"', 'class="cartao sobe"', 1) for i in destaques)}</div>
</section>""")
        elif secao["id"] == "empreendimentos" and EMPREENDIMENTOS:
            outros = EMPREENDIMENTOS[1:4]
            partes.append(f"""<section class="largura secao">
  <div class="secao-cabeca sobe">
    <h2>{e(secao.get('titulo') or 'Lançamentos e empreendimentos')}</h2>
    <a href="/empreendimentos/">Ver todos</a>
  </div>
  {faixa_do_lancamento(EMPREENDIMENTOS[0])}
  {f'<div class="grade-imoveis destaques lancamentos-mais">{"".join(cartao_do_empreendimento(m) for m in outros)}</div>' if outros else ''}
</section>""")
        elif secao["id"] == "numeros":
            partes.append(faixa_de_numeros(imoveis))
        elif secao["id"] == "bairros":
            partes.append(secao_bairros(secao.get("titulo") or "Bairros para começar", imoveis))
        elif secao["id"] == "chamadas":
            partes.append(secao_chamadas(config))
        elif secao["id"] == "equipe" and EQUIPE:
            partes.append(secao_equipe(secao.get("titulo") or "Nossa equipe"))
        elif secao["id"] == "sobre":
            partes.append(f"""<section class="faixa-marca">
  <div class="largura faixa-grade">
    <div>
      <h2>{e(secao.get('titulo') or 'Sobre a ' + str(config.get('nome') or ''))}</h2>
      {paragrafos((config.get('sobre') or '').split(chr(10) + chr(10))[0])}
      <a class="botao secundario" href="/sobre/">{e(botao(config, 'sobre'))}</a>
    </div>
    <ul class="servicos">{''.join(f'<li>{e(s)}</li>' for s in config.get('servicos') or [])}</ul>
  </div>
</section>""")
    descricao = texto_extra(config, "descricao_google", config.get("subtitulo") or "")
    return pagina(config, versao, f"{config.get('nome')} | Imóveis em Campo Grande (MS)", descricao, "\n".join(partes), imagem=fundo, capa=capa)


def pagina_lista(config, imoveis, finalidade, versao):
    dados = FINALIDADES[finalidade]
    # A ordem do banco é a dos mais recentes; ela vira data-ordem para "Mais recentes".
    daqui = [i for i in imoveis if i.get(finalidade)]
    tipos = sorted({i["tipo"] for i in daqui if i.get("tipo")}, key=nome_tipo)
    bairros = sorted({i["bairro"] for i in daqui if i.get("bairro")})
    corpo = f"""<section class="largura secao lista" data-lista>
  <h1>{e(dados['titulo'])}</h1>
  <button class="botao secundario abrir-filtros" type="button" data-abrir-filtros aria-expanded="false" aria-controls="filtros-lista" hidden>{icone('filtro')}Filtros<span class="quantos-filtros" data-quantos-filtros></span></button>
  <form class="filtros" id="filtros-lista" data-filtros>
    <label>Tipo<select name="tipo"><option value="">Todos</option>{opcoes(tipos, nome_tipo)}</select></label>
    <label>Bairro<select name="bairro"><option value="">Todos</option>{opcoes(bairros)}</select></label>
    <label>Valor até<input name="valor" inputmode="numeric" placeholder="{'3000' if finalidade == 'locacao' else '500000'}"></label>
    <label>Quartos<select name="quartos"><option value="">Qualquer</option><option value="1">1 ou mais</option><option value="2">2 ou mais</option><option value="3">3 ou mais</option><option value="4">4 ou mais</option></select></label>
  </form>
  <div class="lista-barra">
    <p class="contagem" role="status" data-contagem>{len(daqui)} imóveis</p>
    <label class="ordenar">Ordenar por <select data-ordenar><option value="recentes">Mais recentes</option><option value="menor">Menor valor</option><option value="maior">Maior valor</option></select></label>
  </div>
  <div class="grade-imoveis" data-grade>{''.join(cartao(i, finalidade, n) for n, i in enumerate(daqui))}</div>
  <p class="vazio" data-vazio hidden>Nenhum imóvel com esses filtros agora. Tente mudar o bairro ou o valor, ou <a href="{e(link_whatsapp(config, 'Olá! Não achei no site o imóvel que procuro. Pode me ajudar?'))}" rel="noopener" target="_blank">fale com a gente</a>.</p>
  <button class="botao secundario mais" type="button" data-mais hidden>Mostrar mais</button>
</section>"""
    return pagina(config, versao, f"{dados['titulo']} em Campo Grande | {config.get('nome')}", f"{dados['titulo']} em Campo Grande (MS) e região, com fotos e valores.", corpo, caminho=dados["caminho"])


def linha_dado(rotulo, valor, icone_nome=None):
    if not valor:
        return ""
    return f"<div>{icone(icone_nome) if icone_nome else ''}<dt>{e(rotulo)}</dt><dd>{e(valor)}</dd></div>"


def pagina_imovel(config, imovel, imoveis, versao):
    caminho = caminho_do_imovel(imovel)
    tipo = nome_tipo(imovel.get("tipo"))
    local = f"{imovel.get('bairro')}, {imovel.get('cidade')} - {imovel.get('uf')}"
    titulo_curto = f"{tipo} em {imovel.get('bairro')}"
    titulo_claro = titulo_do_imovel(imovel)
    fotos = [so_https(f) for f in imovel.get("fotos") or []]
    fotos = [f for f in fotos if f] or ([so_https(imovel.get("foto_principal"))] if so_https(imovel.get("foto_principal")) else [])
    marca = marca_dagua(imovel)
    galeria = "".join(
        f'<span class="foto-galeria"><img src="{e(f)}" alt="Foto {n} de {len(fotos)}: {e(titulo_curto)}"{"" if n <= 5 else " loading=" + chr(34) + "lazy" + chr(34)}>{marca}</span>'
        for n, f in enumerate(fotos, 1)
    ) or '<span class="sem-foto">Sem foto</span>'
    conversa = link_whatsapp(config, f"Olá! Tenho interesse no imóvel {imovel.get('referencia')} ({titulo_curto}).")
    visita = link_whatsapp(config, f"Olá! Quero agendar uma visita ao imóvel {imovel.get('referencia')} ({titulo_curto}).")
    precos = []
    if imovel.get("venda"):
        precos.append(("Venda", preco_do_imovel(imovel, "venda")))
    if imovel.get("locacao"):
        precos.append(("Aluguel", preco_do_imovel(imovel, "locacao")))
    extras = []
    if numero(imovel.get("valor_condominio")):
        extras.append(f"Condomínio {reais(imovel['valor_condominio'])}")
    if numero(imovel.get("valor_iptu")):
        extras.append(f"IPTU {reais(imovel['valor_iptu'])}")
    dados = "".join([
        linha_dado("Quartos", imovel.get("dormitorios"), "quartos"),
        linha_dado("Suítes", imovel.get("suites"), "suites"),
        linha_dado("Banheiros", imovel.get("banheiros"), "banheiros"),
        linha_dado("Vagas", imovel.get("vagas"), "vagas"),
        linha_dado("Área construída", metros(numero(imovel["area_construida"])) if numero(imovel.get("area_construida")) else None, "area"),
        linha_dado("Área útil", metros(numero(imovel["area_util"])) if numero(imovel.get("area_util")) else None, "area"),
        linha_dado("Terreno", metros(numero(imovel["area_terreno"])) if numero(imovel.get("area_terreno")) else None, "terreno"),
    ])
    selos = [COMODIDADES[c] for c in imovel.get("comodidades") or [] if c in COMODIDADES]
    if imovel.get("aceita_financiamento"):
        selos.append("Aceita financiamento")
    if imovel.get("aceita_pet"):
        selos.append("Aceita pet")
    if imovel.get("mobiliado"):
        selos.append("Mobiliado")
    parecidos = [
        i for i in imoveis
        if i["codigo"] != imovel["codigo"] and i.get("bairro") == imovel.get("bairro") and i.get("tipo") == imovel.get("tipo")
    ][:3] or [
        i for i in imoveis
        if i["codigo"] != imovel["codigo"] and i.get("tipo") == imovel.get("tipo") and bool(i.get("venda")) == bool(imovel.get("venda"))
    ][:3]
    secao_parecidos = (
        f'<section class="parecidos"><div class="largura secao"><h2>Parecidos com este</h2><div class="grade-imoveis">{"".join(cartao(i) for i in parecidos)}</div></div></section>'
        if parecidos else ""
    )
    voltar = FINALIDADES["venda" if imovel.get("venda") else "locacao"]
    interesse = e(botao(config, "interesse"))
    responsavel = imovel.get("corretor") or None
    caixa_corretor = (
        f"""<div class="corretor">{retrato(responsavel, 'corretor-foto')}<span><small>Corretor responsável</small><b>{e(responsavel.get('nome'))}</b>"""
        f"""{f"<small>{e(responsavel['creci'] if str(responsavel['creci']).upper().startswith('CRECI') else 'CRECI ' + str(responsavel['creci']))}</small>" if (responsavel.get('creci') or '').strip() else ''}</span></div>"""
        if responsavel and responsavel.get("nome") else ""
    )
    barra = f"""<div class="barra-movel"><a class="botao secundario" href="{e(visita)}" rel="noopener" target="_blank" data-clique="{e(imovel.get('referencia'))}">{icone('agenda')}Visita</a><a class="botao zap" href="{e(conversa)}" rel="noopener" target="_blank" data-clique="{e(imovel.get('referencia'))}">{icone('zap')}{interesse}</a></div>"""
    texto_completo = com_rodape(imovel) or ""
    longa = len(texto_completo) > 600
    texto_ampliar = f"Ver as {len(fotos)} fotos" if len(fotos) > 1 else "Ver a foto"
    corpo = f"""<article class="largura imovel">
  <p class="trilha"><a href="{voltar['caminho']}">{voltar['titulo']}</a> › {e(imovel.get('bairro'))}</p>
  <div class="galeria-caixa">
    <div class="galeria{' mosaico' if len(fotos) >= 5 else ''}" tabindex="0" role="group" aria-label="Fotos do imóvel" data-galeria>{galeria}</div>
    <button class="seta anterior" type="button" aria-label="Foto anterior" data-seta="-1" hidden>‹</button>
    <button class="seta proxima" type="button" aria-label="Próxima foto" data-seta="1" hidden>›</button>
    <button class="ampliar" type="button" data-ampliar hidden>{icone('fotos')}{e(texto_ampliar)}</button>
  </div>
  <div class="imovel-grade">
    <div>
      <p class="imovel-tipo">{e(tipo)} {'à venda' if imovel.get('venda') else 'para alugar'}</p>
      <h1>{e(titulo_claro)}</h1>
      <p class="imovel-local">{icone('local')}<span>{e(local)}</span><small>Ref. {e(imovel.get('referencia'))}</small></p>
      <p class="preco-topo">{e(precos[0][1] if precos else '')}{f'<small>{e(" · ".join(extras))}</small>' if extras else ''}</p>
      <dl class="dados">{dados}</dl>
      {f'<h2 class="imovel-sub">O que tem</h2><ul class="selos">{"".join(f"<li>{e(s)}</li>" for s in selos)}</ul>' if selos else ''}
      <h2 class="imovel-sub">Sobre o imóvel</h2>
      {f'<p class="anuncio-titulo">{e(imovel.get("titulo"))}</p>' if imovel.get('titulo') and imovel.get('titulo') != titulo_claro else ''}
      <div class="descricao{' fechada' if longa else ''}" id="descricao" data-descricao>{paragrafos(texto_completo)}</div>
      {'<button class="ler-mais" type="button" data-ler-mais aria-controls="descricao" aria-expanded="false" hidden>Ler a descrição completa</button>' if longa else ''}
    </div>
    <aside class="caixa-preco">
      {''.join(f'<p class="preco-linha"><small>{e(r)}</small><b>{e(v)}</b></p>' for r, v in precos)}
      {f'<p class="preco-extra">{e(" · ".join(extras))}</p>' if extras else ''}
      {caixa_corretor}
      <a class="botao largo zap" href="{e(conversa)}" rel="noopener" target="_blank" data-clique="{e(imovel.get('referencia'))}">{icone('zap')}{interesse}</a>
      <a class="botao largo secundario" href="{e(visita)}" rel="noopener" target="_blank" data-clique="{e(imovel.get('referencia'))}">{icone('agenda')}Agendar visita</a>
      <p class="preco-extra">A resposta chega pelo WhatsApp, a qualquer hora.</p>
    </aside>
  </div>
</article>
{secao_parecidos}"""
    return pagina(
        config, versao, f"{titulo_curto} · {imovel.get('referencia')} | {config.get('nome')}", descricao_curta(imovel), corpo,
        imagem=fotos[0] if fotos else None, barra_movel=barra, caminho=caminho,
    )


def pagina_sobre(config, versao):
    corpo = f"""<section class="largura secao texto">
  <h1>Sobre a {e(config.get('nome'))}</h1>
  {paragrafos(config.get('sobre'))}
  <h2>O que fazemos</h2>
  <ul class="servicos claro">{''.join(f'<li>{e(s)}</li>' for s in config.get('servicos') or [])}</ul>
  <p>{e(config.get('creci'))}</p>
</section>"""
    return pagina(config, versao, f"Sobre | {config.get('nome')}", (config.get("sobre") or "")[:155], corpo, caminho="/sobre/")


def pagina_contato(config, versao):
    telefones = "".join(f'<p><a href="tel:+55{re.sub(chr(92) + "D", "", t)}">{e(t)}</a></p>' for t in config.get("telefones") or [])
    email = f'<p><a href="mailto:{e(config["email"])}">{e(config["email"])}</a></p>' if config.get("email") else ""
    corpo = f"""<section class="largura secao texto">
  <h1>Fale com a gente</h1>
  {paragrafos(texto_extra(config, 'contato', 'Pelo WhatsApp a gente responde a qualquer hora. O escritório atende em horário comercial.'))}
  <a class="botao" href="{e(link_whatsapp(config, 'Olá! Vim pelo site e queria falar com a imobiliária.'))}" rel="noopener" target="_blank">{e(botao(config, 'contato'))}</a>
  <h2>Escritório</h2>
  <p>{e(config.get('endereco'))}</p>
  <p>{e(config.get('horario'))}</p>
  <h2>Telefones</h2>
  {telefones}{email}
</section>"""
    return pagina(config, versao, f"Contato | {config.get('nome')}", f"Fale com a {config.get('nome')} pelo WhatsApp ou no escritório em Campo Grande (MS).", corpo, caminho="/contato/")


def pagina_nao_encontrada(config, versao):
    corpo = """<section class="largura secao texto">
  <h1>Este imóvel não está mais aqui</h1>
  <p>Ele pode ter sido vendido ou alugado. Veja o que temos disponível agora.</p>
  <p class="acoes"><a class="botao" href="/comprar/">Imóveis para comprar</a> <a class="botao secundario" href="/alugar/">Imóveis para alugar</a></p>
</section>"""
    return pagina(config, versao, f"Página não encontrada | {config.get('nome')}", "Página não encontrada.", corpo)


# --- Banners da página inicial ----------------------------------------------

def link_do_banner(config, link):
    """Link do banner: endereço do próprio site (/...) ou https://."""
    link = (link or "").strip()
    if link.startswith("/") and not link.startswith("//"):
        return link
    return so_https(link)


def carrossel_de_banners(config):
    total = len(BANNERS)
    slides = []
    for n, b in enumerate(BANNERS, 1):
        titulo, texto, rotulo = (b.get("titulo") or "").strip(), (b.get("texto") or "").strip(), (b.get("botao") or "").strip()
        link = link_do_banner(config, b.get("link"))
        externo = ' rel="noopener" target="_blank"' if link.startswith("https://") else ""
        celular = so_https(b.get("imagem_celular_url"))
        imagem = (
            f'<picture>{f"""<source media="(max-width: 640px)" srcset="{e(celular)}">""" if celular else ""}'
            f'<img src="{e(b["imagem_url"])}" alt="{e(titulo)}"{"" if n == 1 else " loading=" + chr(34) + "lazy" + chr(34)} decoding="async"></picture>'
        )
        if link and not rotulo:
            imagem = f'<a class="banner-link" href="{e(link)}"{externo} aria-label="{e(titulo or "Saiba mais")}">{imagem}</a>'
        legenda = ""
        if titulo or texto or (link and rotulo):
            legenda = f"""<div class="banner-legenda"><div class="largura">
      {f'<p class="banner-titulo">{e(titulo)}</p>' if titulo else ''}
      {f'<p class="banner-texto">{e(texto)}</p>' if texto else ''}
      {f'<a class="botao" href="{e(link)}"{externo}>{e(rotulo)}</a>' if link and rotulo else ''}
    </div></div>"""
        slides.append(f"""<div class="banner{' com-legenda' if legenda else ''}" role="group" aria-roledescription="slide" aria-label="{n} de {total}">
    {imagem}
    {legenda}
  </div>""")
    controles = ""
    if total > 1:
        pontos = "".join(f'<button type="button" aria-label="Mostrar o banner {n}" data-banner-ponto="{n - 1}"></button>' for n in range(1, total + 1))
        controles = f"""<button class="seta anterior" type="button" aria-label="Banner anterior" data-banner-seta="-1" hidden>‹</button>
  <button class="seta proxima" type="button" aria-label="Próximo banner" data-banner-seta="1" hidden>›</button>
  <div class="banners-pontos" hidden>{pontos}</div>"""
    return f"""<section class="banners" aria-roledescription="carrossel" aria-label="Destaques" data-banners>
  <div class="banners-trilho" tabindex="0">{''.join(slides)}</div>
  {controles}
</section>"""


# --- Empreendimentos (lançamentos cadastrados no painel) ---------------------

STATUS_DO_EMPREENDIMENTO = {
    "lancamento": "Lançamento", "breve_lancamento": "Breve lançamento", "em_obras": "Em obras",
    "pronto": "Pronto para morar", "ultimas_unidades": "Últimas unidades",
}
TIPOS_DE_EMPREENDIMENTO = {
    "loteamento": "Loteamento", "apartamento": "Apartamentos", "casa_condominio": "Casas em condomínio",
    "comercial": "Comercial", "outro": "Empreendimento",
}


def caminho_do_empreendimento(emp):
    return f"/empreendimentos/{emp['slug']}/"


def preco_do_empreendimento(emp):
    valor = numero(emp.get("preco_a_partir"))
    return f"A partir de {reais(valor)}" if valor else ""


def fotos_do_empreendimento(emp):
    return [f for f in (so_https(x) for x in emp.get("fotos") or []) if f]


def selo_do_empreendimento(emp):
    status = emp.get("status") if emp.get("status") in STATUS_DO_EMPREENDIMENTO else "lancamento"
    return f'<span class="selo-emp s-{status}">{e(STATUS_DO_EMPREENDIMENTO[status])}</span>'


def cartao_do_empreendimento(emp):
    fotos = fotos_do_empreendimento(emp)
    tipo = TIPOS_DE_EMPREENDIMENTO.get(emp.get("tipo"), "Empreendimento")
    imagem = (
        f'<img src="{e(fotos[0])}" alt="{e(emp["nome"])}" loading="lazy" decoding="async">' if fotos else '<span class="sem-foto">Fotos em breve</span>'
    )
    detalhes = " · ".join(x for x in [emp.get("metragens"), emp.get("previsao_entrega") and f"Entrega {emp['previsao_entrega']}"] if x)
    return f"""<a class="cartao cartao-emp" href="{e(href(caminho_do_empreendimento(emp)))}" data-tipo="{e(emp.get('tipo'))}" data-bairro="{e(emp.get('bairro'))}" data-status="{e(emp.get('status'))}">
  <span class="cartao-foto">{imagem}{selo_do_empreendimento(emp)}</span>
  <span class="cartao-corpo">
    <b class="cartao-emp-nome">{e(emp['nome'])}</b>
    <span class="cartao-local">{e(tipo)}{f' · {e(emp.get("bairro"))}' if emp.get('bairro') else ''}</span>
    {f'<span class="cartao-dados">{e(detalhes)}</span>' if detalhes else ''}
    {f'<span class="cartao-preco-emp">{e(preco_do_empreendimento(emp))}</span>' if preco_do_empreendimento(emp) else ''}
    {f'<span class="cartao-ref">{e(emp.get("construtora"))}</span>' if emp.get('construtora') else ''}
  </span>
</a>"""


def pagina_empreendimentos(config, versao):
    tipos = sorted({m["tipo"] for m in EMPREENDIMENTOS if m.get("tipo")}, key=lambda t: TIPOS_DE_EMPREENDIMENTO.get(t, t))
    bairros = sorted({m["bairro"] for m in EMPREENDIMENTOS if m.get("bairro")})
    status = [s for s in STATUS_DO_EMPREENDIMENTO if any(m.get("status") == s for m in EMPREENDIMENTOS)]
    total = len(EMPREENDIMENTOS)
    corpo = f"""<section class="largura secao lista" data-lista-emp>
  <h1>Empreendimentos</h1>
  <p class="lista-sub">Lançamentos, obras e prontos para morar em Campo Grande (MS) e região.</p>
  <form class="filtros filtros-emp" data-filtros-emp>
    <label>Tipo<select name="tipo"><option value="">Todos</option>{opcoes(tipos, lambda t: TIPOS_DE_EMPREENDIMENTO.get(t, t))}</select></label>
    <label>Bairro<select name="bairro"><option value="">Todos</option>{opcoes(bairros)}</select></label>
    <label>Status<select name="status"><option value="">Todos</option>{opcoes(status, lambda s: STATUS_DO_EMPREENDIMENTO[s])}</select></label>
  </form>
  <p class="contagem" role="status" data-contagem>{total} empreendimento{'s' if total != 1 else ''}</p>
  <div class="grade-imoveis destaques" data-grade>{''.join(cartao_do_empreendimento(m) for m in EMPREENDIMENTOS)}</div>
  <p class="vazio" data-vazio hidden>Nenhum empreendimento com esses filtros agora. <a href="{e(link_whatsapp(config, 'Olá! Quero saber dos lançamentos e empreendimentos.'))}" rel="noopener" target="_blank">Fale com a gente</a>.</p>
</section>"""
    return pagina(
        config, versao, f"Empreendimentos e lançamentos em Campo Grande | {config.get('nome')}",
        "Lançamentos, empreendimentos em obras e prontos para morar em Campo Grande (MS), com fotos, plantas e localização.",
        corpo, imagem=next((fotos_do_empreendimento(m)[0] for m in EMPREENDIMENTOS if fotos_do_empreendimento(m)), None),
        caminho="/empreendimentos/",
    )


def video_embutido(endereco):
    """Endereço do YouTube ou do Vimeo vira o player; outros links, nada."""
    endereco = so_https(endereco)
    if not endereco:
        return None
    partes = urllib.parse.urlparse(endereco)
    servidor = partes.netloc.lower().removeprefix("www.").removeprefix("m.")
    codigo = None
    if servidor == "youtu.be":
        codigo = partes.path.strip("/").split("/")[0]
    elif servidor.endswith("youtube.com"):
        if partes.path == "/watch":
            codigo = urllib.parse.parse_qs(partes.query).get("v", [None])[0]
        elif partes.path.startswith(("/shorts/", "/embed/", "/live/")):
            codigo = partes.path.split("/")[2]
    elif servidor == "vimeo.com" and partes.path.strip("/").isdigit():
        return f"https://player.vimeo.com/video/{partes.path.strip('/')}"
    if codigo and re.fullmatch(r"[\w-]{6,20}", codigo):
        return f"https://www.youtube-nocookie.com/embed/{codigo}"
    return None


def local_no_mapa(emp):
    try:
        if emp.get("latitude") is not None and emp.get("longitude") is not None:
            return f"{float(emp['latitude']):.6f},{float(emp['longitude']):.6f}"
    except (TypeError, ValueError):
        pass
    partes = [emp.get("endereco"), emp.get("bairro"), f"{emp.get('cidade') or ''} - {emp.get('uf') or ''}".strip(" -")]
    texto = ", ".join(p for p in partes if p)
    return texto or None


def lista_de_itens(itens, classe="lista-emp"):
    itens = [i for i in itens or [] if (i or "").strip()]
    return f'<ul class="{classe}">{"".join(f"<li>{e(i)}</li>" for i in itens)}</ul>' if itens else ""


def pagina_empreendimento(config, emp, versao):
    caminho = caminho_do_empreendimento(emp)
    nome = emp["nome"]
    tipo = TIPOS_DE_EMPREENDIMENTO.get(emp.get("tipo"), "Empreendimento")
    local = ", ".join(x for x in [emp.get("bairro"), f"{emp.get('cidade') or ''} - {emp.get('uf') or ''}".strip(" -")] if x)
    fotos = fotos_do_empreendimento(emp)
    galeria = "".join(
        f'<span class="foto-galeria"><img src="{e(f)}" alt="Foto {n} de {len(fotos)}: {e(nome)}"{"" if n == 1 else " loading=" + chr(34) + "lazy" + chr(34)}></span>'
        for n, f in enumerate(fotos, 1)
    )
    bloco_galeria = f"""<div class="galeria-caixa">
    <div class="galeria" tabindex="0" role="group" aria-label="Fotos do empreendimento" data-galeria>{galeria}</div>
    <button class="seta anterior" type="button" aria-label="Foto anterior" data-seta="-1" hidden>‹</button>
    <button class="seta proxima" type="button" aria-label="Próxima foto" data-seta="1" hidden>›</button>
    <button class="ampliar" type="button" data-ampliar hidden>Ver fotos em tela cheia</button>
  </div>""" if fotos else ""
    dados = "".join([
        linha_dado("Construtora", emp.get("construtora")),
        linha_dado("Tipo", tipo),
        linha_dado("Tamanhos", emp.get("metragens")),
        linha_dado("Entrega", emp.get("previsao_entrega")),
    ])
    plantas = [p for p in (so_https(x) for x in emp.get("plantas") or []) if p]
    bloco_plantas = (
        '<h2>Plantas</h2><ul class="plantas">' + "".join(
            f'<li><a href="{e(p)}" target="_blank" rel="noopener"><img src="{e(p)}" alt="Planta {n} de {len(plantas)}: {e(nome)}" loading="lazy" decoding="async"><span>Ver planta {n} em tamanho grande</span></a></li>'
            for n, p in enumerate(plantas, 1)
        ) + "</ul>"
    ) if plantas else ""
    video = video_embutido(emp.get("video_url"))
    bloco_video = (
        f'<h2>Vídeo</h2><div class="video"><iframe src="{e(video)}" title="Vídeo do {e(nome)}" loading="lazy" allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowfullscreen></iframe></div>'
        if video else (f'<p><a class="botao secundario" href="{e(so_https(emp.get("video_url")))}" target="_blank" rel="noopener">Assistir ao vídeo</a></p>' if so_https(emp.get("video_url")) else "")
    )
    onde = local_no_mapa(emp)
    bloco_mapa = ""
    if onde:
        consulta = urllib.parse.quote(onde)
        bloco_mapa = f"""<h2>Localização</h2>
      {f'<p class="imovel-local">{e(emp.get("endereco"))}</p>' if emp.get('endereco') else ''}
      <div class="mapa"><iframe src="https://www.google.com/maps?q={consulta}&amp;z=15&amp;output=embed" title="Mapa: {e(nome)}" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe></div>
      <p><a href="https://www.google.com/maps/search/?api=1&amp;query={consulta}" target="_blank" rel="noopener">Abrir no Google Maps</a></p>"""
    oficial = so_https(emp.get("link_oficial"))
    conversa = link_whatsapp(config, f"Olá! Tenho interesse no empreendimento {nome}. Pode me passar mais informações?")
    preco = preco_do_empreendimento(emp)
    interesse = e(botao(config, "interesse"))
    nome_empresa = config.get("nome") or "imobiliária"
    formulario = f"""<form class="pedido" data-pedido="{e(emp['slug'])}" novalidate>
        <h2 id="pedido-titulo">Quero receber mais informações</h2>
        <label>Nome<input name="nome" autocomplete="name" required maxlength="80"></label>
        <label>WhatsApp<input name="telefone" type="tel" inputmode="tel" autocomplete="tel" required placeholder="(67) 99999-0000"></label>
        <label><span>E-mail <small>(opcional)</small></span><input name="email" type="email" autocomplete="email" maxlength="120"></label>
        <label><span>Mensagem <small>(opcional)</small></span><textarea name="mensagem" rows="3" maxlength="500"></textarea></label>
        <label class="armadilha" aria-hidden="true">Empresa<input name="empresa" tabindex="-1" autocomplete="off"></label>
        <p class="pedido-aviso">Ao enviar, você autoriza a {e(nome_empresa)} a falar com você sobre este empreendimento pelo WhatsApp, telefone ou e-mail.</p>
        <button class="botao largo" type="submit">Quero receber informações</button>
        <p class="pedido-status" role="status" data-pedido-status></p>
        <noscript><p class="pedido-aviso">Para enviar pelo formulário, ative o JavaScript, ou <a href="{e(conversa)}">fale pelo WhatsApp</a>.</p></noscript>
      </form>"""
    barra = f"""<div class="barra-movel"><span><b>{e(nome)}</b><small>{e(preco or STATUS_DO_EMPREENDIMENTO.get(emp.get('status'), ''))}</small></span><a class="botao" href="{e(conversa)}" rel="noopener" target="_blank">{interesse}</a></div>"""
    corpo = f"""<article class="largura imovel empreendimento">
  <p class="trilha"><a href="/empreendimentos/">Empreendimentos</a> › {e(nome)}</p>
  {bloco_galeria}
  <div class="imovel-grade">
    <div>
      {selo_do_empreendimento(emp)}
      <h1>{e(nome)}</h1>
      <p class="imovel-local">{e(tipo)}{f' · {e(local)}' if local else ''}</p>
      {f'<p class="resumo-emp">{e(emp.get("resumo"))}</p>' if emp.get('resumo') else ''}
      <dl class="dados">{dados}</dl>
      <div class="descricao">{paragrafos(emp.get('descricao'))}</div>
      {f'<h2>Lazer</h2>{lista_de_itens(emp.get("lazer"))}' if emp.get('lazer') else ''}
      {f'<h2>Diferenciais</h2>{lista_de_itens(emp.get("diferenciais"))}' if emp.get('diferenciais') else ''}
      {bloco_plantas}
      {bloco_video}
      {bloco_mapa}
      {f'<p><a href="{e(oficial)}" target="_blank" rel="noopener">Site oficial do empreendimento</a></p>' if oficial else ''}
    </div>
    <aside class="caixa-preco">
      <p class="preco-linha"><small>{e(STATUS_DO_EMPREENDIMENTO.get(emp.get('status'), ''))}</small><b>{e(preco or 'Consulte os valores')}</b></p>
      <a class="botao largo" href="{e(conversa)}" rel="noopener" target="_blank">{interesse}</a>
      <p class="preco-extra">A resposta chega pelo WhatsApp, a qualquer hora.</p>
      {formulario}
    </aside>
  </div>
</article>"""
    descricao = emp.get("resumo") or f"{tipo} {nome}" + (f" em {emp.get('bairro')}, {emp.get('cidade')}" if emp.get("bairro") else "") + "."
    return pagina(
        config, versao, f"{nome} | {tipo} em {emp.get('cidade') or 'Campo Grande'} | {config.get('nome')}", descricao, corpo,
        imagem=fotos[0] if fotos else (so_https(config.get("logo_url")) or None), barra_movel=barra, caminho=caminho,
    )


# --- Página de cada corretor (lfg.jojodigitals.com/corretor/<slug>) -----------
# Servida pelo Caddy no endereço do painel, por isso a página é inteira em um
# arquivo (estilo embutido) e os links dos imóveis apontam para o site.
ENDERECO_DAS_PAGINAS = "https://lfg.jojodigitals.com"
SITE_PADRAO = "https://site.lfg.jojodigitals.com"
SLUG_VALIDO = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
MAXIMO_DE_IMOVEIS_NA_PAGINA = 24

ESTILO_CORRETOR = """
:root{--marinho:#003654;--azul:#005d92;--limao:#94bf0b;--fundo:#f5f8fa;--texto:#0b2233;--texto-2:#2e4557;--linha:rgba(0,54,84,.12)}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;font-family:Manrope,"Segoe UI",system-ui,sans-serif;font-weight:500;font-size:16px;line-height:1.5;color:var(--texto);background:var(--fundo)}
a{color:inherit}img{display:block;max-width:100%}
.topo{background:linear-gradient(160deg,#001a2b 0%,var(--marinho) 55%,var(--azul) 130%);color:#fff;padding:20px 16px 28px;text-align:center}
.marca{display:inline-block;background:#fff;border-radius:12px;padding:6px 12px;margin-bottom:22px}.marca img{height:34px;width:auto}
.retrato{width:132px;height:132px;border-radius:50%;object-fit:cover;margin:0 auto 14px;border:4px solid var(--limao);background:#00253c}
.sem-retrato{display:grid;place-items:center;font-family:Unbounded,system-ui,sans-serif;font-size:40px;color:#fff}
h1{font-family:Unbounded,system-ui,sans-serif;font-weight:700;font-size:26px;line-height:1.2;margin:0 0 6px}
.creci{margin:0;color:#cad9e4;font-size:14px}
.chamada{margin:12px auto 18px;max-width:34ch;color:#eef4f8}
.whats{display:inline-flex;align-items:center;justify-content:center;gap:10px;min-height:52px;width:100%;max-width:360px;padding:12px 22px;border-radius:14px;background:var(--limao);color:var(--marinho);font-weight:800;font-size:17px;text-decoration:none;box-shadow:0 8px 24px rgba(0,0,0,.25)}
.whats:focus-visible{outline:3px solid #fff;outline-offset:3px}.whats svg{width:22px;height:22px}
main{max-width:1080px;margin:0 auto;padding:24px 16px 40px}
h2{font-family:Unbounded,system-ui,sans-serif;font-size:19px;margin:0 0 14px;color:var(--marinho)}
.grade{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:1fr;gap:14px}
@media(min-width:620px){.grade{grid-template-columns:repeat(2,1fr)}}@media(min-width:960px){.grade{grid-template-columns:repeat(3,1fr)}}
.cartao{display:flex;flex-direction:column;height:100%;background:#fff;border:1px solid var(--linha);border-radius:16px;overflow:hidden;text-decoration:none;box-shadow:0 1px 2px rgba(0,54,84,.06),0 4px 14px rgba(0,54,84,.08)}
.cartao:focus-visible{outline:3px solid var(--azul);outline-offset:2px}
.foto{position:relative;aspect-ratio:4/3;background:#e1edf6}.foto img{width:100%;height:100%;object-fit:cover}
.sem-foto{display:grid;place-items:center;height:100%;color:var(--texto-2);font-size:14px}
.selo{position:absolute;left:10px;top:10px;padding:3px 10px;border-radius:999px;background:var(--marinho);color:#fff;font-size:12px;font-weight:700}
.corpo{display:flex;flex-direction:column;gap:2px;padding:12px 14px 14px}
.preco{font-size:19px;font-weight:800;color:var(--marinho)}.titulo{font-weight:700}.local,.dados{color:var(--texto-2);font-size:14px}
.vazio{background:#fff;border:1px solid var(--linha);border-radius:16px;padding:18px;color:var(--texto-2)}
.mais{display:inline-block;margin-top:18px;color:var(--azul);font-weight:700}
footer{padding:22px 16px 32px;text-align:center;color:var(--texto-2);font-size:14px}
"""

ICONE_WHATSAPP = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2a8.2 8.2 0 0 1-4.2-1.1l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.7.8-.8 1-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.3-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.8 11.9 11.9 0 0 0 4.6 4c1.7.7 2.4.8 3.2.7a2.8 2.8 0 0 0 1.8-1.3 2.3 2.3 0 0 0 .2-1.3c-.1-.1-.2-.2-.5-.3Z"/></svg>'


def cartao_do_corretor(imovel, site):
    foto = so_https(imovel.get("foto_mini")) or so_https(imovel.get("foto_principal"))
    titulo = (imovel.get("titulo") or "").strip() or f"{nome_tipo(imovel.get('tipo'))} em {imovel.get('bairro')}"
    if len(titulo) > 80:
        titulo = titulo[:79].rsplit(" ", 1)[0] + "…"
    finalidade = "locacao" if imovel.get("locacao") and not imovel.get("venda") else None
    selo = "Aluguel" if finalidade == "locacao" else ("Venda e aluguel" if imovel.get("venda") and imovel.get("locacao") else "Venda")
    imagem = (f'<img src="{e(foto)}" alt="" loading="lazy" decoding="async" width="400" height="300">'
              if foto else '<span class="sem-foto">Sem foto</span>')
    return f"""<li><a class="cartao" href="{e(site + href(caminho_do_imovel(imovel)))}">
  <span class="foto">{imagem}<span class="selo">{selo}</span></span>
  <span class="corpo">
    <b class="preco">{e(preco_do_imovel(imovel, finalidade))}</b>
    <span class="titulo">{e(titulo)}</span>
    <span class="local">{e(nome_tipo(imovel.get('tipo')))} · {e(imovel.get('bairro'))}</span>
    <span class="dados">{e(' · '.join(resumo_do_imovel(imovel)))}</span>
  </span>
</a></li>"""


def pagina_do_corretor(config, pessoa, imoveis, versao):
    nome = (pessoa.get("nome") or "").strip()
    primeiro = nome.split(" ")[0]
    empresa = config.get("nome") or "LFG Imóveis"
    site = (config.get("endereco_site") or SITE_PADRAO).rstrip("/")
    endereco = f"{ENDERECO_DAS_PAGINAS}/corretor/{pessoa['slug']}"
    logo = so_https(config.get("logo_url")) or f"{site}/logo-lfg.png"
    foto = so_https(pessoa.get("foto_url"))
    creci = (pessoa.get("creci") or "").strip()
    linha_creci = f"CRECI {creci}" if creci and not creci.upper().startswith("CRECI") else creci
    numero_pessoal = re.sub(r"\D", "", pessoa.get("whatsapp") or "")
    texto = f"Olá, {primeiro}! Vi sua página e quero saber mais sobre os imóveis."
    whats = f"https://wa.me/{numero_pessoal}?text={urllib.parse.quote(texto)}" if numero_pessoal else link_whatsapp(config, texto)
    todos = [i for i in imoveis if (i.get("corretor") or {}).get("slug") == pessoa["slug"]]
    dele = todos[:MAXIMO_DE_IMOVEIS_NA_PAGINA]
    descricao = (f"Fale com {nome} no WhatsApp e veja {len(todos)} imóve{'is' if len(todos) != 1 else 'l'} disponíve{'is' if len(todos) != 1 else 'l'} com a {empresa}."
                 if dele else f"Fale com {nome}, corretor(a) da {empresa}, no WhatsApp.")
    retrato_html = (f'<img class="retrato" src="{e(foto)}" alt="Foto de {e(nome)}" width="132" height="132" fetchpriority="high">'
                    if foto else f'<span class="retrato sem-retrato" aria-hidden="true">{e(iniciais(nome))}</span>')
    lista = (f'<ul class="grade">{"".join(cartao_do_corretor(i, site) for i in dele)}</ul>'
             if dele else '<p class="vazio">Nenhum imóvel no momento. Chame no WhatsApp que eu procuro para você.</p>')
    return f"""<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{e(nome)} · {e(empresa)}</title>
<meta name="description" content="{e(descricao)}">
<meta name="theme-color" content="#003654">
<link rel="canonical" href="{e(endereco)}">
<meta property="og:type" content="profile">
<meta property="og:site_name" content="{e(empresa)}">
<meta property="og:title" content="{e(nome)} · {e(empresa)}">
<meta property="og:description" content="{e(descricao)}">
<meta property="og:url" content="{e(endereco)}">
<meta property="og:image" content="{e(foto or logo)}">
<meta property="og:locale" content="pt_BR">
<meta name="twitter:card" content="summary">
<link rel="icon" href="{e(logo)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Unbounded:wght@700&family=Manrope:wght@500;700;800&display=swap">
<style>{ESTILO_CORRETOR}</style>
</head>
<body>
<header class="topo">
  <a class="marca" href="{e(site)}/"><img src="{e(logo)}" alt="{e(empresa)}" height="34"></a>
  {retrato_html}
  <h1>{e(nome)}</h1>
  {f'<p class="creci">{e(linha_creci)}</p>' if linha_creci else ''}
  <p class="chamada">Corretor(a) da {e(empresa)}. Me chame no WhatsApp para visitar, tirar dúvidas ou encontrar o imóvel certo.</p>
  <a class="whats" href="{e(whats)}" rel="noopener">{ICONE_WHATSAPP}Falar com {e(primeiro)} no WhatsApp</a>
</header>
<main>
  <h2>Imóveis com {e(primeiro)}</h2>
  {lista}
  <a class="mais" href="{e(site)}/">Ver todos os imóveis da {e(empresa)} →</a>
</main>
<footer>{e(empresa)}{f' · {e(config.get("creci"))}' if config.get("creci") else ''}</footer>
</body>
</html>
"""


def pagina_sem_corretor(config):
    empresa = config.get("nome") or "LFG Imóveis"
    site = (config.get("endereco_site") or SITE_PADRAO).rstrip("/")
    return f"""<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Página não encontrada · {e(empresa)}</title><meta name="robots" content="noindex"><style>{ESTILO_CORRETOR}</style></head>
<body><header class="topo"><h1>Página não encontrada</h1><p class="chamada">Esse endereço de corretor não existe ou mudou.</p>
<a class="whats" href="{e(site)}/">Ver os imóveis da {e(empresa)}</a></header></body></html>
"""


# --- Página de compartilhar (lfg.jojodigitals.com/imovel/<REF>?c=<slug>) -------
# Leve, sem dados internos (proprietário, endereço exato, comissão, observações).
# O ?c= diz quem compartilhou: a página mostra a pessoa e o botão de WhatsApp vai
# para o número oficial com o código "REF/slug", que entrega o lead direto a ela.
ESTILO_COMPARTILHAR = """
:root{--marinho:#003654;--azul:#005d92;--limao:#94bf0b;--fundo:#f5f8fa;--texto:#0b2233;--texto-2:#3a5266;--linha:rgba(0,54,84,.12)}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;font-family:Manrope,"Segoe UI",system-ui,sans-serif;font-weight:500;font-size:16px;line-height:1.55;color:var(--texto);background:var(--fundo);padding-bottom:88px}
a{color:inherit}img{display:block;max-width:100%}
.topo{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 16px;background:var(--marinho)}
.marca{display:inline-flex;background:#fff;border-radius:10px;padding:4px 10px}.marca img{height:30px;width:auto}
.topo small{color:#cfe0ec;font-size:13px}
.fotos{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;gap:4px;background:#00253c;scrollbar-width:none}
.fotos::-webkit-scrollbar{display:none}
.foto{position:relative;flex:0 0 100%;scroll-snap-align:center;aspect-ratio:4/3;max-height:70vh}
@media(min-width:760px){.foto{flex-basis:70%}}
.foto img{width:100%;height:100%;object-fit:cover}
.contador{position:relative}.contador span{position:absolute;right:12px;bottom:12px;padding:2px 10px;border-radius:999px;background:rgba(0,26,43,.75);color:#fff;font-size:13px;font-weight:700}
.marca-dagua{position:absolute;pointer-events:none;height:auto}.m-centro{left:50%;top:50%;transform:translate(-50%,-50%)}
.m-superior_esquerdo{left:4%;top:4%}.m-superior_direito{right:4%;top:4%}.m-inferior_esquerdo{left:4%;bottom:4%}.m-inferior_direito{right:4%;bottom:4%}
main{max-width:760px;margin:0 auto;padding:18px 16px 24px;display:flex;flex-direction:column;gap:18px}
h1{font-family:Unbounded,system-ui,sans-serif;font-weight:700;font-size:19px;line-height:1.3;margin:0;color:var(--marinho)}
.local{margin:4px 0 0;color:var(--texto-2)}
.precos{display:flex;flex-wrap:wrap;gap:8px 22px}.preco small{display:block;color:var(--texto-2);font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
.preco b{font-size:26px;font-weight:800;color:var(--marinho)}.extra{color:var(--texto-2);font-size:14px;margin:0}
.dados{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin:0;padding:0;list-style:none}
.dados li{background:#fff;border:1px solid var(--linha);border-radius:12px;padding:10px 12px}.dados b{display:block;font-size:18px;color:var(--marinho)}.dados span{color:var(--texto-2);font-size:13px}
.selos{display:flex;flex-wrap:wrap;gap:6px;margin:0;padding:0;list-style:none}.selos li{padding:4px 12px;border-radius:999px;background:#e5f0d0;color:#2d4a00;font-size:14px;font-weight:700}
h2{font-family:Unbounded,system-ui,sans-serif;font-size:17px;margin:0 0 8px;color:var(--marinho)}
.descricao p{margin:0 0 10px;color:var(--texto-2)}
.mapa{display:inline-flex;align-items:center;gap:8px;min-height:44px;padding:8px 14px;border-radius:12px;border:1px solid var(--linha);background:#fff;color:var(--azul);font-weight:700;text-decoration:none}
.pessoa{display:flex;align-items:center;gap:12px;background:#fff;border:1px solid var(--linha);border-radius:16px;padding:12px 14px}
.pessoa img,.pessoa .sem-retrato{width:56px;height:56px;border-radius:50%;object-fit:cover;flex:none;border:3px solid var(--limao);background:var(--marinho);color:#fff;display:grid;place-items:center;font-weight:800}
.pessoa small{display:block;color:var(--texto-2);font-size:13px}.pessoa b{font-size:17px}
.barra{position:fixed;left:0;right:0;bottom:0;padding:10px 16px calc(10px + env(safe-area-inset-bottom));background:rgba(255,255,255,.96);border-top:1px solid var(--linha);display:flex;justify-content:center}
.whats{display:inline-flex;align-items:center;justify-content:center;gap:10px;min-height:54px;width:100%;max-width:520px;padding:12px 20px;border-radius:14px;background:#1fa855;color:#fff;font-weight:800;font-size:17px;text-decoration:none;box-shadow:0 6px 18px rgba(0,0,0,.18)}
.whats svg{width:22px;height:22px}.whats:focus-visible,.mapa:focus-visible{outline:3px solid var(--azul);outline-offset:3px}
footer{text-align:center;color:var(--texto-2);font-size:13px;padding:8px 16px 24px}
"""

ROTULOS_DOS_DADOS = (("dormitorios", "quarto", "quartos"), ("suites", "suíte", "suítes"), ("banheiros", "banheiro", "banheiros"), ("vagas", "vaga", "vagas"))


def pagina_compartilhar(config, imovel, versao):
    ref = imovel.get("referencia") or imovel["codigo"]
    tipo = nome_tipo(imovel.get("tipo"))
    bairro = imovel.get("bairro") or ""
    cidade = imovel.get("cidade") or ""
    titulo_curto = f"{tipo} em {bairro}" if bairro else tipo
    empresa = config.get("nome") or "LFG Imóveis"
    site = (config.get("endereco_site") or SITE_PADRAO).rstrip("/")
    endereco = f"{ENDERECO_DAS_PAGINAS}/imovel/{re.sub(r'[^A-Za-z0-9-]', '', str(ref))}"
    logo = so_https(config.get("logo_url")) or f"{site}/logo-lfg.png"
    fotos = [so_https(f) for f in imovel.get("fotos") or []]
    fotos = [f for f in fotos if f] or ([so_https(imovel.get("foto_principal"))] if so_https(imovel.get("foto_principal")) else [])
    marca = marca_dagua(imovel)
    galeria = "".join(
        f'<div class="foto"><img src="{e(f)}" alt="Foto {n} de {len(fotos)}"{" fetchpriority=" + chr(34) + "high" + chr(34) if n == 1 else " loading=" + chr(34) + "lazy" + chr(34)} decoding="async">{marca}</div>'
        for n, f in enumerate(fotos, 1)
    )
    precos = []
    if imovel.get("venda"):
        precos.append(("Venda", preco_do_imovel(imovel, "venda")))
    if imovel.get("locacao"):
        precos.append(("Aluguel", preco_do_imovel(imovel, "locacao")))
    extras = []
    if numero(imovel.get("valor_condominio")):
        extras.append(f"Condomínio {reais(imovel['valor_condominio'])}")
    if numero(imovel.get("valor_iptu")):
        extras.append(f"IPTU {reais(imovel['valor_iptu'])}")
    dados = []
    for campo, um, varios in ROTULOS_DOS_DADOS:
        valor = imovel.get(campo)
        if valor:
            dados.append((str(valor), um if valor == 1 else varios))
    if area(imovel):
        dados.append((metros(area(imovel)), "área"))
    selos = [COMODIDADES[c] for c in imovel.get("comodidades") or [] if c in COMODIDADES]
    if imovel.get("aceita_financiamento"):
        selos.append("Aceita financiamento")
    if imovel.get("aceita_pet"):
        selos.append("Aceita pet")
    if imovel.get("mobiliado"):
        selos.append("Mobiliado")
    lugar = ", ".join(p for p in (bairro, cidade, imovel.get("uf")) if p)
    if imovel.get("lat") is not None and imovel.get("lng") is not None:
        mapa = f"https://www.google.com/maps/search/?api=1&query={imovel['lat']},{imovel['lng']}"
    else:
        mapa = f"https://www.google.com/maps/search/?api=1&query={urllib.parse.quote(lugar)}"
    numero_oficial = re.sub(r"\D", "", config.get("whatsapp") or "")
    texto_base = f"Olá! Vi o imóvel {ref} ({titulo_curto}) e gostaria de mais informações."
    whats = f"https://wa.me/{numero_oficial}?text={urllib.parse.quote(texto_base + f' (código: {ref})')}"
    # Quem pode aparecer como "quem enviou": corretores e gestores com página.
    pessoas = {
        p["slug"]: {"n": (p.get("nome") or "").strip(), "f": so_https(p.get("foto_url")), "c": (p.get("creci") or "").strip()}
        for p in EQUIPE if SLUG_VALIDO.match(p.get("slug") or "")
    }
    resumo = " · ".join(f"{v} {r}" for v, r in dados[:4])
    preco_titulo = precos[0][1] if precos else ""
    titulo_og = f"{titulo_curto} · {preco_titulo}" if preco_titulo else titulo_curto
    descricao_og = " · ".join(p for p in (resumo, f"Ref. {ref}") if p)
    dados_js = json.dumps({"ref": ref, "texto": texto_base, "numero": numero_oficial, "pessoas": pessoas,
                           "api": f"{SUPABASE_URL}/rest/v1/rpc/registrar_acesso_imovel", "chave": CHAVE_PUBLICA}, ensure_ascii=False).replace("</", "<\\/")
    return f"""<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{e(titulo_og)} · {e(empresa)}</title>
<meta name="description" content="{e(descricao_og)}">
<meta name="theme-color" content="#003654">
<meta name="robots" content="noindex">
<link rel="canonical" href="{e(endereco)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="{e(empresa)}">
<meta property="og:title" content="{e(titulo_og)}">
<meta property="og:description" content="{e(descricao_og)}">
<meta property="og:url" content="{e(endereco)}">
{f'<meta property="og:image" content="{e(fotos[0])}">' if fotos else f'<meta property="og:image" content="{e(logo)}">'}
<meta property="og:locale" content="pt_BR">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="{e(logo)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Unbounded:wght@700&family=Manrope:wght@500;700;800&display=swap">
<style>{ESTILO_COMPARTILHAR}</style>
</head>
<body>
<header class="topo"><a class="marca" href="{e(site)}/"><img src="{e(logo)}" alt="{e(empresa)}"></a><small>Ref. {e(ref)}</small></header>
{f'<div class="contador"><div class="fotos" aria-label="Fotos do imóvel" tabindex="0">{galeria}</div><span>{len(fotos)} fotos</span></div>' if fotos else ''}
<main>
  <section>
    <h1>{e(imovel.get('titulo') or titulo_curto)}</h1>
    <p class="local">{e(tipo)} · {e(lugar)}</p>
  </section>
  <section class="precos">{''.join(f'<p class="preco" style="margin:0"><small>{e(r)}</small><b>{e(v)}</b></p>' for r, v in precos)}</section>
  {f'<p class="extra">{e(" · ".join(extras))}</p>' if extras else ''}
  <div class="pessoa" data-pessoa hidden></div>
  {f'<ul class="dados">{"".join(f"<li><b>{e(v)}</b><span>{e(r)}</span></li>" for v, r in dados)}</ul>' if dados else ''}
  {f'<ul class="selos">{"".join(f"<li>{e(s)}</li>" for s in selos)}</ul>' if selos else ''}
  {f'<section class="descricao"><h2>Sobre o imóvel</h2>{paragrafos(imovel.get("descricao"))}</section>' if (imovel.get("descricao") or "").strip() else ''}
  <section><h2>Localização</h2><p class="extra" style="margin-bottom:10px">{e(lugar)}. O endereço exato é passado pelo corretor.</p>
    <a class="mapa" href="{e(mapa)}" rel="noopener" target="_blank">Ver a região no mapa</a></section>
</main>
<footer>{e(empresa)}{f' · {e(config.get("creci"))}' if config.get("creci") else ''}</footer>
<div class="barra"><a class="whats" href="{e(whats)}" rel="noopener" data-whats>{ICONE_WHATSAPP}<span data-rotulo>Quero saber mais</span></a></div>
<script>
(function () {{
  var D = {dados_js};
  var slug = (new URLSearchParams(location.search).get("c") || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 60);
  var pessoa = D.pessoas[slug] || null;
  if (!pessoa) slug = "";
  var visitante = "";
  try {{ visitante = localStorage.getItem("lfg-visitante") || ""; if (!visitante) {{ visitante = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem("lfg-visitante", visitante); }} }} catch (e) {{}}
  function registrar(tipo) {{
    try {{
      fetch(D.api, {{ method: "POST", keepalive: true, headers: {{ apikey: D.chave, "Content-Type": "application/json" }},
        body: JSON.stringify({{ p_referencia: D.ref, p_corretor: slug || null, p_tipo: tipo, p_visitante: visitante || null }}) }}).catch(function () {{}});
    }} catch (e) {{}}
  }}
  var link = document.querySelector("[data-whats]");
  if (pessoa) {{
    var primeiro = pessoa.n.split(" ")[0];
    var texto = D.texto + " Quem me enviou foi " + primeiro + ". (código: " + D.ref + "/" + slug + ")";
    link.href = "https://wa.me/" + D.numero + "?text=" + encodeURIComponent(texto);
    document.querySelector("[data-rotulo]").textContent = "Falar com " + primeiro + " no WhatsApp";
    var caixa = document.querySelector("[data-pessoa]");
    var foto = pessoa.f ? '<img src="' + pessoa.f.replace(/"/g, "") + '" alt="">' : '<span class="sem-retrato">' + primeiro.charAt(0) + "</span>";
    var creci = pessoa.c ? (/^creci/i.test(pessoa.c) ? pessoa.c : "CRECI " + pessoa.c) : "";
    caixa.innerHTML = foto + "<span><small>Quem te enviou</small><b></b>" + (creci ? "<small></small>" : "") + "</span>";
    caixa.querySelector("b").textContent = pessoa.n;
    if (creci) caixa.querySelectorAll("small")[1].textContent = creci;
    caixa.hidden = false;
  }}
  link.addEventListener("click", function () {{ registrar("whatsapp"); }});
  registrar("abriu");
}})();
</script>
</body>
</html>
"""


def escrever(pasta, caminho, conteudo):
    destino = pasta.joinpath(*[p for p in caminho.split("/") if p], "index.html")
    destino.parent.mkdir(parents=True, exist_ok=True)
    destino.write_text(conteudo, encoding="utf-8")


def gerar(dados, pasta, versao):
    config, imoveis = dict(dados["config"] or {}), dados["imoveis"]
    # Nome e logo vêm das Configurações gerais; a aba Site só troca a logo se tiver uma própria.
    EMPRESA.clear()
    EMPRESA.update(dados.get("empresa") or {})
    EQUIPE.clear()
    EQUIPE.extend(p for p in dados.get("equipe") or [] if (p.get("nome") or "").strip())
    EMPREENDIMENTOS.clear()
    EMPREENDIMENTOS.extend(m for m in dados.get("empreendimentos") or [] if SLUG_VALIDO.match(m.get("slug") or "") and (m.get("nome") or "").strip())
    BANNERS.clear()
    BANNERS.extend(b for b in dados.get("banners") or [] if so_https(b.get("imagem_url")))
    if (EMPRESA.get("nome") or "").strip():
        config["nome"] = EMPRESA["nome"].strip()
    if not so_https(config.get("logo_url")) and so_https(EMPRESA.get("logo_url")):
        config["logo_url"] = EMPRESA["logo_url"]
    shutil.copy(AQUI / "estilo.css", pasta / "estilo.css")
    shutil.copy(AQUI / "site.js", pasta / "site.js")
    shutil.copy(AQUI / "logo-lfg.png", pasta / "logo-lfg.png")
    shutil.copy(AQUI / "logo-lfg-branca.png", pasta / "logo-lfg-branca.png")

    escrever(pasta, "/", pagina_inicial(config, imoveis, versao))
    escrever(pasta, "/comprar/", pagina_lista(config, imoveis, "venda", versao))
    escrever(pasta, "/alugar/", pagina_lista(config, imoveis, "locacao", versao))
    escrever(pasta, "/sobre/", pagina_sobre(config, versao))
    escrever(pasta, "/contato/", pagina_contato(config, versao))
    (pasta / "404.html").write_text(pagina_nao_encontrada(config, versao), encoding="utf-8")
    for imovel in imoveis:
        escrever(pasta, caminho_do_imovel(imovel), pagina_imovel(config, imovel, imoveis, versao))
    if EMPREENDIMENTOS:
        escrever(pasta, "/empreendimentos/", pagina_empreendimentos(config, versao))
        for emp in EMPREENDIMENTOS:
            escrever(pasta, caminho_do_empreendimento(emp), pagina_empreendimento(config, emp, versao))

    # Páginas dos corretores (o Caddy serve /corretor/ no endereço do painel).
    escrever(pasta, "/corretor/", pagina_sem_corretor(config))
    for pessoa in EQUIPE:
        if SLUG_VALIDO.match(pessoa.get("slug") or ""):
            escrever(pasta, f"/corretor/{pessoa['slug']}/", pagina_do_corretor(config, pessoa, imoveis, versao))

    # Páginas de compartilhar (o Caddy serve /imovel/<REF> no endereço do painel).
    escrever(pasta, "/compartilhar/", pagina_sem_corretor(config).replace("Esse endereço de corretor não existe ou mudou.", "Este imóvel não está mais disponível."))
    for imovel in imoveis:
        ref = re.sub(r"[^A-Za-z0-9-]", "", str(imovel.get("referencia") or imovel["codigo"]))
        if ref:
            escrever(pasta, f"/compartilhar/{ref}/", pagina_compartilhar(config, imovel, versao))

    # Fora do ar para o Google até o gestor ligar a opção no painel.
    base = (config.get("endereco_site") or "").rstrip("/")
    if config.get("indexar") and base:
        hoje = date.today().isoformat()
        enderecos = ["/", "/comprar/", "/alugar/", "/sobre/", "/contato/"] + [caminho_do_imovel(i) for i in imoveis]
        if EMPREENDIMENTOS:
            enderecos += ["/empreendimentos/"] + [caminho_do_empreendimento(m) for m in EMPREENDIMENTOS]
        itens = "".join(f"<url><loc>{e(base + href(c))}</loc><lastmod>{hoje}</lastmod></url>" for c in enderecos)
        (pasta / "sitemap.xml").write_text(
            f'<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{itens}</urlset>', encoding="utf-8"
        )
        (pasta / "robots.txt").write_text(f"User-agent: *\nAllow: /\nSitemap: {base}/sitemap.xml\n", encoding="utf-8")
    else:
        (pasta / "robots.txt").write_text("User-agent: *\nDisallow: /\n", encoding="utf-8")


def main():
    argumentos = argparse.ArgumentParser(description="Gera o site da imobiliária.")
    argumentos.add_argument("--saida", required=True, type=Path)
    argumentos.add_argument("--forcar", action="store_true", help="refaz mesmo sem mudanças")
    opcoes_linha = argumentos.parse_args()
    saida = opcoes_linha.saida.resolve()

    codigo = hashlib.sha256()
    for arquivo in ("gerar.py", "estilo.css", "site.js"):
        codigo.update((AQUI / arquivo).read_bytes())

    # Conferência leve (roda a cada minuto): sem mudança no banco nem no código, nem baixa os dados.
    marca_remota = saida.parent / f"{saida.name}.remoto"
    try:
        chave = f"{chamar('site_versao')}:{codigo.hexdigest()}"
    except Exception:
        chave = None
    if not opcoes_linha.forcar and chave and saida.exists() and marca_remota.exists() and marca_remota.read_text().strip() == chave:
        return 0

    try:
        dados = buscar_dados()
    except Exception as erro:
        print(f"Não foi possível ler os dados; o site continua como está: {erro}", file=sys.stderr)
        return 1
    if not dados.get("imoveis"):
        print("O banco devolveu zero imóveis; o site continua como está.", file=sys.stderr)
        return 1

    resumo = hashlib.sha256()
    resumo.update(json.dumps(dados, sort_keys=True, ensure_ascii=False).encode("utf-8"))
    resumo.update(codigo.digest())
    versao = resumo.hexdigest()[:12]
    marca = saida.parent / f"{saida.name}.versao"
    if not opcoes_linha.forcar and saida.exists() and marca.exists() and marca.read_text().strip() == versao:
        if chave:
            marca_remota.write_text(chave)
        return 0

    nova = saida.parent / f"{saida.name}.nova"
    anterior = saida.parent / f"{saida.name}.anterior"
    shutil.rmtree(nova, ignore_errors=True)
    nova.mkdir(parents=True)
    gerar(dados, nova, versao)
    shutil.rmtree(anterior, ignore_errors=True)
    if saida.exists():
        saida.rename(anterior)
    nova.rename(saida)
    marca.write_text(versao)
    if chave:
        marca_remota.write_text(chave)
    print(f"Site publicado: {len(dados['imoveis'])} imóveis, versão {versao}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
