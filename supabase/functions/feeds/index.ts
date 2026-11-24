// Feeds dos portais, gerados pelo próprio sistema a partir do estoque.
//   POST /functions/v1/feeds   { portal?: "grupo_olx", quem?: uuid, automatica?: boolean }
//   Cabeçalho: x-avisos-chave (o mesmo das outras funções internas)
//
// Para cada portal ligado: confere os imóveis disponíveis, monta o XML no
// formato do portal (hoje o VRSync do Grupo OLX: ZAP, Viva Real e OLX), grava no
// bucket público "feeds" (<token>/<arquivo>) e registra o resultado, o
// histórico e os imóveis que ficaram de fora com o motivo.
// Também procura o CEP dos imóveis sem CEP (consulta pública ViaCEP) e avisa os
// gestores quando um portal ligado passa 24 h sem atualizar ou dá erro.
import { confereChave, json } from "../_shared/acesso.ts";
import { banco, exigir } from "../_shared/banco.ts";
import { notificar } from "../_shared/notificacoes.ts";

import { type Ajuste, type Contato, feedVrsync, type Imovel, listingVrsync, type Portal, somenteDigitos } from "./vrsync.ts";

const BUCKET = "feeds";
const SITE_PADRAO = "https://site.lfg.jojodigitals.com";
const CEP_POR_RODADA = 60;

// --- CEP automático -------------------------------------------------------

const semAcento = (t: string) => t.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();

async function procurarCep(i: Imovel): Promise<string | null> {
  const rua = (i.endereco ?? "").replace(/,.*$/, "").replace(/\s+/g, " ").trim();
  if (rua.length < 3 || !i.cidade || !i.uf) return null;
  const url = `https://viacep.com.br/ws/${encodeURIComponent(i.uf)}/${encodeURIComponent(i.cidade)}/${encodeURIComponent(rua)}/json/`;
  const resposta = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!resposta.ok) return null;
  const resultado = await resposta.json().catch(() => []) as { cep?: string; bairro?: string }[];
  // CEPs com final 900 a 999 são de grandes clientes e caixas postais, não do endereço.
  const lista = Array.isArray(resultado) ? resultado.filter((l) => Number(somenteDigitos(l.cep).slice(5)) < 900) : [];
  if (!lista.length) return null;
  const bairro = semAcento(i.bairro ?? "");
  const doBairro = lista.filter((l) => bairro && semAcento(l.bairro ?? "") === bairro);
  const candidatos = new Set((doBairro.length ? doBairro : lista).map((l) => l.cep).filter(Boolean));
  // Só usa quando não há dúvida: um CEP só para a rua (no bairro).
  if (candidatos.size !== 1) return null;
  const cep = somenteDigitos([...candidatos][0]);
  return cep.length === 8 ? `${cep.slice(0, 5)}-${cep.slice(5)}` : null;
}

async function completarCeps(imoveis: Imovel[], ajustes: Map<string, Ajuste>) {
  const faltando = imoveis.filter((i) => {
    const a = ajustes.get(i.codigo);
    if (a?.cep || somenteDigitos(i.cep).length === 8) return false;
    return !a?.cep_tentado_em || Date.now() - new Date(a.cep_tentado_em).getTime() > 30 * 86400000;
  }).slice(0, CEP_POR_RODADA);
  const fila = [...faltando];
  const trabalhar = async () => {
    for (let i = fila.shift(); i; i = fila.shift()) {
      let cep: string | null = null;
      try {
        cep = await procurarCep(i);
      } catch (erro) {
        console.warn(`CEP não consultado para ${i.referencia}`, erro);
      }
      const atual = ajustes.get(i.codigo);
      const linha = { imovel_codigo: i.codigo, cep: cep ?? atual?.cep ?? null, cep_automatico: !!cep, cep_tentado_em: new Date().toISOString() };
      const { error } = await banco.from("imoveis_ajustes_portal").upsert(linha, { onConflict: "imovel_codigo" });
      if (error) console.warn("Ajuste de CEP não gravado", error.message);
      else ajustes.set(i.codigo, { imovel_codigo: i.codigo, cep: linha.cep, titulo: atual?.titulo ?? null, cep_tentado_em: linha.cep_tentado_em });
    }
  };
  await Promise.all(Array.from({ length: 6 }, trabalhar));
  return faltando.length;
}

// --- Rodada ---------------------------------------------------------------

async function atualizarPortal(portal: Portal, imoveis: Imovel[], ajustes: Map<string, Ajuste>, contato: Contato, quem: string | null, automatica: boolean) {
  const inicio = new Date().toISOString();
  const { data: historico } = await banco.from("portal_atualizacoes")
    .insert({ portal_id: portal.id, iniciada_em: inicio, quem, automatica }).select("id").single();
  try {
    if (portal.formato !== "vrsync") throw new Error("Este portal ainda não tem integração.");
    if (!contato.email) throw new Error("Falta o e-mail da imobiliária (Site → Dados e contatos), obrigatório no feed.");
    const listings: string[] = [];
    const problemas: { portal_id: string; imovel_codigo: string; motivos: string[] }[] = [];
    for (const i of imoveis) {
      const { xml, motivos } = listingVrsync(i, ajustes.get(i.codigo), portal, contato);
      if (xml) listings.push(xml);
      else problemas.push({ portal_id: portal.id, imovel_codigo: i.codigo, motivos });
    }
    if (!listings.length) throw new Error("Nenhum imóvel passou na conferência. Veja a lista de problemas.");
    const conteudo = new TextEncoder().encode(feedVrsync(listings, contato));
    exigir(await banco.storage.from(BUCKET).upload(`${portal.token}/${portal.arquivo}`, conteudo, {
      contentType: "application/xml; charset=utf-8", upsert: true, cacheControl: "300",
    }), "gravar o feed");

    exigir(await banco.from("portal_problemas").delete().eq("portal_id", portal.id), "limpar problemas");
    if (problemas.length) exigir(await banco.from("portal_problemas").insert(problemas), "gravar problemas");
    const mensagem = `Atualizado com sucesso – ${listings.length} imóve${listings.length === 1 ? "l enviado" : "is enviados"}`
      + (problemas.length ? `; ${problemas.length} ficaram de fora` : "");
    const agora = new Date().toISOString();
    await banco.from("portais").update({
      ultima_atualizacao: agora, ultimo_resultado: "ok", ultima_mensagem: mensagem,
      enviados: listings.length, com_problema: problemas.length, atualizando_desde: null,
    }).eq("id", portal.id);
    if (historico) await banco.from("portal_atualizacoes").update({ terminada_em: agora, enviados: listings.length, com_problema: problemas.length, resultado: "ok", mensagem }).eq("id", historico.id);
    return { portal: portal.id, ok: true, enviados: listings.length, com_problema: problemas.length };
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    console.error(`Feed ${portal.id} falhou`, mensagem);
    const agora = new Date().toISOString();
    await banco.from("portais").update({ ultimo_resultado: "erro", ultima_mensagem: mensagem, atualizando_desde: null }).eq("id", portal.id);
    if (historico) await banco.from("portal_atualizacoes").update({ terminada_em: agora, resultado: "erro", mensagem }).eq("id", historico.id);
    return { portal: portal.id, ok: false, erro: mensagem };
  }
}

// Portal ligado sem atualizar há 24 h ou com erro: avisa os gestores (uma vez por dia).
async function avisarPortaisParados() {
  const portais = exigir(await banco.from("portais").select("*").eq("ativo", true), "ler portais") as Portal[];
  const dia = 24 * 3600 * 1000;
  for (const p of portais) {
    const parado = !p.ultima_atualizacao || Date.now() - new Date(p.ultima_atualizacao).getTime() > dia;
    if (!parado && p.ultimo_resultado !== "erro") continue;
    if (p.avisado_em && Date.now() - new Date(p.avisado_em).getTime() < dia) continue;
    const gestores = (exigir(await banco.from("corretores").select("id").eq("papel", "gestor").eq("ativo", true), "ler gestores") as { id: string }[]).map((g) => g.id);
    await notificar(gestores, {
      titulo: `Portal ${p.nome}: ${p.ultimo_resultado === "erro" ? "erro no feed" : "sem atualizar há mais de 24 h"}`,
      texto: "Abra Portais no painel para ver o motivo e atualizar.",
      url: "/#portais",
      tag: `portal-${p.id}`,
    }).catch((erro) => console.warn("Aviso do portal não saiu", erro));
    await banco.from("portais").update({ avisado_em: new Date().toISOString() }).eq("id", p.id);
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ erro: "Use POST." }, 405);
  if (!(await confereChave("avisos", req.headers.get("x-avisos-chave")))) return json({ erro: "Chave inválida." }, 401);
  const corpo = await req.json().catch(() => ({})) as { portal?: string | null; quem?: string | null; automatica?: boolean };

  try {
    let consulta = banco.from("portais").select("*").eq("ativo", true).not("formato", "is", null).order("ordem");
    if (corpo.portal) consulta = consulta.eq("id", corpo.portal);
    const portais = exigir(await consulta, "ler portais") as Portal[];
    if (!portais.length) return json({ ok: true, portais: [] });

    const [rImoveis, rAjustes, rSite, rEmpresa] = await Promise.all([
      banco.from("imoveis").select(
        "codigo, referencia, tipo, categoria, venda, locacao, valor_venda, valor_locacao, valor_condominio, valor_iptu, dormitorios, suites, banheiros, vagas, " +
        "area_construida, area_terreno, area_util, endereco, numero, complemento, bairro, cidade, uf, cep, latitude, longitude, titulo, descricao, link_site, fotos, " +
        "aceita_pet, mobiliado, caracteristicas, captador",
      ).eq("ativo", true).is("rascunho_de", null).order("referencia"),
      banco.from("imoveis_ajustes_portal").select("imovel_codigo, cep, titulo, cep_tentado_em"),
      banco.from("configuracoes").select("valor").eq("chave", "site").maybeSingle(),
      banco.from("configuracoes").select("valor").eq("chave", "empresa").maybeSingle(),
    ]);
    const imoveis = exigir(rImoveis, "ler imóveis") as Imovel[];
    const ajustes = new Map((exigir(rAjustes, "ler ajustes") as Ajuste[]).map((a) => [a.imovel_codigo, a]));
    const site = (rSite.data?.valor ?? {}) as { email?: string; telefones?: string[]; endereco_site?: string; nome?: string };
    const empresa = (rEmpresa.data?.valor ?? {}) as { nome?: string };
    const contato: Contato = {
      nome: (empresa.nome || site.nome || "Imobiliária").trim(),
      email: (site.email ?? "").trim(),
      telefone: (site.telefones ?? [])[0] ?? "",
      site: (site.endereco_site || SITE_PADRAO).replace(/\/$/, ""),
    };

    const consultados = await completarCeps(imoveis, ajustes);
    const resultados = [];
    for (const portal of portais) resultados.push(await atualizarPortal(portal, imoveis, ajustes, contato, corpo.quem ?? null, !!corpo.automatica));
    if (corpo.automatica) await avisarPortaisParados();
    return json({ ok: true, ceps_consultados: consultados, portais: resultados });
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    console.error("Feeds falharam", mensagem);
    await banco.from("portais").update({ atualizando_desde: null, ultimo_resultado: "erro", ultima_mensagem: mensagem })
      .eq("ativo", true).not("atualizando_desde", "is", null);
    return json({ erro: mensagem }, 500);
  }
});
