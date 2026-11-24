import { RESPOSTA_DE_SEGURANCA, responderLead, type ResultadoAgente } from "./agente.ts";
import { banco, exigir, type Lead } from "./banco.ts";
import { executarFerramenta } from "./ferramentas.ts";
import { campanhaDaConversa } from "./campanhas.ts";
import { notificar } from "./notificacoes.ts";
import { variantesWhatsapp } from "./telefone.ts";

// Foto, áudio ou documento. A mensagem é registrada na hora, com o tipo do
// arquivo e ainda sem caminho no bucket; `preparar` baixa o arquivo (e
// transcreve o áudio) antes de a IA ler.
export type MidiaDoCliente = {
  tipo: string;
  preparar: () => Promise<{ caminho: string; tipo: string; texto?: string | null }>;
};

export type EntradaDoCliente = {
  whatsapp: string;
  // Texto da mensagem; na mídia, a legenda ou o nome do arquivo (pode faltar).
  texto: string | null;
  midia?: MidiaDoCliente;
  nome?: string | null;
  tipo?: string;
  whatsappId?: string | null;
  // wamid da mensagem que o cliente citou ao responder.
  citaWhatsappId?: string | null;
  origem?: string | null;
  campanha?: string | null;
  // Anúncio do Facebook/Instagram que trouxe o cliente (texto que ele viu).
  anuncio?: { titulo: string | null; texto: string | null; tipo: string | null; id: string | null; url: string | null };
  // Espera antes de responder; se o cliente mandar outra mensagem nesse tempo,
  // quem responde é o processamento da última, já com tudo no histórico.
  aguardarMs?: number;
  // Envia cada resposta ao cliente e devolve o ID da mensagem no WhatsApp.
  enviar?: (texto: string) => Promise<string | null>;
  // Chamado quando a IA vai responder (no WhatsApp, mostra "digitando…").
  aoComecarResposta?: () => void;
  // Só o simulador usa: faz de conta que a IA caiu, para testar o plano B.
  simularFalhaDaIa?: boolean;
};

// Plano B quando a IA não responde (fora do ar, sem crédito, erro): o cliente
// recebe a mensagem de segurança, o lead vai para o rodízio e os gestores são
// avisados. Se o cliente já recebeu essa mensagem e segue sem corretor, não
// manda de novo a cada mensagem.
async function planoB(lead: Lead, erro: unknown): Promise<ResultadoAgente> {
  const motivo = erro instanceof Error ? erro.message : String(erro);
  console.error("IA falhou; plano B acionado", motivo);
  const resultado: ResultadoAgente = {
    respostas: [], ferramentas: [], parada: "falha_ia", chamadas: 0,
    uso: { entrada: 0, saida: 0, cache_lido: 0, cache_gravado: 0 },
  };

  const ultimaDaIa = (await banco.from("mensagens").select("conteudo").eq("lead_id", lead.id).eq("autor", "ia")
    .order("criado_em", { ascending: false }).limit(1)).data?.[0] as { conteudo: string } | undefined;
  const jaAvisado = ultimaDaIa?.conteudo === RESPOSTA_DE_SEGURANCA;
  if (!jaAvisado) resultado.respostas = [RESPOSTA_DE_SEGURANCA];

  if (lead.status !== "com_corretor" && lead.status !== "aguardando_corretor") {
    try {
      const passagem = await executarFerramenta("passar_para_corretor", {
        motivo: "outro",
        resumo: `${lead.resumo ? `${lead.resumo} ` : ""}A assistente virtual ficou fora do ar e não respondeu; o cliente precisa de atendimento humano.`,
      }, lead);
      resultado.ferramentas.push({ nome: "passar_para_corretor", entrada: { motivo: "falha_ia" }, resultado: passagem });
    } catch (falha) {
      console.error("Plano B: não passou o lead ao rodízio", falha);
    }
  }

  try {
    await banco.from("mensagens").insert({ lead_id: lead.id, autor: "sistema", conteudo: `A IA falhou e o plano B foi acionado: ${motivo.slice(0, 300)}` });
    const gestores = ((await banco.from("corretores").select("id").eq("papel", "gestor").eq("ativo", true)).data ?? []) as { id: string }[];
    const teste = lead.whatsapp.startsWith("sim-") ? " (teste)" : "";
    await notificar(gestores.map((g) => g.id), {
      titulo: `A IA não respondeu${teste}`,
      texto: `${lead.nome ?? "Um cliente"} ficou sem resposta da IA. O cliente foi avisado e o lead foi para o rodízio.`,
      url: `/#leads/${lead.id}`,
      tag: `falha-ia-${lead.id}`,
    });
  } catch (falha) {
    console.error("Plano B: aviso aos gestores não saiu", falha);
  }
  return resultado;
}

// "(código: CA00742/joacyr-vilasanti)", do botão da página de compartilhar.
const CODIGO_DE_COMPARTILHAMENTO = /\(c[oó]digo:\s*([A-Za-z0-9-]{2,30})\/([a-z0-9-]{2,60})\)/i;

// Pausa entre as mensagens de uma mesma resposta, para chegarem na ordem e
// com o ritmo de alguém digitando.
const PAUSA_ENTRE_MENSAGENS_MS = 700;

export type Atendimento = {
  lead: Lead;
  // null quando a IA não responde: mensagem repetida, mensagem mais nova a
  // caminho ou corretor já assumiu.
  resultado: ResultadoAgente | null;
};

// Tempo máximo esperando a mídia de outra mensagem terminar de chegar.
const ESPERA_MAXIMA_MIDIA_MS = 90_000;

const esperar = (ms: number) => new Promise((resolver) => setTimeout(resolver, ms));

async function prepararMidia(mensagemId: number, midia: MidiaDoCliente) {
  let mudancas: Record<string, unknown>;
  try {
    const pronta = await midia.preparar();
    mudancas = { midia_url: pronta.caminho, midia_tipo: pronta.tipo, ...(pronta.texto ? { conteudo: pronta.texto } : {}) };
  } catch (erro) {
    console.error("Mídia do cliente não foi guardada", erro);
    mudancas = { midia_tipo: null }; // sem arquivo: a IA avisa o cliente que não conseguiu abrir
  }
  exigir(await banco.from("mensagens").update(mudancas).eq("id", mensagemId), "registrar mídia do cliente");
}

async function temMensagemMaisNova(leadId: string, mensagemId: number): Promise<boolean> {
  const maisNova = exigir(
    await banco.from("mensagens").select("id").eq("lead_id", leadId).eq("autor", "cliente").gt("id", mensagemId).limit(1),
    "procurar mensagem mais nova",
  ) as unknown[];
  return maisNova.length > 0;
}

// Mídia ainda chegando: tem tipo e ainda não tem caminho no bucket. As muito
// antigas não contam (o processamento delas pode ter caído no meio).
async function temMidiaChegando(leadId: string): Promise<boolean> {
  const chegando = exigir(
    await banco
      .from("mensagens")
      .select("id")
      .eq("lead_id", leadId)
      .eq("autor", "cliente")
      .not("midia_tipo", "is", null)
      .is("midia_url", null)
      .gt("criado_em", new Date(Date.now() - 2 * ESPERA_MAXIMA_MIDIA_MS).toISOString())
      .limit(1),
    "procurar mídia chegando",
  ) as unknown[];
  return chegando.length > 0;
}

// A Meta pode mandar o celular sem o 9 e o cliente estar cadastrado com o 9 (ou o
// contrário): continua sendo o mesmo cliente.
async function numeroCadastrado(whatsapp: string): Promise<string> {
  if (whatsapp.startsWith("sim-")) return whatsapp;
  const achados = exigir(
    await banco.from("leads").select("whatsapp").in("whatsapp", variantesWhatsapp(whatsapp)).limit(1),
    "procurar cliente",
  ) as { whatsapp: string }[];
  return achados[0]?.whatsapp ?? whatsapp;
}

// Caminho de toda mensagem do cliente, venha do WhatsApp ou do simulador:
// registra o lead e a mensagem, e a IA responde se ainda estiver no comando.
export async function receberMensagemDoCliente(entrada: EntradaDoCliente): Promise<Atendimento> {
  const whatsapp = await numeroCadastrado(entrada.whatsapp);
  exigir(
    await banco
      .from("leads")
      .upsert(
        {
          whatsapp,
          nome: entrada.nome ?? null,
          origem: entrada.origem ?? null,
          campanha: entrada.campanha ?? null,
        },
        { onConflict: "whatsapp", ignoreDuplicates: true },
      ),
    "registrar lead",
  );
  let lead = exigir(await banco.from("leads").select("*").eq("whatsapp", whatsapp).single(), "ler lead") as Lead;

  // Cliente que veio pelo link de compartilhamento de um corretor: a mensagem
  // pronta termina com "(código: REF/slug)". Sem corretor ainda, o lead vai
  // direto para quem compartilhou (antes de registrar a mensagem, para ele
  // receber a notificação dela) e a IA não responde.
  const codigo = entrada.texto?.match(CODIGO_DE_COMPARTILHAMENTO);
  if (codigo) {
    const { data, error } = await banco.rpc("lead_por_compartilhamento", { p_lead_id: lead.id, p_referencia: codigo[1], p_corretor: codigo[2] });
    if (error) console.warn("Compartilhamento não registrado", error.message);
    else {
      console.log(`Lead do compartilhamento: ${(data as { situacao?: string })?.situacao}.`);
      lead = exigir(await banco.from("leads").select("*").eq("id", lead.id).single(), "ler lead") as Lead;
    }
  }

  const inserida = await banco
    .from("mensagens")
    .insert({
      lead_id: lead.id,
      autor: "cliente",
      tipo: entrada.tipo ?? "texto",
      conteudo: entrada.texto,
      midia_tipo: entrada.midia?.tipo ?? null,
      whatsapp_id: entrada.whatsappId ?? null,
      cita_whatsapp_id: entrada.citaWhatsappId ?? null,
    })
    .select("id")
    .single();
  // A Meta reenvia avisos de mensagem; a mesma mensagem não é respondida duas vezes.
  if (inserida.error?.code === "23505") return { lead, resultado: null };
  const mensagemId = (exigir(inserida, "registrar mensagem do cliente") as { id: number }).id;

  lead = exigir(
    await banco
      .from("leads")
      .update({
        ultima_mensagem_cliente_em: new Date().toISOString(),
        nome: lead.nome ?? entrada.nome ?? null,
        campanha: lead.campanha ?? entrada.campanha ?? null,
        ...(lead.status === "novo" ? { status: "em_atendimento_ia" } : {}),
      })
      .eq("id", lead.id)
      .select("*")
      .single(),
    "atualizar lead",
  ) as Lead;

  // O anúncio mais recente que o cliente tocou fica na ficha (campo "anuncio"),
  // para a IA e o corretor saberem o que ele viu.
  if (entrada.anuncio && (entrada.anuncio.texto?.trim() || entrada.anuncio.titulo?.trim())) {
    const anuncio = { ...entrada.anuncio, texto: entrada.anuncio.texto?.slice(0, 1500) ?? null, recebido_em: new Date().toISOString() };
    const { data } = await banco.from("leads").update({ ficha: { ...(lead.ficha ?? {}), anuncio } }).eq("id", lead.id).select("*").single();
    if (data) lead = data as Lead;
  }

  // Lead de uma campanha da Thais (ex.: Atmosphere): fica marcado com a origem da campanha.
  if (!lead.campanha_ia_id) {
    const campanha = await campanhaDaConversa([entrada.anuncio?.titulo, entrada.anuncio?.texto, entrada.texto]);
    if (campanha) {
      const { data } = await banco.from("leads").update({ campanha_ia_id: campanha.id, campanha: campanha.origem }).eq("id", lead.id).select("*").single();
      if (data) lead = data as Lead;
      console.log(`Lead da campanha ${campanha.nome}.`);
    }
  }

  // A mídia é guardada mesmo com a IA pausada: o corretor vê no painel.
  if (entrada.midia) await prepararMidia(mensagemId, entrada.midia);

  if (!lead.ia_ativa) return { lead, resultado: null };
  entrada.aoComecarResposta?.();

  if (entrada.aguardarMs) {
    // Espera o cliente terminar de mandar mensagens e as mídias dele terminarem
    // de chegar (um áudio leva alguns segundos para ser transcrito).
    const limite = Date.now() + ESPERA_MAXIMA_MIDIA_MS;
    do {
      await esperar(entrada.aguardarMs);
      if (await temMensagemMaisNova(lead.id, mensagemId)) return { lead, resultado: null };
    } while (Date.now() < limite && (await temMidiaChegando(lead.id)));
  }

  const inicio = Date.now();
  let resultado: ResultadoAgente;
  try {
    if (entrada.simularFalhaDaIa) throw new Error("Falha simulada no simulador");
    resultado = await responderLead(lead.id);
    console.log(`IA respondeu em ${((Date.now() - inicio) / 1000).toFixed(1)} s, com ${resultado.chamadas} chamada(s).`);
  } catch (erro) {
    resultado = await planoB(lead, erro);
  }
  // O cliente escreveu de novo enquanto a IA pensava: quem responde é o
  // processamento da mensagem nova, que já vê tudo. Assim não saem duas
  // respostas quase iguais.
  if (await temMensagemMaisNova(lead.id, mensagemId)) {
    console.log("Resposta descartada: chegou mensagem mais nova do cliente.");
    return { lead, resultado: null };
  }
  for (const [posicao, conteudo] of resultado.respostas.entries()) {
    if (posicao > 0 && entrada.enviar) await esperar(PAUSA_ENTRE_MENSAGENS_MS);
    let whatsappId: string | null = null;
    let statusEntrega: string | null = null;
    if (entrada.enviar) {
      try {
        whatsappId = await entrada.enviar(conteudo);
        statusEntrega = "enviada";
      } catch (erro) {
        console.error("Falha ao enviar resposta da IA", erro);
        statusEntrega = "falhou";
      }
    }
    exigir(
      await banco.from("mensagens").insert({ lead_id: lead.id, autor: "ia", conteudo, whatsapp_id: whatsappId, status_entrega: statusEntrega }),
      "registrar resposta da IA",
    );
  }

  lead = exigir(await banco.from("leads").select("*").eq("id", lead.id).single(), "ler lead") as Lead;
  return { lead, resultado };
}
