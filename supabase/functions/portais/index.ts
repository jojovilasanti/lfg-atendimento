// Leads dos portais. Hoje só o Grupo OLX (ZAP Imóveis, Viva Real e OLX), que manda
// cada lead por POST para o endereço homologado do CRM:
//   POST /functions/v1/portais/grupo-olx
//   Authorization: Basic base64(usuario:CHAVE)  (CHAVE no .env.local; hash em chaves_acesso "grupo_olx")
//
// Para cada lead:
// - guarda o pedido inteiro em leads_portais (o mesmo originLeadId não roda duas vezes);
// - clique no WhatsApp ou telefone visto: registra no imóvel (cliques_whatsapp) e
//   avisa o captador; sem captador, os gestores;
// - com telefone: cria ou acha o lead e a Thais faz o pré-atendimento pelo modelo
//   aprovado da Meta. Se o cliente já está em conversa ou com corretor, não manda.
//   Se o modelo não sair, o lead vai direto ao captador e ao rodízio (oferecer_lead);
// - repassa o mesmo pedido ao Univen (configuracoes.portais), para ele seguir
//   recebendo durante a transição. Falhas ficam registradas e são tentadas de novo.
//
// Responde 200 na hora e processa depois: o Grupo OLX espera no máximo 30 s.
import { confereChave, json } from "../_shared/acesso.ts";
import { banco, exigir } from "../_shared/banco.ts";
import { notificar } from "../_shared/notificacoes.ts";
import { normalizarWhatsapp, variantesWhatsapp } from "../_shared/telefone.ts";
import { enviarModelo } from "../_shared/whatsapp.ts";

declare const EdgeRuntime: { waitUntil(promessa: Promise<unknown>): void };

const NOME_DO_TIPO: Record<string, string> = {
  CLICK_WHATSAPP: "clicou no WhatsApp",
  PHONE_VIEW: "viu o telefone",
  CONTACT_FORM: "mandou o formulário",
  CONTACT_CHAT: "abriu o chat",
  VISIT_REQUEST: "pediu visita",
  CLICK_SCHEDULE: "quis agendar",
};
const CLIQUES = new Set(["CLICK_WHATSAPP", "PHONE_VIEW"]);
const TIPOS_DE_IMOVEL: Record<string, string> = {
  CASA: "casa", APARTAMENTO: "apartamento", TERRENO: "terreno", CHACARA: "chácara", SALAO: "salão", BARRACAO: "barracão",
  SALA: "sala", GALPAO: "galpão", PONTO: "ponto comercial", AREA: "área", COMERCIAL: "imóvel comercial",
};
const JANELA_MS = 24 * 3600 * 1000;
const MAX_TENTATIVAS_REPASSE = 5;

type PedidoGrupoOlx = {
  leadOrigin?: string; timestamp?: string; originLeadId?: string; originListingId?: string; clientListingId?: string;
  name?: string; email?: string; ddd?: string; phone?: string; phoneNumber?: string; message?: string;
  temperature?: string; transactionType?: string; extraData?: { leadType?: string } & Record<string, unknown>;
};
type Imovel = { codigo: string; referencia: string | null; tipo: string | null; bairro: string | null; titulo: string | null; captador: string | null };
type Registro = { id: number; portal: string; pedido: PedidoGrupoOlx; tipo: string | null; nome: string | null; email: string | null; telefone: string | null; mensagem: string | null; recebido_em: string };

const texto = (valor: unknown) => (typeof valor === "string" && valor.trim() ? valor.trim() : null);
const semAcento = (valor: string) => valor.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
const resumir = (valor: string, limite: number) => {
  const limpo = valor.replace(/\s+/g, " ").trim();
  return limpo.length > limite ? `${limpo.slice(0, limite - 1)}…` : limpo;
};

async function config(): Promise<{ grupo_olx?: { ativo?: boolean; repassar_para?: string }; pre_atendimento?: { modelo?: string; texto?: string } }> {
  return ((await banco.from("configuracoes").select("valor").eq("chave", "portais").maybeSingle()).data?.valor ?? {}) as never;
}

// A chave vem no Authorization: Basic base64(usuario:CHAVE). O usuário não importa.
async function autorizado(req: Request): Promise<boolean> {
  const cabecalho = req.headers.get("authorization") ?? "";
  if (!/^basic\s+/i.test(cabecalho)) return false;
  let decodificado = "";
  try {
    decodificado = atob(cabecalho.replace(/^basic\s+/i, "").trim());
  } catch {
    return false;
  }
  const senha = decodificado.includes(":") ? decodificado.slice(decodificado.indexOf(":") + 1) : decodificado;
  return confereChave("grupo_olx", senha);
}

async function acharImovel(codigo: string | null): Promise<Imovel | null> {
  if (!codigo) return null;
  const colunas = "codigo, referencia, tipo, bairro, titulo, captador";
  const porCodigo = exigir(await banco.from("imoveis").select(colunas).eq("codigo", codigo).maybeSingle(), "achar imóvel") as Imovel | null;
  if (porCodigo) return porCodigo;
  return exigir(await banco.from("imoveis").select(colunas).ilike("referencia", codigo).limit(1).maybeSingle(), "achar imóvel pela referência") as Imovel | null;
}

// O mesmo critério do banco (interno.corretor_do_captador): nome no Univen ou nome.
async function corretorDoCaptador(captador: string | null): Promise<string | null> {
  if (!captador?.trim()) return null;
  const equipe = exigir(await banco.from("corretores").select("id, nome, nome_no_univen, criado_em").eq("ativo", true), "ler equipe") as
    { id: string; nome: string; nome_no_univen: string | null; criado_em: string }[];
  const alvo = semAcento(captador);
  const achados = equipe
    .filter((c) => semAcento(c.nome_no_univen ?? c.nome) === alvo)
    .sort((a, b) => Number(a.nome_no_univen === null) - Number(b.nome_no_univen === null) || a.criado_em.localeCompare(b.criado_em));
  return achados[0]?.id ?? null;
}

async function gestores(): Promise<string[]> {
  const lista = exigir(await banco.from("corretores").select("id").eq("ativo", true).eq("papel", "gestor"), "ler gestores") as { id: string }[];
  return lista.map((g) => g.id);
}

function descricaoDoImovel(i: Imovel | null): string {
  if (!i) return "anunciado";
  const tipo = TIPOS_DE_IMOVEL[i.tipo ?? ""] ?? "imóvel";
  return `${i.referencia ?? i.codigo}, ${tipo}${i.bairro ? ` no ${i.bairro}` : ""}`;
}

async function processar(registro: Registro): Promise<void> {
  const p = registro.pedido;
  const imovel = await acharImovel(texto(p.clientListingId));
  const captador = await corretorDoCaptador(imovel?.captador ?? null);
  const tipo = registro.tipo ?? "CONTACT_FORM";
  const quando = new Date(p.timestamp ?? registro.recebido_em).toLocaleString("pt-BR", {
    timeZone: "America/Campo_Grande", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  }).replace(",", " às");
  const mudancas: Record<string, unknown> = { imovel_codigo: imovel?.codigo ?? null };

  // Clique no WhatsApp ou telefone visto: fica no imóvel e o responsável é avisado.
  if (CLIQUES.has(tipo) && imovel) {
    const clique = exigir(
      await banco.from("cliques_whatsapp").insert({
        imovel_codigo: imovel.codigo, corretor_id: captador, origem: "grupo_olx",
        nome: registro.nome, telefone: registro.telefone, avisado: true,
      }).select("id").single(),
      "registrar clique do portal",
    ) as { id: number };
    mudancas.clique_id = clique.id;
    const destinos = captador ? [captador] : await gestores();
    const cliente = [registro.nome, registro.telefone].filter(Boolean).join(", ");
    await notificar(destinos, {
      titulo: `Cliente ${NOME_DO_TIPO[tipo]} do ${imovel.referencia ?? "imóvel"}`,
      texto: resumir(`${imovel.titulo?.trim() || descricaoDoImovel(imovel)} · pelo portal (ZAP, Viva Real ou OLX) · ${quando}${cliente ? ` · ${cliente}` : ""}`, 180),
      url: `/#imoveis/${imovel.codigo}`,
      tag: `clique-${imovel.codigo}`,
    }).catch((erro) => console.warn("Aviso do clique do portal não saiu", erro));
  }

  // Sem telefone não há com quem falar: fica o registro (e o aviso acima).
  if (!registro.telefone) {
    mudancas.contato = "sem telefone";
    exigir(await banco.from("leads_portais").update(mudancas).eq("id", registro.id), "atualizar lead do portal");
    return;
  }

  // Acha o cliente pelo número (com e sem o 9) ou cria o lead.
  const existentes = exigir(await banco.from("leads").select("*").in("whatsapp", variantesWhatsapp(registro.telefone)).limit(1), "procurar cliente") as
    { id: string; whatsapp: string; status: string; corretor_id: string | null; imovel_codigo: string | null; ultima_mensagem_cliente_em: string | null; ficha: Record<string, unknown>; nome: string | null }[];
  const interesse = p.transactionType === "RENT" ? "locacao" : p.transactionType === "SELL" ? "compra" : null;
  const portal = { origem: "Grupo OLX", tipo: NOME_DO_TIPO[tipo] ?? tipo, mensagem: registro.mensagem, recebido_em: registro.recebido_em, imovel: imovel?.referencia ?? texto(p.clientListingId) };
  let lead = existentes[0];
  if (!lead) {
    lead = exigir(
      await banco.from("leads").insert({
        whatsapp: registro.telefone, nome: registro.nome, email: registro.email, origem: "portal", campanha: "Grupo OLX",
        imovel_codigo: imovel?.codigo ?? null, interesse, ficha: { portal },
      }).select("*").single(),
      "criar lead do portal",
    ) as typeof lead;
  } else {
    const livre = ["novo", "em_atendimento_ia", "encerrado"].includes(lead.status);
    lead = exigir(
      await banco.from("leads").update({
        nome: lead.nome ?? registro.nome,
        ficha: { ...(lead.ficha ?? {}), portal },
        ...(livre && imovel ? { imovel_codigo: imovel.codigo } : {}),
      }).eq("id", lead.id).select("*").single(),
      "atualizar lead do portal",
    ) as typeof lead;
  }
  mudancas.lead_id = lead.id;
  if (mudancas.clique_id) await banco.from("cliques_whatsapp").update({ lead_id: lead.id }).eq("id", mudancas.clique_id);

  await banco.from("mensagens").insert({
    lead_id: lead.id, autor: "sistema",
    conteudo: resumir(`Contato pelo portal (Grupo OLX): o cliente ${NOME_DO_TIPO[tipo] ?? "entrou em contato"}${imovel ? ` sobre o ${imovel.referencia}` : ""}.${registro.mensagem ? ` Mensagem: ${registro.mensagem}` : ""}`, 1000),
  });

  // Já com corretor: não manda o pré-atendimento; avisa quem está com ele.
  if (["com_corretor", "aguardando_corretor"].includes(lead.status)) {
    mudancas.contato = "já com corretor";
    if (lead.corretor_id && !CLIQUES.has(tipo)) {
      await notificar([lead.corretor_id], {
        titulo: `${lead.nome ?? registro.nome ?? "Cliente"} voltou pelo portal`,
        texto: resumir(`${NOME_DO_TIPO[tipo] ?? "Novo contato"}${imovel ? ` · ${imovel.referencia}` : ""}${registro.mensagem ? ` · ${registro.mensagem}` : ""}`, 160),
        url: `/#leads/${lead.id}`,
        tag: `lead-${lead.id}`,
      }).catch(() => 0);
    }
  } else if (lead.ultima_mensagem_cliente_em && Date.now() - new Date(lead.ultima_mensagem_cliente_em).getTime() < JANELA_MS) {
    // O cliente já escreveu para o número oficial: a Thais já está na conversa.
    mudancas.contato = "cliente já em conversa com a Thais";
  } else {
    const cfg = (await config()).pre_atendimento ?? {};
    const variavel = descricaoDoImovel(imovel);
    try {
      const whatsappId = await enviarModelo(lead.whatsapp ?? registro.telefone, cfg.modelo ?? "contato_portal", [variavel]);
      await banco.from("mensagens").insert({
        lead_id: lead.id, autor: "ia",
        conteudo: (cfg.texto ?? "").replace("{{1}}", variavel),
        whatsapp_id: whatsappId, status_entrega: "enviada",
      });
      await banco.from("leads").update({ status: "em_atendimento_ia", ia_ativa: true }).eq("id", lead.id);
      mudancas.contato = "pré-atendimento enviado";
    } catch (erro) {
      // Sem o modelo, ninguém falaria com o cliente: vai direto ao captador e ao rodízio.
      const motivo = erro instanceof Error ? erro.message : String(erro);
      console.warn("Pré-atendimento do portal não saiu", motivo);
      const oferta = (await banco.rpc("oferecer_lead", { p_lead_id: lead.id })).data as { situacao?: string; corretor_nome?: string } | null;
      await banco.from("mensagens").insert({
        lead_id: lead.id, autor: "sistema",
        conteudo: `A mensagem automática do portal não saiu (${resumir(motivo, 120)}). Lead passado ao corretor: ${oferta?.situacao ?? "sem resposta"}${oferta?.corretor_nome ? ` para ${oferta.corretor_nome}` : ""}.`,
      });
      mudancas.contato = resumir(`falhou o pré-atendimento; passado ao corretor (${motivo})`, 300);
    }
  }
  exigir(await banco.from("leads_portais").update(mudancas).eq("id", registro.id), "atualizar lead do portal");
}

// Repassa ao Univen o pedido como chegou (sem a nossa chave).
async function repassar(registro: { id: number; pedido: unknown; repasse_tentativas: number }, destino: string): Promise<void> {
  let status: string;
  let ok = false;
  try {
    const resposta = await fetch(destino, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "lfg-crm-repasse" },
      body: JSON.stringify(registro.pedido),
      signal: AbortSignal.timeout(15_000),
    });
    await resposta.body?.cancel();
    ok = resposta.ok;
    status = `HTTP ${resposta.status}`;
  } catch (erro) {
    status = `falhou: ${erro instanceof Error ? erro.message : String(erro)}`.slice(0, 200);
  }
  await banco.from("leads_portais").update({
    repasse_status: status,
    repasse_tentativas: registro.repasse_tentativas + 1,
    ...(ok ? { repassado_em: new Date().toISOString() } : {}),
  }).eq("id", registro.id);
}

async function repassarPendentes(destino: string): Promise<void> {
  const pendentes = exigir(
    await banco.from("leads_portais").select("id, pedido, repasse_tentativas")
      .eq("portal", "grupo_olx").is("repassado_em", null).lt("repasse_tentativas", MAX_TENTATIVAS_REPASSE)
      .gt("recebido_em", new Date(Date.now() - 3 * 86_400_000).toISOString())
      .order("recebido_em").limit(10),
    "ler repasses pendentes",
  ) as { id: number; pedido: unknown; repasse_tentativas: number }[];
  for (const registro of pendentes) await repassar(registro, destino);
}

Deno.serve(async (req) => {
  const caminho = new URL(req.url).pathname;
  if (!/\/grupo-olx\/?$/.test(caminho)) return json({ erro: "Portal desconhecido." }, 404);
  if (req.method === "GET") return json({ ok: true, portal: "grupo_olx" });
  if (req.method !== "POST") return json({ erro: "Use POST." }, 405);
  if (!(await autorizado(req))) return json({ erro: "Chave inválida." }, 401);

  const corpo = await req.text();
  let p: PedidoGrupoOlx;
  try {
    p = JSON.parse(corpo);
  } catch {
    return json({ erro: "JSON inválido." }, 400);
  }
  const origemLeadId = texto(p.originLeadId);
  if (!origemLeadId) return json({ erro: "originLeadId é obrigatório." }, 400);

  const cfg = await config();
  if (cfg.grupo_olx?.ativo === false) return json({ ok: true, desligado: true });

  const telefone = normalizarWhatsapp(`${p.ddd ?? ""}${p.phone ?? ""}`) ?? normalizarWhatsapp(p.phoneNumber ?? "");
  // Lead de teste (originLeadId "teste-…") não vai para o Univen.
  const deTeste = origemLeadId.startsWith("teste-");
  const inserido = await banco.from("leads_portais").insert({
    portal: "grupo_olx",
    origem_lead_id: origemLeadId,
    tipo: texto(p.extraData?.leadType),
    nome: texto(p.name),
    email: texto(p.email),
    telefone,
    mensagem: texto(p.message)?.slice(0, 3000) ?? null,
    pedido: p,
    ...(deTeste ? { repasse_status: "teste: não repassado", repasse_tentativas: MAX_TENTATIVAS_REPASSE } : {}),
  }).select("id, portal, pedido, tipo, nome, email, telefone, mensagem, recebido_em").single();
  // Reenvio do mesmo lead: já foi recebido, só confirma.
  if (inserido.error?.code === "23505") return json({ ok: true, repetido: true });
  const registro = exigir(inserido, "guardar lead do portal") as Registro;

  EdgeRuntime.waitUntil((async () => {
    await processar(registro).catch(async (erro) => {
      console.error("Falha ao processar lead do portal", erro);
      await banco.from("leads_portais").update({ contato: resumir(`erro: ${erro instanceof Error ? erro.message : String(erro)}`, 300) }).eq("id", registro.id);
    });
    const destino = cfg.grupo_olx?.repassar_para;
    if (destino) await repassarPendentes(destino).catch((erro) => console.error("Falha no repasse ao Univen", erro));
  })());

  return json({ ok: true });
});
