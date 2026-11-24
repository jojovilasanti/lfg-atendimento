// Disparo em massa (só o gestor) e os modelos de mensagem da Meta.
//
// Com a sessão do gestor (Authorization: Bearer <sessão>):
//   { "acao": "modelos" }                       modelos da conta, com o texto e a situação
//   { "acao": "criar_modelo", "nome", "texto" } manda um modelo de marketing para a aprovação da Meta
//   { "acao": "numero" }                        qualidade e limite diário do número
// Com a chave interna (x-avisos-chave), chamado pelo banco a cada minuto:
//   { "acao": "enviar_lote" }                   envia o próximo lote dos disparos em andamento
//   { "acao": "criar_modelo_avaliacao" }        manda o modelo "avaliacao_atendimento" para aprovação
//   { "acao": "criar_modelo_portal" }           manda o modelo do pré-atendimento dos portais (configuracoes.portais)
//
// Regras da Meta seguidas aqui: só modelo aprovado; respeita o limite diário do
// número e um ritmo por minuto; pausa tudo se a qualidade do número cair para
// vermelha; nunca envia a quem saiu da lista (descadastros).
import { confereChave } from "../_shared/acesso.ts";
import { banco, exigir } from "../_shared/banco.ts";
import { notificar } from "../_shared/notificacoes.ts";
import { variantesWhatsapp } from "../_shared/telefone.ts";
import { consultarNumero, criarModelo, enviarModelo, listarModelosDetalhados } from "../_shared/whatsapp.ts";

const CONTA_WHATSAPP = Deno.env.get("WHATSAPP_CONTA_ID")?.trim() || "1843216357807333";
const ORIGENS_DO_PAINEL = ["https://lfg.jojodigitals.com", "https://srv2083149.hstgr.cloud", "http://localhost:5173"];
const LIMITE_DO_NIVEL: Record<string, number> = { TIER_50: 50, TIER_250: 250, TIER_1K: 1000, TIER_10K: 10000, TIER_100K: 100000 };
const BOTAO_SAIR = "Não quero receber";

class Erro extends Error {
  constructor(public status: number, mensagem: string) {
    super(mensagem);
  }
}

function cors(req: Request): Record<string, string> {
  const origem = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ORIGENS_DO_PAINEL.includes(origem) ? origem : ORIGENS_DO_PAINEL[0],
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

async function exigirGestor(req: Request): Promise<{ id: string; nome: string }> {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) throw new Erro(401, "Entre no painel de novo.");
  const { data, error } = await banco.auth.getUser(token);
  if (error || !data.user) throw new Erro(401, "Sua sessão expirou. Entre no painel de novo.");
  const eu = exigir(await banco.from("corretores").select("id, nome, papel, ativo").eq("usuario_id", data.user.id).maybeSingle(), "ler cadastro") as
    | { id: string; nome: string; papel: string; ativo: boolean }
    | null;
  if (!eu?.ativo || eu.papel !== "gestor") throw new Erro(403, "Só o gestor usa os disparos.");
  return eu;
}

type Componente = { type: string; text?: string; buttons?: { type: string; text: string }[] };
type Modelo = { name: string; status: string; category: string; language: string; rejected_reason?: string; components?: Componente[] };

async function modelos() {
  const resposta = await listarModelosDetalhados(CONTA_WHATSAPP) as { data?: Modelo[] };
  return {
    modelos: (resposta.data ?? []).map((m) => {
      const corpo = m.components?.find((c) => c.type === "BODY")?.text ?? "";
      return {
        nome: m.name,
        situacao: m.status,
        categoria: m.category,
        idioma: m.language,
        motivo_recusa: m.rejected_reason && m.rejected_reason !== "NONE" ? m.rejected_reason : null,
        texto: corpo,
        rodape: m.components?.find((c) => c.type === "FOOTER")?.text ?? null,
        botoes: m.components?.find((c) => c.type === "BUTTONS")?.buttons?.map((b) => b.text) ?? [],
        usa_nome: /\{\{1\}\}/.test(corpo),
        tem_saida: (m.components?.find((c) => c.type === "BUTTONS")?.buttons ?? []).some((b) => b.text === BOTAO_SAIR),
      };
    }),
  };
}

// Modelo de marketing escrito pelo gestor. {{nome}} vira a variável {{1}}
// (primeiro nome do contato). Sempre leva o botão de sair da lista.
async function criarModeloDeMarketing(dados: Record<string, unknown>) {
  const nome = String(dados.nome ?? "").trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
  const texto = String(dados.texto ?? "").trim();
  if (nome.length < 3) throw new Erro(400, "Dê um nome curto para a mensagem (ex.: lancamento_novembro).");
  if (texto.length < 20 || texto.length > 900) throw new Erro(400, "O texto precisa ter entre 20 e 900 caracteres.");
  const usaNome = /\{\{\s*nome\s*\}\}/i.test(texto);
  const corpo = texto.replace(/\{\{\s*nome\s*\}\}/gi, "{{1}}");
  if (/\{\{(?!1\}\})/.test(corpo)) throw new Erro(400, "Use só {{nome}} como campo variável no texto.");
  const modelo = {
    name: nome,
    language: "pt_BR",
    category: "MARKETING",
    components: [
      { type: "BODY", text: corpo, ...(usaNome ? { example: { body_text: [["Maria"]] } } : {}) },
      { type: "FOOTER", text: "Para não receber mais, toque em Não quero receber." },
      { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: BOTAO_SAIR }] },
    ],
  };
  return await criarModelo(CONTA_WHATSAPP, modelo);
}

async function criarModeloAvaliacao() {
  const cfg = exigir(await banco.from("configuracoes").select("valor").eq("chave", "avaliacao").maybeSingle(), "ler avaliação") as
    | { valor: { texto: string; modelo: string } }
    | null;
  if (!cfg) throw new Erro(400, "Configuração da avaliação não encontrada.");
  return await criarModelo(CONTA_WHATSAPP, {
    name: cfg.valor.modelo,
    language: "pt_BR",
    category: "UTILITY",
    allow_category_change: true,
    components: [{ type: "BODY", text: cfg.valor.texto }],
  });
}

// Pré-atendimento da Thais para quem chega pelos portais. {{1}} é o imóvel
// ("CA00613, casa no São Francisco"). Texto aprovado pelo gestor em 16/11/2026.
async function criarModeloPortal() {
  const cfg = exigir(await banco.from("configuracoes").select("valor").eq("chave", "portais").maybeSingle(), "ler portais") as
    | { valor: { pre_atendimento?: { modelo: string; texto: string; exemplo: string } } }
    | null;
  const pre = cfg?.valor.pre_atendimento;
  if (!pre) throw new Erro(400, "Configuração do pré-atendimento dos portais não encontrada.");
  return await criarModelo(CONTA_WHATSAPP, {
    name: pre.modelo,
    language: "pt_BR",
    category: "UTILITY",
    components: [{ type: "BODY", text: pre.texto, example: { body_text: [[pre.exemplo]] } }],
  });
}

async function avisarGestores(titulo: string, texto: string) {
  const gestores = ((await banco.from("corretores").select("id").eq("papel", "gestor").eq("ativo", true)).data ?? []) as { id: string }[];
  await notificar(gestores.map((g) => g.id), { titulo, texto, url: "/#disparos", tag: "disparos" }).catch(() => 0);
}

async function pausarTudo(motivo: string) {
  const { data } = await banco.from("campanhas").update({ status: "pausada", motivo_pausa: motivo }).eq("status", "enviando").select("id");
  if (data?.length) await avisarGestores("Disparo pausado", motivo);
}

type Destinatario = { id: number; telefone: string; nome: string | null; campanha_id: string };
type Campanha = { id: string; modelo: string; usa_nome: boolean };

async function enviarLote() {
  const cfg = ((await banco.from("configuracoes").select("valor").eq("chave", "disparos").maybeSingle()).data?.valor ?? {}) as
    { limite_dia?: number; por_minuto?: number };
  const campanhas = exigir(await banco.from("campanhas").select("id, modelo, usa_nome").eq("status", "enviando").order("iniciada_em"), "ler disparos") as Campanha[];
  if (!campanhas.length) return { enviados: 0, motivo: "nenhum disparo em andamento" };

  // Qualidade e nível de limite do número, direto da Meta.
  const numero = await consultarNumero() as { quality_rating?: string; messaging_limit_tier?: string };
  if (numero.quality_rating === "RED") {
    await pausarTudo("A Meta baixou a qualidade do número para vermelha. Os disparos foram pausados para proteger o número. Espere a qualidade voltar antes de retomar.");
    return { enviados: 0, motivo: "qualidade vermelha" };
  }
  const limiteDoNivel = LIMITE_DO_NIVEL[numero.messaging_limit_tier ?? ""] ?? 250;
  const limiteDia = Math.min(cfg.limite_dia ?? 200, limiteDoNivel);
  const { count: enviados24h } = await banco.from("campanha_destinatarios").select("id", { count: "exact", head: true })
    .gte("enviado_em", new Date(Date.now() - 24 * 3600 * 1000).toISOString());
  let restante = Math.min(limiteDia - (enviados24h ?? 0), cfg.por_minuto ?? 20);
  if (restante <= 0) return { enviados: 0, motivo: "limite das últimas 24 horas atingido" };

  let enviados = 0;
  for (const campanha of campanhas) {
    if (restante <= 0) break;
    const fila = exigir(
      await banco.from("campanha_destinatarios").select("id, telefone, nome, campanha_id").eq("campanha_id", campanha.id).eq("status", "na_fila").order("id").limit(restante),
      "ler fila do disparo",
    ) as Destinatario[];
    for (const d of fila) {
      // Pode ter saído da lista depois de a campanha ser criada.
      const saiu = exigir(await banco.from("descadastros").select("telefone").in("telefone", variantesWhatsapp(d.telefone)).limit(1), "ler descadastros") as unknown[];
      if (saiu.length) {
        await banco.from("campanha_destinatarios").update({ status: "descadastrado", atualizado_em: new Date().toISOString() }).eq("id", d.id);
        continue;
      }
      const primeiroNome = (d.nome ?? "").trim().split(/\s+/)[0] || "tudo bem";
      try {
        const whatsappId = await enviarModelo(d.telefone, campanha.modelo, campanha.usa_nome ? [primeiroNome] : []);
        await banco.from("campanha_destinatarios")
          .update({ status: "enviado", whatsapp_id: whatsappId, enviado_em: new Date().toISOString(), atualizado_em: new Date().toISOString() }).eq("id", d.id);
        enviados++;
        restante--;
      } catch (erro) {
        const mensagem = erro instanceof Error ? erro.message : String(erro);
        await banco.from("campanha_destinatarios").update({ status: "falhou", erro: mensagem.slice(0, 300), atualizado_em: new Date().toISOString() }).eq("id", d.id);
        // Modelo pausado ou desativado pela Meta: para esta campanha.
        if (/c[oó]digo 13201[56]|c[oó]digo 132001|template.*(paused|disabled|does not exist)/i.test(mensagem)) {
          await banco.from("campanhas").update({ status: "pausada", motivo_pausa: `A Meta não aceitou a mensagem: ${mensagem.slice(0, 200)}` }).eq("id", campanha.id);
          await avisarGestores("Disparo pausado", "A Meta não aceitou a mensagem do disparo. Veja o motivo na tela Disparos.");
          break;
        }
      }
    }
    const { count: naFila } = await banco.from("campanha_destinatarios").select("id", { count: "exact", head: true }).eq("campanha_id", campanha.id).eq("status", "na_fila");
    if (!naFila) await banco.from("campanhas").update({ status: "concluida", concluida_em: new Date().toISOString() }).eq("id", campanha.id).eq("status", "enviando");
  }
  return { enviados };
}

Deno.serve(async (req) => {
  const cabecalhos = cors(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cabecalhos });
  const responder = (corpo: unknown, status = 200) =>
    new Response(JSON.stringify(corpo), { status, headers: { ...cabecalhos, "Content-Type": "application/json; charset=utf-8" } });
  if (req.method !== "POST") return responder({ erro: "Use POST." }, 405);

  try {
    const dados = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const interno = await confereChave("avisos", req.headers.get("x-avisos-chave"));
    switch (dados.acao) {
      case "enviar_lote":
        if (!interno) throw new Erro(401, "Chave inválida.");
        return responder(await enviarLote());
      case "criar_modelo_avaliacao":
        if (!interno) throw new Erro(401, "Chave inválida.");
        return responder(await criarModeloAvaliacao());
      case "criar_modelo_portal":
        if (!interno) throw new Erro(401, "Chave inválida.");
        return responder(await criarModeloPortal());
      case "modelos":
        await exigirGestor(req);
        return responder(await modelos());
      case "criar_modelo":
        await exigirGestor(req);
        return responder(await criarModeloDeMarketing(dados));
      case "numero": {
        await exigirGestor(req);
        const numero = await consultarNumero() as { quality_rating?: string; messaging_limit_tier?: string };
        return responder({ qualidade: numero.quality_rating ?? null, nivel: numero.messaging_limit_tier ?? null, limite_do_nivel: LIMITE_DO_NIVEL[numero.messaging_limit_tier ?? ""] ?? null });
      }
      default:
        return responder({ erro: "Ação desconhecida." }, 400);
    }
  } catch (erro) {
    if (erro instanceof Erro) return responder({ erro: erro.message }, erro.status);
    console.error(erro);
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    return responder({ erro: mensagem.startsWith("WhatsApp recusou") ? mensagem : "Algo deu errado no servidor. Tente de novo." }, 500);
  }
});
