// Follow-up dos leads que um corretor já assumiu (cron a cada 5 minutos).
//   POST /functions/v1/followup-corretor   {}   ou   { teste: "<lead_id>" }
//   Cabeçalho: x-avisos-chave
//
// Para cada lead que monitor_corretor_pendentes devolve:
//   alerta   → notificação ao corretor ("Seu lead X está sem contato há 20h").
//   followup → a Thais retoma a conversa. Se o cliente falou nas últimas 23 h,
//              ela escreve lendo a conversa (texto livre); se não, sai a
//              mensagem-modelo aprovada pela Meta. A IA continua pausada.
//   esgotado → os follow-ups seguidos acabaram sem resposta: avisa os gestores.
// Leads do simulador (sim-*) só entram no modo teste, e nada vai ao WhatsApp.
import Anthropic from "npm:@anthropic-ai/sdk@1.3.0";
import { confereChave, json } from "../_shared/acesso.ts";
import { ehRelatorio, MARCACAO_INTERNA } from "../_shared/agente.ts";
import { banco, exigir, type Lead } from "../_shared/banco.ts";
import { notificar } from "../_shared/notificacoes.ts";
import { enviarModelo, enviarTexto } from "../_shared/whatsapp.ts";

const claude = new Anthropic({ timeout: 50_000, maxRetries: 1 });
const MODELO = "claude-opus-5-5";
const JANELA_LIVRE_MS = 23 * 3600 * 1000;

type Pendente = {
  lead_id: string; acao: "alerta" | "followup" | "esgotado"; corretor_id: string; nome: string | null; whatsapp: string;
  referencia: string; horas: number; ultima_do_cliente: string | null; seguidos: number;
};

const primeiroNome = (nome: string | null) => (nome ?? "").trim().split(/\s+/)[0] || "tudo bem";
const nomeDoLead = (p: Pendente) => p.nome?.trim() || "sem nome";

const INSTRUCOES_FOLLOWUP = `Você é a Thais, da equipe de atendimento da LFG Imóveis, imobiliária de Campo Grande (MS).
Um corretor da LFG está atendendo este cliente pelo WhatsApp e a conversa parou. Escreva UMA mensagem curta para retomar o contato, em nome da LFG.

Regras:
- Leia toda a conversa e siga o assunto de onde parou (o imóvel, a visita, a proposta, a dúvida).
- Não contradiga nada do que o corretor disse e não prometa nada novo: nada de preço, desconto, condição, data, disponibilidade ou visita marcada que não esteja na conversa.
- Não diga o nome do corretor, não diga que ele sumiu ou demorou e não diga que é assistente virtual.
- Português do Brasil, tom leve e natural de WhatsApp, 1 ou 2 frases, sem listas, terminando com uma pergunta simples.
- Responda só com o texto da mensagem ao cliente.`;

function linhaDaConversa(m: { autor: string; conteudo: string | null; tipo: string; criado_em: string }) {
  const quem = m.autor === "cliente" ? "Cliente" : m.autor === "corretor" ? "Corretor" : "Thais";
  const quando = new Date(m.criado_em).toLocaleString("pt-BR", { timeZone: "America/Campo_Grande", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const texto = (m.conteudo ?? "").trim() || (m.tipo !== "texto" ? `[${m.tipo}]` : "");
  return `[${quando}] ${quem}: ${texto.slice(0, 1200)}`;
}

// Texto livre escrito pela Thais a partir da conversa. Null se não sair algo confiável.
async function escreverFollowup(lead: Lead): Promise<string | null> {
  const historico = (exigir(
    await banco.from("mensagens").select("autor, conteudo, tipo, criado_em").eq("lead_id", lead.id).neq("autor", "sistema")
      .order("criado_em", { ascending: false }).limit(40),
    "ler conversa",
  ) as { autor: string; conteudo: string | null; tipo: string; criado_em: string }[]).reverse();
  if (!historico.length) return null;
  const resposta = await claude.beta.messages.create({
    model: MODELO,
    max_tokens: 4000,
    system: INSTRUCOES_FOLLOWUP,
    messages: [{
      role: "user",
      content: `Cliente: ${primeiroNome(lead.nome)}. Resumo do atendimento: ${lead.resumo ?? "—"}\n\nConversa (mais antiga primeiro):\n${historico.map(linhaDaConversa).join("\n")}\n\nEscreva agora a mensagem de retomada.`,
    }],
    output_config: { effort: "low" },
  });
  if (resposta.stop_reason === "refusal") return null;
  const texto = resposta.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
  if (!texto || texto.length > 600 || MARCACAO_INTERNA.test(texto) || (await ehRelatorio(texto, lead))) {
    console.warn(`Follow-up descartado para ${lead.id}: ${texto.slice(0, 160)}`);
    return null;
  }
  return texto;
}

async function gestores(): Promise<string[]> {
  return (exigir(await banco.from("corretores").select("id").eq("papel", "gestor").eq("ativo", true), "ler gestores") as { id: string }[]).map((g) => g.id);
}

async function fazerFollowup(p: Pendente, modelo: string, teste: boolean) {
  await banco.from("leads").update({ monitor_tentativa_em: new Date().toISOString() }).eq("id", p.lead_id);
  const lead = exigir(await banco.from("leads").select("*").eq("id", p.lead_id).single(), "ler lead") as Lead;
  const simulado = lead.whatsapp.startsWith("sim-");
  const janelaAberta = !!p.ultima_do_cliente && Date.now() - new Date(p.ultima_do_cliente).getTime() < JANELA_LIVRE_MS;

  let conteudo: string | null = null;
  let whatsappId: string | null = null;
  let jeito = "";
  if (janelaAberta) {
    conteudo = await escreverFollowup(lead);
    if (conteudo) {
      jeito = "texto";
      if (!simulado) whatsappId = await enviarTexto(lead.whatsapp, conteudo);
    }
  }
  if (!conteudo) {
    // Fora da janela de 24 h da Meta (ou o texto não saiu confiável): mensagem-modelo.
    const texto = `Oi, ${primeiroNome(lead.nome)}! Passando para saber se ainda posso te ajudar com o que conversamos. Se quiser seguir, é só responder por aqui.`;
    if (!simulado) {
      try {
        whatsappId = await enviarModelo(lead.whatsapp, modelo, [primeiroNome(lead.nome)]);
      } catch (erro) {
        const mensagem = erro instanceof Error ? erro.message : String(erro);
        console.error(`Modelo ${modelo} não saiu para ${lead.id}`, mensagem);
        await banco.from("mensagens").insert({ lead_id: lead.id, autor: "sistema", conteudo: `A Thais não conseguiu retomar a conversa: fora da janela de 24 h do WhatsApp e a mensagem-modelo "${modelo}" não saiu (${mensagem.slice(0, 160)}).` });
        await notificar([p.corretor_id], {
          titulo: `Lead ${nomeDoLead(p)} sem contato há ${Math.floor(p.horas)}h`,
          texto: "A Thais não conseguiu retomar pelo WhatsApp. Fale com o cliente.",
          url: `/#leads/${lead.id}`, tag: `monitor-${lead.id}`,
        }).catch(() => {});
        return { lead: lead.id, acao: "followup", ok: false, erro: mensagem };
      }
    }
    conteudo = texto;
    jeito = "modelo";
  }
  exigir(await banco.from("mensagens").insert({
    lead_id: lead.id, autor: "ia", tipo: "followup_corretor", conteudo, whatsapp_id: whatsappId,
    status_entrega: simulado ? null : "enviada",
  }), "registrar follow-up");
  await notificar([p.corretor_id], {
    titulo: `A Thais retomou a conversa com ${nomeDoLead(p)}`,
    texto: `O lead estava sem contato há ${Math.floor(p.horas)}h. Se o cliente responder, quem continua é você.`,
    url: `/#leads/${lead.id}`, tag: `monitor-${lead.id}`,
  }).catch(() => {});
  return { lead: lead.id, acao: "followup", ok: true, jeito, teste, conteudo };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ erro: "Use POST." }, 405);
  if (!(await confereChave("avisos", req.headers.get("x-avisos-chave")))) return json({ erro: "Chave inválida." }, 401);
  const corpo = await req.json().catch(() => ({})) as { teste?: string };
  const teste = !!corpo.teste;

  const cfg = ((await banco.from("configuracoes").select("valor").eq("chave", "followup_corretor").maybeSingle()).data?.valor ?? {}) as { modelo?: string };
  const modelo = cfg.modelo || "retomar_conversa";
  let pendentes = exigir(await banco.rpc("monitor_corretor_pendentes", { p_incluir_testes: teste }), "ler pendentes") as Pendente[];
  if (teste) pendentes = pendentes.filter((p) => p.lead_id === corpo.teste);

  const resultados = [];
  for (const p of pendentes) {
    try {
      if (p.acao === "alerta") {
        await notificar([p.corretor_id], {
          titulo: `Seu lead ${nomeDoLead(p)} está sem contato há ${Math.floor(p.horas)}h`,
          texto: "Responda o cliente. Se a conversa continuar parada, a Thais retoma o contato.",
          url: `/#leads/${p.lead_id}`, tag: `monitor-${p.lead_id}`,
        });
        await banco.from("leads").update({ monitor_alerta_ref: p.referencia }).eq("id", p.lead_id);
        resultados.push({ lead: p.lead_id, acao: "alerta", ok: true });
      } else if (p.acao === "esgotado") {
        await notificar(await gestores(), {
          titulo: `Lead ${nomeDoLead(p)} segue sem resposta`,
          texto: `A Thais já fez ${p.seguidos} follow-ups e ninguém respondeu. Veja com o corretor.`,
          url: `/#leads/${p.lead_id}`, tag: `monitor-esgotado-${p.lead_id}`,
        });
        await banco.from("leads").update({ monitor_esgotado_ref: p.referencia }).eq("id", p.lead_id);
        await banco.from("mensagens").insert({ lead_id: p.lead_id, autor: "sistema", conteudo: `A Thais fez ${p.seguidos} follow-ups sem resposta. O gestor foi avisado e não sai mais nada automático até alguém escrever.` });
        resultados.push({ lead: p.lead_id, acao: "esgotado", ok: true });
      } else {
        resultados.push(await fazerFollowup(p, modelo, teste));
      }
    } catch (erro) {
      const mensagem = erro instanceof Error ? erro.message : String(erro);
      console.error(`Monitor do lead ${p.lead_id} falhou`, mensagem);
      resultados.push({ lead: p.lead_id, acao: p.acao, ok: false, erro: mensagem });
    }
  }
  return json({ ok: true, resultados });
});
