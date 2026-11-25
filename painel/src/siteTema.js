// Aparência do site da imobiliária: a mesma conta do gerador (vps/site/gerar.py),
// para a prévia do painel sair igual ao site publicado.
import { nomeTipo } from "./comum.jsx";

export const CORES_PADRAO = { principal: "#003654", secundaria: "#005d92", destaque: "#94bf0b", fundo: "#f5f8fa" };

export const PAPEIS_DAS_CORES = [
  ["principal", "Principal", "Títulos, preços, menu e rodapé"],
  ["destaque", "Destaque", "Botões e números em destaque"],
  ["secundaria", "Links", "Links e quadros ao passar o mouse"],
  ["fundo", "Fundo", "Fundo das páginas"],
];

export const FONTES = {
  moderna: { nome: "Moderna", descricao: "Títulos largos e marcantes", familias: ["Unbounded:wght@500;700", "Manrope:wght@400;500;600;700;800"], titulo: '"Unbounded"', texto: '"Manrope"' },
  classica: { nome: "Clássica", descricao: "Títulos com serifa, mais tradicionais", familias: ["Playfair+Display:wght@500;700", "Manrope:wght@400;500;600;700;800"], titulo: '"Playfair Display", Georgia', texto: '"Manrope"' },
  simples: { nome: "Simples", descricao: "A mesma letra em tudo, mais discreta", familias: ["Manrope:wght@400;500;600;700;800"], titulo: '"Manrope"', texto: '"Manrope"' },
};

export const BOTOES_PADRAO = {
  topo: "WhatsApp",
  busca: "Buscar imóveis",
  interesse: "Quero saber mais",
  sobre: "Conheça a imobiliária",
  contato: "Conversar no WhatsApp",
};

export const SECOES_PADRAO = [
  { id: "destaques", visivel: true, titulo: "Imóveis em destaque" },
  { id: "empreendimentos", visivel: true, titulo: "Lançamentos e empreendimentos" },
  { id: "numeros", visivel: true },
  { id: "bairros", visivel: true, titulo: "Bairros para começar" },
  { id: "chamadas", visivel: true },
  { id: "sobre", visivel: true, titulo: "" },
  { id: "equipe", visivel: true, titulo: "Nossa equipe" },
];

export const NOME_DA_SECAO = {
  destaques: ["Imóveis em destaque", "Os imóveis escolhidos abaixo, completados com os mais recentes com boas fotos"],
  empreendimentos: ["Empreendimentos", "O primeiro empreendimento ativo numa faixa larga com foto, e até mais 3 em cartões (cadastro em Empreendimentos)"],
  numeros: ["Números do estoque", "Faixa escura com quantos imóveis há para comprar e alugar, lançamentos e bairros"],
  bairros: ["Bairros para começar", "Os 4 bairros com mais imóveis, com foto; cada um abre a lista daquele bairro"],
  chamadas: ["Vender ou alugar · Não achou?", "Dois blocos que abrem o WhatsApp: um para quem quer anunciar, outro para quem não achou o imóvel"],
  sobre: ["Sobre a imobiliária", "O primeiro parágrafo do texto Sobre e a lista de serviços"],
  equipe: ["Nossa equipe", "Foto, nome e CRECI da equipe ativa, em carrossel (vem de Meu perfil)"],
};

export const TEXTO_CONTATO_PADRAO = "Pelo WhatsApp a gente responde a qualquer hora. O escritório atende em horário comercial.";

const COR_VALIDA = /^#[0-9a-f]{6}$/i;
export const corValida = (valor) => COR_VALIDA.test(String(valor ?? "").trim());

export function cor(config, chave) {
  const valor = String(config.cores?.[chave] ?? "").trim();
  return corValida(valor) ? valor.toLowerCase() : CORES_PADRAO[chave];
}

const rgb = (hexa) => [1, 3, 5].map((i) => parseInt(hexa.slice(i, i + 2), 16));

export function misturar(hexa, outra, peso) {
  const b = rgb(outra);
  return `#${rgb(hexa).map((a, i) => Math.round(a * (1 - peso) + b[i] * peso).toString(16).padStart(2, "0")).join("")}`;
}

function luminancia(hexa) {
  const [r, g, b] = rgb(hexa).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contraste(uma, outra) {
  const [clara, escura] = [luminancia(uma), luminancia(outra)].sort((a, b) => b - a);
  return (clara + 0.05) / (escura + 0.05);
}

export function tintaSobre(fundo) {
  const escura = misturar(fundo, "#000000", 0.8);
  return contraste(fundo, escura) >= contraste(fundo, "#ffffff") ? escura : "#ffffff";
}

export function opcoesDaAbertura(config) {
  const escurecer = Number(config.abertura?.escurecer);
  return {
    escurecer: Number.isFinite(escurecer) ? Math.min(95, Math.max(0, Math.round(escurecer))) : 92,
    centro: config.abertura?.alinhamento === "centro",
    busca: config.abertura?.mostrar_busca !== false,
  };
}

export function secoesDaInicial(config) {
  const conhecidas = Object.fromEntries(SECOES_PADRAO.map((s) => [s.id, s]));
  const escolhidas = (config.secoes ?? []).filter((s) => conhecidas[s?.id]).map((s) => ({ ...conhecidas[s.id], ...s }));
  const vistas = new Set(escolhidas.map((s) => s.id));
  // Seção nova entra logo depois dos destaques (igual ao gerador do site).
  if (escolhidas.length && !vistas.has("empreendimentos")) {
    const depois = escolhidas.findIndex((s) => s.id === "destaques") + 1;
    escolhidas.splice(depois, 0, { ...conhecidas.empreendimentos });
    vistas.add("empreendimentos");
  }
  // Bairros logo depois dos números; os dois blocos de WhatsApp antes do Sobre.
  if (escolhidas.length) {
    for (const [nova, vizinha, depois] of [["bairros", "numeros", true], ["chamadas", "sobre", false]]) {
      if (vistas.has(nova)) continue;
      const n = escolhidas.findIndex((s) => s.id === vizinha);
      escolhidas.splice(n < 0 ? escolhidas.length : n + (depois ? 1 : 0), 0, { ...conhecidas[nova] });
      vistas.add(nova);
    }
  }
  return [...escolhidas, ...SECOES_PADRAO.filter((s) => !vistas.has(s.id))];
}

export function temaDoSite(config) {
  const [principal, secundaria, destaque, fundo] = ["principal", "secundaria", "destaque", "fundo"].map((c) => cor(config, c));
  const fonte = FONTES[config.fonte] ?? FONTES.moderna;
  const [r, g, b] = rgb(principal);
  const variaveis = {
    "--marinho": principal,
    "--marinho-fundo": misturar(principal, "#000000", 0.5),
    "--azul": secundaria,
    "--limao": destaque,
    "--limao-tinta": tintaSobre(destaque),
    "--fundo": fundo,
    "--linha": `rgba(${r}, ${g}, ${b}, 0.13)`,
    "--fonte-titulo": `${fonte.titulo}, "Segoe UI", system-ui, sans-serif`,
    "--fonte-texto": `${fonte.texto}, "Segoe UI", system-ui, sans-serif`,
  };
  return {
    css: `:root { ${Object.entries(variaveis).map(([k, v]) => `${k}: ${v};`).join(" ")} }`,
    fontes: `https://fonts.googleapis.com/css2?${fonte.familias.map((f) => `family=${f}`).join("&")}&display=swap`,
  };
}

export function fundoDaAbertura(config, imagem) {
  if (!imagem) return "";
  const forca = opcoesDaAbertura(config).escurecer / 100;
  const escura = rgb(misturar(cor(config, "principal"), "#000000", 0.5));
  const principal = rgb(cor(config, "principal"));
  return `background-image: linear-gradient(100deg, rgba(${escura.join(",")},${forca.toFixed(2)}) 20%, rgba(${principal.join(",")},${(forca * 0.6).toFixed(2)})), url('${imagem}')`;
}

// O que pode ficar difícil de ler com as cores escolhidas.
export function avisosDeCor(config) {
  const [principal, secundaria, destaque, fundo] = ["principal", "secundaria", "destaque", "fundo"].map((c) => cor(config, c));
  const avisos = [];
  if (contraste(principal, "#ffffff") < 4.5) avisos.push("A cor principal está clara demais: títulos, preços e o menu ficam difíceis de ler no fundo branco.");
  if (contraste(secundaria, "#ffffff") < 4.5) avisos.push("A cor dos links está clara demais para ler no fundo branco.");
  if (contraste(destaque, principal) < 2.5) avisos.push("A cor de destaque some em cima da cor principal (nos números do estoque).");
  if (contraste(fundo, "#0b2233") < 7) avisos.push("O fundo está escuro demais para o texto das páginas.");
  if (contraste(destaque, tintaSobre(destaque)) < 4.5) avisos.push("O texto dos botões fica com pouco contraste nessa cor de destaque.");
  return avisos;
}

// ----- Prévia: as mesmas classes do gerador, com o estilo publicado do site -----

// Uma vez por abertura do painel: pega o estilo mais novo sem baixar de novo a cada letra.
const MARCA_DA_PREVIA = Date.now();
const esc = (texto) => String(texto ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const dinheiro = (valor) => `R$ ${Math.round(Number(valor)).toLocaleString("pt-BR")}`;
const positivo = (n) => (Number(n) > 0 ? Number(n) : null);

function cartao(i) {
  const foto = i.foto_mini || i.foto_principal;
  const aluguel = !i.venda || !positivo(i.valor_venda);
  const preco = !aluguel ? dinheiro(i.valor_venda) : positivo(i.valor_locacao) ? `${dinheiro(i.valor_locacao)}/mês` : "Consulte";
  const area = positivo(i.area_construida) ?? positivo(i.area_util) ?? positivo(i.area_terreno);
  const quartos = Number(i.dormitorios) || 0;
  const titulo = quartos ? `${nomeTipo(i.tipo)} com ${quartos} quarto${quartos === 1 ? "" : "s"}` : nomeTipo(i.tipo);
  const dados = [
    quartos && `${quartos} quarto${quartos === 1 ? "" : "s"}`,
    i.vagas && `${i.vagas} vaga${i.vagas === 1 ? "" : "s"}`,
    area && `${Math.round(area).toLocaleString("pt-BR")} m²`,
  ].filter(Boolean).map((d) => `<span>${esc(d)}</span>`).join("");
  return `<a class="cartao" href="#"><span class="cartao-foto">${foto ? `<img src="${esc(foto)}" alt="">` : '<span class="sem-foto">Sem foto</span>'}</span>
<span class="cartao-corpo"><span class="cartao-bairro">${esc(i.bairro)}</span><span class="cartao-titulo">${esc(titulo)}</span><b class="cartao-preco">${esc(preco)}</b><span class="cartao-dados">${dados}</span><span class="cartao-ref">${esc(i.referencia)}</span></span></a>`;
}

// Igual a bairros_em_destaque do gerador: bairros com 3 ou mais imóveis, com foto de casa primeiro.
function bairrosEmDestaque(imoveis, limite = 4) {
  const grupos = new Map();
  for (const i of imoveis) if (i.bairro) grupos.set(i.bairro, [...(grupos.get(i.bairro) ?? []), i]);
  const ordemDoTipo = { CASA: 0, SOBRADO: 0, "TWO STORY HOUSE": 0, APARTAMENTO: 1 };
  const escolhidos = [];
  for (const [bairro, lista] of [...grupos].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
    const comFoto = lista.filter((i) => i.foto_principal).sort((a, b) => (ordemDoTipo[a.tipo] ?? 2) - (ordemDoTipo[b.tipo] ?? 2) || (b.fotos?.length ?? 0) - (a.fotos?.length ?? 0));
    if (lista.length < 3 || !comFoto.length) continue;
    escolhidos.push({ bairro, total: lista.length, foto: comFoto[0].foto_mini || comFoto[0].foto_principal });
    if (escolhidos.length >= limite) break;
  }
  return escolhidos;
}

const paragrafos = (texto) =>
  String(texto ?? "").trim().split(/\n\s*\n/).filter((p) => p.trim()).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");

function pessoaDaEquipe(p) {
  const partes = String(p.nome ?? "").trim().split(/\s+/).filter(Boolean);
  const letras = (partes[0]?.[0] ?? "") + (partes.length > 1 ? partes.at(-1)[0] : "");
  const creci = String(p.creci ?? "").trim();
  // No site, só nome e CRECI: o cargo fica no sistema.
  const linha = creci ? (/^creci/i.test(creci) ? creci : `CRECI ${creci}`) : "";
  const foto = p.foto_url ? `<img class="pessoa-foto" src="${esc(p.foto_url)}" alt="">` : `<span class="pessoa-foto sem-retrato">${esc(letras.toUpperCase() || "?")}</span>`;
  return `<li class="pessoa">${foto}<b>${esc(p.nome)}</b>${linha ? `<span>${esc(linha)}</span>` : ""}</li>`;
}

export function montarPrevia(config, imoveis, enderecoDoEstilo, equipe = []) {
  const { css, fontes } = temaDoSite(config);
  const abertura = opcoesDaAbertura(config);
  const botao = (chave) => config.botoes?.[chave]?.trim() || BOTOES_PADRAO[chave];
  const quantidade = Math.min(12, Math.max(3, Number(config.quantidade_destaques) || 6));
  const pedidos = (config.destaques ?? []).map((r) => String(r).toUpperCase());
  const porReferencia = new Map(imoveis.map((i) => [String(i.referencia).toUpperCase(), i]));
  const escolhidos = pedidos.map((r) => porReferencia.get(r)).filter(Boolean);
  for (const i of imoveis) {
    if (escolhidos.length >= quantidade) break;
    if (!escolhidos.includes(i) && (i.fotos?.length ?? 0) >= 5) escolhidos.push(i);
  }
  const destaques = escolhidos.slice(0, quantidade);
  const fundo = config.banner_url || destaques.find((i) => i.foto_principal)?.foto_principal || "";
  const venda = imoveis.filter((i) => i.venda).length;
  const locacao = imoveis.filter((i) => i.locacao).length;
  const totalBairros = new Set(imoveis.map((i) => i.bairro).filter(Boolean)).size;
  const [cr, cg, cb] = rgb(misturar(cor(config, "principal"), "#000000", 0.5));
  const selo = ["Campo Grande (MS)", config.creci].filter(Boolean).join(" · ");

  const chamada = abertura.busca
    ? `<form class="procura" onsubmit="return false"><fieldset class="procura-abas"><label><input type="radio" name="f" checked><span class="procura-aba">Comprar</span></label><label><input type="radio" name="f"><span class="procura-aba">Alugar</span></label><a class="procura-aba" href="#">Lançamentos</a></fieldset>
<div class="procura-campos"><label class="procura-campo"><span>Bairro</span><select><option>Todos os bairros</option></select></label><label class="procura-campo"><span>Tipo</span><select><option>Todos os tipos</option></select></label><label class="procura-campo"><span>Até</span><select><option>Qualquer valor</option></select></label><button class="botao procura-botao" type="button">${esc(botao("busca"))}</button></div></form>`
    : '<p class="abertura-botoes"><a class="botao" href="#">Imóveis para comprar</a> <a class="botao claro" href="#">Imóveis para alugar</a></p>';

  const secoes = secoesDaInicial(config).filter((s) => s.visivel !== false).map((s) => {
    if (s.id === "destaques") {
      return `<section class="largura secao"><div class="secao-cabeca"><div><h2>${esc(s.titulo || "Imóveis em destaque")}</h2><p class="secao-sub">Escolhidos pela equipe, com fotos e dados conferidos.</p></div><a href="#">Ver os ${venda} imóveis</a></div><div class="grade-imoveis destaques">${destaques.map(cartao).join("")}</div></section>`;
    }
    if (s.id === "equipe") {
      return equipe.length ? `<section class="largura secao equipe"><h2>${esc(s.titulo || "Nossa equipe")}</h2>${equipe.length > 4 ? `<div class="carrossel"><div class="carrossel-janela"><ul class="carrossel-trilho">${equipe.map(pessoaDaEquipe).join("")}</ul></div></div>` : `<ul class="grade-equipe">${equipe.map(pessoaDaEquipe).join("")}</ul>`}</section>` : "";
    }
    if (s.id === "empreendimentos") {
      return `<section class="largura secao"><div class="secao-cabeca"><h2>${esc(s.titulo || "Lançamentos e empreendimentos")}</h2><a href="#">Ver todos</a></div><div class="faixa-lancamento" style="min-height:260px"><span class="faixa-lancamento-texto"><span class="capa-selo">Lançamento</span><b>O primeiro empreendimento ativo</b><span>Aparece aqui com a foto, o tipo, o bairro e o preço (cadastro em Empreendimentos).</span></span></div></section>`;
    }
    if (s.id === "numeros") {
      const itens = [[venda, "imóveis para comprar"], [locacao, "imóveis para alugar"], [totalBairros, "bairros com imóveis"]];
      return `<section class="faixa-numeros"><div class="largura numeros-grade">${itens.map(([n, t]) => `<div class="numero-item"><b>${n}</b><small>${t}</small></div>`).join("")}</div></section>`;
    }
    if (s.id === "bairros") {
      const bairros = bairrosEmDestaque(imoveis);
      if (bairros.length < 3) return "";
      return `<section class="largura secao"><div class="secao-cabeca"><div><h2>${esc(s.titulo || "Bairros para começar")}</h2><p class="secao-sub">Os bairros com mais opções hoje. Toque para ver o que está disponível.</p></div><a href="#">Ver todos</a></div><div class="bairros-sanfona">${bairros.map((b) => `<a class="bairro-item" href="#"><img src="${esc(b.foto)}" alt=""><span class="bairro-texto"><b>${esc(b.bairro)}</b><small>${b.total} imóve${b.total === 1 ? "l" : "is"}</small></span></a>`).join("")}</div></section>`;
    }
    if (s.id === "chamadas") {
      return `<section class="largura secao chamadas"><div class="chamada-bloco claro"><h2>Quer vender ou alugar o seu imóvel?</h2><p>Conte para a gente como ele é. A equipe avalia, anuncia e acompanha as visitas com você.</p><a class="botao" href="#">Anunciar meu imóvel</a></div><div class="chamada-bloco escuro"><h2>Não achou o que procura?</h2><p>Diga o que você precisa e um corretor procura por você e avisa pelo WhatsApp.</p><a class="botao zap" href="#">Falar com um corretor</a></div></section>`;
    }
    return `<section class="faixa-marca"><div class="largura faixa-grade"><div><h2>${esc(s.titulo || `Sobre a ${config.nome ?? ""}`)}</h2>${paragrafos(String(config.sobre ?? "").split("\n\n")[0])}<a class="botao secundario" href="#">${esc(botao("sobre"))}</a></div><ul class="servicos">${(config.servicos ?? []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div></section>`;
  });
  const telefones = (config.telefones ?? []).map((t) => `<li><a href="#">${esc(t)}</a></li>`).join("");
  // Topo transparente sobre a foto: com a logo da LFG, a versão branca.
  const logo = config.logo_url || `${enderecoDoEstilo}/logo-lfg-branca.png`;
  const capa = `<section class="capa${abertura.centro ? " centro" : ""}" style="--capa-cor: ${cr}, ${cg}, ${cb}; --capa-forca: ${(abertura.escurecer / 100).toFixed(2)}">${fundo ? `<img class="capa-foto" src="${esc(fundo)}" alt="">` : ""}<div class="largura capa-miolo"><p class="capa-selo">${esc(selo)}</p><h1>${esc(config.titulo)}</h1>${config.subtitulo ? `<p class="capa-sub">${esc(config.subtitulo)}</p>` : ""}${chamada}</div></section>`;
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${esc(fontes)}"><link rel="stylesheet" href="${esc(enderecoDoEstilo)}/estilo.css?previa=${MARCA_DA_PREVIA}"><style>${css} html { scroll-behavior: auto; } .topo.sobre-capa { position: absolute; } .capa-foto { animation: none; }</style></head>
<body><header class="topo${config.logo_url ? "" : " sobre-capa"}"><div class="largura topo-linha"><a class="marca" href="#"><img src="${esc(logo)}" alt="${esc(config.nome)}" height="40"></a>
<nav class="menu-principal"><a href="#">Comprar</a><a href="#">Alugar</a><a href="#">Sobre</a><a href="#">Contato</a></nav><a class="botao topo-botao" href="#">${esc(botao("topo"))}</a><button class="menu-botao" type="button"><span class="menu-risco" aria-hidden="true"></span></button></div></header>
<main>${capa}
${secoes.join("\n")}</main>
<footer class="rodape"><div class="largura rodape-grade"><div><b class="rodape-nome">${esc(config.nome)}</b><p>${esc(config.creci)}</p>${config.textos?.rodape?.trim() ? `<p class="rodape-texto">${esc(config.textos.rodape)}</p>` : ""}</div>
<div><b>Escritório</b><p>${esc(config.endereco)}</p><p>${esc(config.horario)}</p></div><div><b>Fale com a gente</b><ul><li><a href="#">WhatsApp</a></li>${telefones}</ul></div></div></footer></body></html>`;
}
