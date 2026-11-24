import { nomeTipo, reais } from "./comum.jsx";

// O tipo guardado é o mesmo do estoque do Univen (a Thais e o site filtram por
// ele); o prefixo é o começo da referência (CA00743).
export const TIPOS_DE_CADASTRO = [
  { id: "casa", nome: "Casa", tipo: "CASA", prefixo: "CA", finalidade: "RESIDENCIAL" },
  { id: "apartamento", nome: "Apartamento", tipo: "APARTAMENTO", prefixo: "AP", finalidade: "RESIDENCIAL" },
  { id: "terreno", nome: "Terreno", tipo: "TERRENO", prefixo: "TE", finalidade: "RESIDENCIAL" },
  { id: "area", nome: "Área", tipo: "TERRENO", prefixo: "AR", finalidade: "RURAL" },
  { id: "chacara", nome: "Chácara", tipo: "CHACARA", prefixo: "CH", finalidade: "RURAL" },
  { id: "sala", nome: "Sala comercial", tipo: "COMERCIAL", prefixo: "SL", finalidade: "COMERCIAL" },
  { id: "salao", nome: "Salão comercial", tipo: "COMERCIAL", prefixo: "SA", finalidade: "COMERCIAL" },
  { id: "ponto", nome: "Ponto comercial", tipo: "COMERCIAL", prefixo: "PT", finalidade: "COMERCIAL" },
  { id: "barracao", nome: "Barracão", tipo: "BARRACAO", prefixo: "BA", finalidade: "COMERCIAL" },
  { id: "galpao", nome: "Galpão", tipo: "GALPAO", prefixo: "GL", finalidade: "COMERCIAL" },
];

// Mesmas chaves do XML do Univen, que o site já sabe mostrar (vps/site/gerar.py).
export const COMODIDADES_DO_IMOVEL = [
  ["Arcondicionado", "Ar-condicionado"], ["Armariocozinha", "Armários na cozinha"], ["Banheiroauxiliar", "Banheiro auxiliar"],
  ["Copa", "Copa"], ["Gourmet", "Espaço gourmet"], ["Lavanderia", "Lavanderia"], ["Piscina", "Piscina"], ["Porcelanato", "Porcelanato"],
  ["Quintal", "Quintal"], ["Suitemaster", "Suíte master"], ["Varanda", "Varanda"], ["Varandagourmet", "Varanda gourmet"],
];
export const COMODIDADES_DO_LOCAL = [
  ["Alarme", "Alarme"], ["Arealazer", "Área de lazer"], ["Interforne", "Interfone"], ["Murado", "Murado"],
  ["Portaoeletronico", "Portão eletrônico"], ["Portaria24horas", "Portaria 24 horas"], ["Salafesta", "Salão de festas"],
];
export const NOME_DA_COMODIDADE = Object.fromEntries([...COMODIDADES_DO_IMOVEL, ...COMODIDADES_DO_LOCAL]);

export const SITUACOES = [
  ["rascunho", "Rascunho"], ["disponivel", "Disponível"], ["reservado", "Reservado"],
  ["vendido", "Vendido"], ["alugado", "Alugado"], ["inativo", "Inativo"],
];
export const NOME_DA_SITUACAO = Object.fromEntries(SITUACOES);
export const NOME_DA_MOBILIA = { mobiliado: "Mobiliado", semi: "Semimobiliado", sem: "Sem mobília", desconhecido: "Não informado" };
export const NOME_DA_OCUPACAO = { desocupado: "Desocupado", proprietario: "Ocupado pelo proprietário", inquilino: "Ocupado por inquilino", desconhecido: "Não informado" };

const positivo = (n) => (Number(n) > 0 ? Number(n) : null);
export const areaDoImovel = (i) => positivo(i.area_construida) ?? positivo(i.area_util) ?? positivo(i.area_terreno);
export const metros = (n) => `${Number(n).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} m²`;

export function precoDoImovel(i, operacao) {
  if (operacao !== "locacao" && i.venda && positivo(i.valor_venda)) return { operacao: "Venda", valor: reais(i.valor_venda) };
  if (i.locacao && positivo(i.valor_locacao)) return { operacao: "Aluguel", valor: `${reais(i.valor_locacao)}/mês` };
  return { operacao: i.venda ? "Venda" : i.locacao ? "Aluguel" : "—", valor: "Sem valor" };
}

export const cepFormatado = (cep) => {
  const numeros = String(cep ?? "").replace(/D/g, "");
  return numeros.length > 5 ? `${numeros.slice(0, 5)}-${numeros.slice(5, 8)}` : numeros;
};

export const semAcento = (texto) => String(texto ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
export const nomeDeCaptador = (corretor) => corretor.nome_no_univen ?? corretor.nome;
export const ehMinhaCaptacao = (imovel, eu) => semAcento(imovel.captador) !== "" && semAcento(imovel.captador) === semAcento(nomeDeCaptador(eu));

// O mínimo do Grupo OLX para aceitar o anúncio (developers.grupozap.com), mais
// título e preço. O CEP só conta no cadastro próprio: o XML do Univen não traz.
export function avaliarImovel(i) {
  const fotos = i.fotos?.length ?? 0;
  const descricao = (i.descricao ?? "").trim().length;
  const titulo = (i.titulo ?? "").trim().length;
  const regras = [
    { peso: 35, ok: fotos >= 5, falta: fotos ? `Tem ${fotos} foto${fotos === 1 ? "" : "s"}; o mínimo é 5` : "Sem fotos; o mínimo é 5" },
    { peso: 25, ok: descricao >= 50 && descricao <= 3000, falta: descricao > 3000 ? "Descrição acima de 3.000 caracteres" : "Descrição com menos de 50 caracteres" },
    { peso: 20, ok: (i.venda && positivo(i.valor_venda)) || (i.locacao && positivo(i.valor_locacao)), falta: "Sem valor de venda ou aluguel" },
    { peso: 10, ok: !!areaDoImovel(i), falta: "Sem área informada" },
    { peso: 10, ok: titulo >= 10 && titulo <= 100, falta: "Título precisa ter de 10 a 100 caracteres" },
  ];
  if (i.origem === "proprio") regras.push({ peso: 10, ok: !!i.cep, falta: "Sem CEP" });
  const total = regras.reduce((soma, r) => soma + r.peso, 0);
  const nota = Math.round((regras.filter((r) => r.ok).reduce((soma, r) => soma + r.peso, 0) / total) * 100);
  const [rotulo, cor] = nota === 100 ? ["Excelente", "otima"] : nota >= 75 ? ["Bom", "boa"] : nota >= 50 ? ["Regular", "regular"] : ["Fraco", "fraca"];
  return { nota, rotulo, cor, pendencias: regras.filter((r) => !r.ok).map((r) => r.falta) };
}

const contagem = (n, um, varios) => `${n} ${Number(n) === 1 ? um : varios}`;
export const resumoDoImovel = (i) =>
  [i.dormitorios && contagem(i.dormitorios, "quarto", "quartos"), i.vagas && contagem(i.vagas, "vaga", "vagas"), areaDoImovel(i) && metros(areaDoImovel(i))].filter(Boolean).join(" · ");

export function textoParaWhatsapp(i) {
  const { valor } = precoDoImovel(i);
  const dados = resumoDoImovel(i);
  return [`*${nomeTipo(i.tipo)} · ${i.bairro ?? ""}* (${i.referencia})`, [valor, dados].filter(Boolean).join(" · "), i.link_site].filter(Boolean).join("\n");
}

// Abre direto no Excel: separador ";" e marca de UTF-8 no começo.
export function baixarPlanilha(imoveis) {
  const celula = (valor) => `"${String(valor ?? "").replace(/"/g, '""')}"`;
  const titulos = ["Referência", "Tipo", "Situação", "Venda", "Aluguel", "Condomínio", "IPTU", "Rua", "Número", "Bairro", "Cidade", "Quartos", "Suítes", "Banheiros", "Vagas", "Área construída", "Terreno", "Captador", "Qualidade", "Fotos", "Link"];
  const linhas = imoveis.map((i) => [
    i.referencia, nomeTipo(i.tipo), NOME_DA_SITUACAO[i.situacao], i.valor_venda, i.valor_locacao, i.valor_condominio, i.valor_iptu, i.endereco, i.numero, i.bairro, i.cidade,
    i.dormitorios, i.suites, i.banheiros, i.vagas, i.area_construida, i.area_terreno, i.captador, avaliarImovel(i).rotulo, i.fotos?.length ?? 0, i.link_site,
  ].map(celula).join(";"));
  const arquivo = new Blob(["﻿", [titulos.map(celula).join(";"), ...linhas].join("\r\n")], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(arquivo);
  link.download = `imoveis-lfg-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

// Miniatura das fotos que estão no nosso armazenamento; as do Univen não têm.
export const miniDaFoto = (url) => (url?.includes("/object/public/imoveis/") ? url.replace(/\.jpg$/, "-mini.jpg") : url);

// A foto vai reduzida do próprio aparelho: envio mais rápido e site mais leve.
export async function reduzirFoto(arquivo, maiorLado, qualidade) {
  const imagem = await createImageBitmap(arquivo);
  const escala = Math.min(1, maiorLado / Math.max(imagem.width, imagem.height));
  const tela = document.createElement("canvas");
  tela.width = Math.round(imagem.width * escala);
  tela.height = Math.round(imagem.height * escala);
  tela.getContext("2d").drawImage(imagem, 0, 0, tela.width, tela.height);
  imagem.close();
  return new Promise((resolver, rejeitar) => {
    tela.toBlob((blob) => (blob ? resolver(blob) : rejeitar(new Error("Não consegui preparar a foto."))), "image/jpeg", qualidade);
  });
}
