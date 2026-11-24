// Baixar as fotos de um imóvel, com ou sem a marca d'água da empresa.
// As fotos do cadastro próprio ficam guardadas sem marca: a marca é aplicada aqui,
// na hora de baixar, com o tamanho, a posição e a transparência das Configurações gerais.
// As que vêm do Univen já chegam com a marca de lá.
import { zipSync } from "fflate";

export const MARCA_PADRAO = { ativa: true, imagem_url: null, tamanho: 42, posicao: "centro", opacidade: 55 };
export const imagemDaMarca = (marca, empresa) => marca?.imagem_url || empresa?.logo_url || "/logo-lfg.png";

export const podeBaixarSemMarca = (imovel) => imovel.origem === "proprio";

const marcasProntas = new Map();

// A imagem vira uma silhueta branca, como a marca d'água das fotos do Univen.
function carregarMarca(endereco) {
  if (!marcasProntas.has(endereco)) {
    marcasProntas.set(endereco, (async () => {
      const resposta = await fetch(endereco);
      if (!resposta.ok) throw new Error("Não consegui abrir a imagem da marca d'água.");
      const logo = await createImageBitmap(await resposta.blob());
      const tela = document.createElement("canvas");
      tela.width = logo.width;
      tela.height = logo.height;
      const contexto = tela.getContext("2d");
      contexto.drawImage(logo, 0, 0);
      contexto.globalCompositeOperation = "source-in";
      contexto.fillStyle = "#ffffff";
      contexto.fillRect(0, 0, tela.width, tela.height);
      logo.close();
      return tela;
    })());
  }
  return marcasProntas.get(endereco);
}

// Canto escolhido, com uma folga de 4% da largura da foto.
function lugarDaMarca(posicao, foto, largura, altura) {
  const folga = foto.width * 0.04;
  const x = { esquerdo: folga, direito: foto.width - largura - folga }[posicao?.split("_")[1]] ?? (foto.width - largura) / 2;
  const y = { superior: folga, inferior: foto.height - altura - folga }[posicao?.split("_")[0]] ?? (foto.height - altura) / 2;
  return [x, y];
}

async function comMarca(blob, marcaConfig, enderecoDaMarca) {
  const [foto, marca] = await Promise.all([createImageBitmap(blob), carregarMarca(enderecoDaMarca)]);
  const tela = document.createElement("canvas");
  tela.width = foto.width;
  tela.height = foto.height;
  const contexto = tela.getContext("2d");
  contexto.drawImage(foto, 0, 0);
  const largura = foto.width * (marcaConfig.tamanho / 100);
  const altura = (marca.height / marca.width) * largura;
  contexto.globalAlpha = marcaConfig.opacidade / 100;
  contexto.drawImage(marca, ...lugarDaMarca(marcaConfig.posicao, foto, largura, altura), largura, altura);
  foto.close();
  return new Promise((resolver, rejeitar) => {
    tela.toBlob((pronto) => (pronto ? resolver(pronto) : rejeitar(new Error("Não consegui preparar a foto."))), "image/jpeg", 0.9);
  });
}

// Devolve as fotos como arquivos, na ordem do anúncio (REF-01.jpg, REF-02.jpg...).
export async function prepararFotos(imovel, { marcaDagua, empresa, aoProgredir }) {
  const fotos = imovel.fotos ?? [];
  const marcaConfig = { ...MARCA_PADRAO, ...(empresa?.marca ?? {}) };
  const aplicarMarca = marcaDagua && marcaConfig.ativa && podeBaixarSemMarca(imovel);
  const enderecoDaMarca = imagemDaMarca(marcaConfig, empresa);
  const arquivos = [];
  for (const [n, url] of fotos.entries()) {
    aoProgredir?.(n + 1, fotos.length);
    const resposta = await fetch(url);
    if (!resposta.ok) throw new Error(`A foto ${n + 1} não baixou (HTTP ${resposta.status}).`);
    let blob = await resposta.blob();
    if (aplicarMarca) blob = await comMarca(blob, marcaConfig, enderecoDaMarca);
    const nome = `${imovel.referencia}-${String(n + 1).padStart(2, "0")}.jpg`;
    arquivos.push(new File([blob], nome, { type: "image/jpeg" }));
  }
  return arquivos;
}

export async function baixarZip(imovel, arquivos, marcaDagua) {
  const conteudo = {};
  for (const arquivo of arquivos) conteudo[arquivo.name] = new Uint8Array(await arquivo.arrayBuffer());
  // Foto já é comprimida: guardar sem comprimir de novo é mais rápido e dá o mesmo tamanho.
  const zip = zipSync(conteudo, { level: 0 });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([zip], { type: "application/zip" }));
  link.download = `${imovel.referencia}-fotos${marcaDagua ? "" : "-sem-marca"}.zip`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
}

// No celular: salvar na galeria ou mandar pelo WhatsApp direto, sem arquivo .zip.
export const podeCompartilhar = (arquivos) => !!navigator.canShare?.({ files: arquivos.slice(0, 1) });

export function compartilhar(imovel, arquivos) {
  return navigator.share({ files: arquivos, title: `Fotos do imóvel ${imovel.referencia}` });
}
