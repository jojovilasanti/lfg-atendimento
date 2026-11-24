import { Buffer } from "node:buffer";
import Anthropic from "npm:@anthropic-ai/sdk@1.3.0";
import { banco, exigir, type Lead, type Mensagem } from "./banco.ts";
import { executarFerramenta, FERRAMENTAS } from "./ferramentas.ts";
import { INSTRUCOES } from "./instrucoes.ts";
import { campanhasAtivas } from "./campanhas.ts";
import { lerMidia } from "./midia.ts";

// Lê ANTHROPIC_API_KEY dos segredos do Supabase. Cada chamada tem até 50 s (e uma
// nova tentativa): se a IA travar, o erro aciona o plano B antes de a função ser encerrada.
const claude = new Anthropic({ timeout: 50_000, maxRetries: 1 });

const MODELO = "claude-opus-5-5";
// Conversa de WhatsApp responde bem com esforço baixo e fica mais rápida.
const ESFORCO = "low";
const MAX_RODADAS = 6;
const LIMITE_HISTORICO = 40;
// Só as fotos e os PDFs mais recentes vão como arquivo; os mais antigos ficam
// como nota, para a conversa não pesar.
const MAX_ARQUIVOS_NA_CONVERSA = 4;
// Limite da API por imagem; com os PDFs no mesmo limite, o pedido fica bem abaixo de 32 MB.
const LIMITE_ARQUIVO_BYTES = 5 * 1024 * 1024;
const TIPOS_DE_IMAGEM = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export const RESPOSTA_DE_SEGURANCA =
  "Vou pedir para um corretor da LFG continuar seu atendimento por aqui, tudo bem? Ele já te chama.";

// Texto com marcação interna do modelo (tags XML, "antml:") não vai ao cliente:
// o pedido é refeito; persistindo, a marcação é removida.
const MARCACAO_INTERNA = /<\/?[a-z_][\w:-]*(\s[^>]*)?>|\bantml:/i;
const MAX_REPETICOES_POR_MARCACAO = 2;

// Relatório em vez de mensagem: a IA fala do cliente na terceira pessoa ou
// descreve o que fez no sistema ("registrei na ficha", "marquei o lead"). Isso
// nunca vai ao cliente: o pedido é refeito; persistindo, um corretor assume.
const RELATORIO_INTERNO = new RegExp([
  String.raw`\b(?:o|a|ao|à|do|da|pelo|pela|para o|para a|pra) cliente\b`,
  String.raw`\b(?:o|ao|do|no|pelo) lead\b`,
  String.raw`\bna ficha\b`,
  String.raw`\bmarquei o lead\b`,
  String.raw`\bregistrei\b`,
  String.raw`\bconferi no sistema\b`,
  String.raw`\bj[aá] mandei ao\b`,
  // Rótulos de relatório: "Ficha:", "Buscas:", "Próximo passo:".
  String.raw`(?:^|\n)\s*[-•]?\s*\**\s*(?:ficha|buscas?|resumo|pr[oó]ximo passo)\s*:`,
  // Negrito com dois asteriscos: o WhatsApp usa um só; dois é texto de relatório.
  String.raw`\*\*`,
].join("|"), "i");
const MAX_REPETICOES_POR_RELATORIO = 2;

// Nome do cliente usado na terceira pessoa ("para a Scheyla", "da Scheyla").
// Falar com o cliente pelo nome ("Oi, Scheyla") continua normal.
function falaDoClientePeloNome(texto: string, lead: Lead): boolean {
  const primeiro = (lead.nome ?? "").trim().split(/\s+/)[0] ?? "";
  if (primeiro.length < 3) return false;
  const nome = primeiro.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(String.raw`(?:^|[^\p{L}])(?:para|pra|com|da|do|à|ao|a|o|pela|pelo)\s+${nome}(?![\p{L}])`, "iu").test(texto);
}

// Segunda conferência, com um modelo rápido: o texto fala COM o cliente ou
// SOBRE ele? Se a conferência falhar, o texto segue (a regra acima já passou).
const MODELO_CONFERENCIA = "claude-haiku-5-5";
const INSTRUCOES_CONFERENCIA = `Você confere, antes do envio, as mensagens que uma assistente de imobiliária manda pelo WhatsApp a um cliente.
Responda só com uma palavra: ENVIAR ou RELATORIO.
RELATORIO: o texto fala SOBRE o cliente (na terceira pessoa ou pelo nome, como "mandei para a Ana", "ela pediu") ou descreve para a equipe o que a assistente fez, consultou, registrou ou decidiu, como um resumo interno.
ENVIAR: mensagem normal dirigida ao próprio cliente, falando com ele. Pode dizer que procurou e não achou, mostrar imóveis, fazer perguntas, avisar que um corretor vai falar com ele.
"Ele", "ela", "dela" e "dele" falando do imóvel, da casa, do apartamento ou do corretor são normais: "Uma casa, que ótimo! E ela fica em qual bairro?" é ENVIAR.`;

async function conferenciaDizRelatorio(texto: string): Promise<boolean> {
  try {
    const resposta = await claude.beta.messages.create({
      model: MODELO_CONFERENCIA,
      max_tokens: 2000,
      system: INSTRUCOES_CONFERENCIA,
      messages: [{ role: "user", content: `Mensagem a conferir:\n«${texto}»` }],
      output_config: { effort: "low" },
    }, { timeout: 10_000, maxRetries: 1 });
    if (resposta.stop_reason === "refusal") return false;
    return /RELATORIO/i.test(textoDaResposta(resposta.content));
  } catch (erro) {
    console.warn("Conferência da mensagem falhou; seguindo sem ela", erro);
    return false;
  }
}

async function ehRelatorio(texto: string, lead: Lead): Promise<boolean> {
  if (RELATORIO_INTERNO.test(texto) || falaDoClientePeloNome(texto, lead)) return true;
  const relatorio = await conferenciaDizRelatorio(texto);
  if (relatorio) console.warn(`Conferência apontou relatório: ${texto.slice(0, 200)}`);
  return relatorio;
}
const PEDIDO_DE_MENSAGEM_DIRETA =
  "Sua última resposta descreveu o atendimento em vez de falar com o cliente, e não foi enviada. Escreva agora só a mensagem para o cliente, falando direto com ele (você), sem contar o que você registrou ou consultou.";

function semMarcacaoInterna(texto: string): string {
  return texto.replace(/<\/?[a-z_][\w:-]*(\s[^>]*)?>/gi, "").replace(/\bantml:\S*/gi, "").trim();
}

// A IA separa as mensagens com uma linha só com "---"; vão no máximo 3 ao cliente.
const MAX_MENSAGENS_POR_RESPOSTA = 3;
function dividirMensagens(texto: string): string[] {
  const partes = texto.split(/(?:^|\n)\s*-{3,}\s*(?=\n|$)/).map((parte) => parte.trim()).filter(Boolean);
  if (partes.length <= MAX_MENSAGENS_POR_RESPOSTA) return partes;
  return [...partes.slice(0, MAX_MENSAGENS_POR_RESPOSTA - 1), partes.slice(MAX_MENSAGENS_POR_RESPOSTA - 1).join("\n\n")];
}

const textoDaResposta = (conteudo: Anthropic.Beta.BetaContentBlock[]) =>
  conteudo
    .filter((bloco): bloco is Anthropic.Beta.BetaTextBlock => bloco.type === "text")
    .map((bloco) => bloco.text)
    .join("\n")
    .trim();

// Ponto de cache no fim do histórico: a próxima chamada (depois de uma
// ferramenta ou na próxima mensagem do cliente) reaproveita a conversa já lida.
function marcarCache(conversa: Anthropic.Beta.BetaMessageParam[]) {
  const ultima = conversa.at(-1);
  if (!ultima?.content) return;
  const blocos: Anthropic.Beta.BetaContentBlockParam[] = typeof ultima.content === "string"
    ? [{ type: "text", text: ultima.content }]
    : [...ultima.content as Anthropic.Beta.BetaContentBlockParam[]];
  const fim = blocos.at(-1);
  if (fim && (fim.type === "text" || fim.type === "image" || fim.type === "document" || fim.type === "tool_result")) {
    blocos[blocos.length - 1] = { ...fim, cache_control: { type: "ephemeral" } };
    ultima.content = blocos;
  }
}

export type UsoDeTokens = { entrada: number; saida: number; cache_lido: number; cache_gravado: number };

export type ResultadoAgente = {
  respostas: string[];
  ferramentas: { nome: string; entrada: unknown; resultado: unknown; erro?: boolean }[];
  parada: string;
  // Quantas vezes a IA foi chamada para montar esta resposta.
  chamadas: number;
  uso: UsoDeTokens;
};

const ROTULO_CAMPO: Record<string, string> = {
  interesse: "se quer comprar ou alugar",
  regiao: "região ou bairro",
  orcamento: "orçamento",
  quartos: "quantidade de quartos",
  forma_pagamento: "forma de pagamento",
  urgencia: "urgência",
  nome: "nome",
};

function campoPreenchido(lead: Lead, campo: string): boolean {
  const ficha = lead.ficha ?? {};
  switch (campo) {
    case "interesse":
      return !!lead.interesse;
    case "nome":
      return !!lead.nome;
    case "orcamento":
      return ficha.orcamento_max != null || ficha.orcamento_min != null;
    default:
      return ficha[campo] != null && ficha[campo] !== "";
  }
}

// Fuso das Configurações gerais (Campo Grande se não der para ler). Guardado por 5 minutos.
let fusoGuardado: { fuso: string; ate: number } | null = null;
async function fusoDaEmpresa(): Promise<string> {
  if (fusoGuardado && fusoGuardado.ate > Date.now()) return fusoGuardado.fuso;
  let fuso = "America/Campo_Grande";
  try {
    const { data } = await banco.rpc("fuso_da_empresa");
    if (typeof data === "string" && data) {
      new Intl.DateTimeFormat("pt-BR", { timeZone: data });
      fuso = data;
    }
  } catch (erro) {
    console.warn("Fuso da empresa não lido; usando Campo Grande", erro);
  }
  fusoGuardado = { fuso, ate: Date.now() + 5 * 60_000 };
  return fuso;
}

async function agoraNaEmpresa(): Promise<string> {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: await fusoDaEmpresa(),
    dateStyle: "full",
    timeStyle: "short",
  }).format(new Date());
}

// Mensagem ao cliente que chega fora do horário (22h às 8h).
const AVISO_HORARIO = "Nosso atendimento com os corretores é de segunda a sexta, das 08:00 às 17:00. Assim que o horário comercial começar, o corretor responsável vai entrar em contato com você.";

// Situação real da passagem para o corretor, para a IA não deduzir a fila.
async function situacaoDoAtendimento(lead: Lead): Promise<string> {
  // Sem nomes: a IA nunca diz ao cliente quem vai atender (o lead pode mudar de mão).
  if (lead.status === "com_corretor") {
    return "com um corretor da LFG, que já assumiu o atendimento";
  }
  if (lead.status !== "aguardando_corretor") return lead.status;

  // Fora do horário (22h às 8h): sem rodízio; o captador já foi avisado, mas o
  // prazo só começa na abertura. A IA avisa o cliente do horário dos corretores.
  const periodo = exigir(await banco.rpc("periodo_de_atendimento"), "ler período") as { periodo: string } | null;
  if (periodo?.periodo === "fora") {
    return `passado para a equipe, mas agora é fora do horário dos corretores (22h às 8h). Diga ao cliente, com estas palavras ou bem parecidas: "${AVISO_HORARIO}" Não diga "em instantes" e continue ajudando no que puder`;
  }

  const oferta = exigir(
    await banco
      .from("atribuicoes")
      .select("prazo_em, motivo, aviso_pendente")
      .eq("lead_id", lead.id)
      .eq("status", "pendente")
      .maybeSingle(),
    "ler oferta pendente",
  ) as { prazo_em: string; motivo: string; aviso_pendente: boolean } | null;
  if (!oferta) {
    return "passado para a equipe, mas não há corretor de plantão disponível agora; o lead está na fila e vai para o próximo corretor que ligar o plantão";
  }
  const prazo = new Intl.DateTimeFormat("pt-BR", { timeZone: await fusoDaEmpresa(), timeStyle: "short" }).format(new Date(oferta.prazo_em));
  const quem = oferta.motivo === "captador" ? "captador do imóvel" : oferta.motivo === "gestor" ? "indicado pelo gestor" : "corretor de plantão";
  return `oferecido ao corretor responsável (${quem}), que ainda não assumiu e tem até ${prazo} para assumir; se não assumir, vai para o rodízio de plantão`;
}

async function montarContexto(lead: Lead): Promise<string> {
  const configuracao = exigir(
    await banco.from("configuracoes").select("valor").eq("chave", "perguntas_obrigatorias").maybeSingle(),
    "ler perguntas obrigatórias",
  ) as { valor: string[] } | null;
  const obrigatorios = configuracao?.valor ?? [];
  const faltando = obrigatorios.filter((campo) => !campoPreenchido(lead, campo)).map((campo) => ROTULO_CAMPO[campo] ?? campo);

  const situacao = await situacaoDoAtendimento(lead);
  const agora = await agoraNaEmpresa();
  const campanha = lead.campanha_ia_id ? (await campanhasAtivas()).find((c) => c.id === lead.campanha_ia_id) ?? null : null;
  const { anuncio, ...ficha } = (lead.ficha ?? {}) as Record<string, unknown> & { anuncio?: { titulo?: string | null; texto?: string | null } };
  const textoDoAnuncio = [anuncio?.titulo, anuncio?.texto].filter((t) => t && !/^api\.whatsapp\.com$/i.test(t)).join(" — ").slice(0, 1500);

  return [
    `Data e hora no escritório: ${agora}.`,
    `Situação do lead: ${situacao}.`,
    anuncio
      ? `O cliente chegou tocando num anúncio do Facebook/Instagram. ${textoDoAnuncio ? `Texto do anúncio: «${textoDoAnuncio}»` : "O texto do anúncio não veio."}`
      : lead.origem === "disparo"
        ? `O cliente respondeu a uma mensagem de divulgação que a LFG enviou (disparo «${lead.campanha ?? ""}»). Ele não iniciou a conversa: seja breve, pergunte com leveza se ele tem interesse e respeite se não tiver.`
        : "O cliente não veio de anúncio (ou o anúncio não foi informado).",
    `Ficha atual: ${JSON.stringify({
      nome: lead.nome,
      interesse: lead.interesse,
      temperatura: lead.temperatura,
      imovel_de_interesse: lead.imovel_codigo,
      ...ficha,
    })}`,
    faltando.length
      ? `Campos obrigatórios que faltam antes de passar ao corretor (salvo lead quente ou pedido do cliente): ${faltando.join(", ")}.`
      : "Campos obrigatórios: todos preenchidos.",
    ...(campanha ? [textoDaCampanha(campanha)] : []),
  ].join("\n");
}

// Campanha da Thais: o que ela sabe do empreendimento e como atender esse cliente.
function textoDaCampanha(c: { nome: string; base: string; perguntas: string[]; proibido: string; exemplo: string }): string {
  return [
    `\nCampanha deste cliente: ${c.nome}. Ele chegou interessado nesse empreendimento.`,
    "Use só as informações abaixo sobre o empreendimento. Ele não está no estoque: não procure com buscar_imoveis nem consultar_imovel, a não ser que o cliente peça outras opções.",
    `Informações do empreendimento:\n${c.base}`,
    "Como atender: respostas curtas, como no WhatsApp. Nunca cole o texto do anúncio nem estas informações inteiras; responda só o que o cliente perguntou e puxe a próxima pergunta. Ofereça os projetos prontos de casa térrea e sobrado da LFG como diferencial.",
    c.perguntas.length
      ? `Qualifique uma pergunta por vez, nesta ordem, pulando o que já sabe:\n${c.perguntas.map((p, n) => `${n + 1}. ${p}`).join("\n")}\nRegistre cada resposta com atualizar_lead, em ficha.respostas_campanha (a pergunta resumida como chave e a resposta como valor).`
      : "",
    "Objetivo: agendar visita ao local ou apresentação dos projetos com o corretor. Quando o cliente aceitar, passe para o corretor com o motivo quer_visitar.",
    c.proibido ? `Nunca:\n${c.proibido}` : "",
    c.exemplo ? `Exemplo de primeira resposta (adapte ao que o cliente disse; use só na primeira resposta): «${c.exemplo}»` : "",
  ].filter(Boolean).join("\n");
}

async function blocoDoArquivo(mensagem: Mensagem): Promise<Anthropic.Beta.BetaContentBlockParam | null> {
  const tipo = mensagem.midia_tipo ?? "";
  if (!mensagem.midia_url || !(TIPOS_DE_IMAGEM.has(tipo) || tipo === "application/pdf")) return null;
  try {
    const bytes = await lerMidia(mensagem.midia_url);
    if (bytes.length > LIMITE_ARQUIVO_BYTES) return null;
    const data = Buffer.from(bytes).toString("base64");
    return tipo === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
      : { type: "image", source: { type: "base64", media_type: tipo as "image/jpeg", data } };
  } catch (erro) {
    console.warn("Arquivo do cliente não foi aberto para a IA", erro);
    return null;
  }
}

// Mensagem do cliente para o Claude. Áudio vai como transcrição; foto e PDF
// vão como arquivo, com uma nota entre colchetes dizendo o que chegou.
async function conteudoDoCliente(mensagem: Mensagem, abrirArquivo: boolean): Promise<string | Anthropic.Beta.BetaContentBlockParam[]> {
  const texto = mensagem.conteudo?.trim() || null;
  switch (mensagem.tipo) {
    case "audio":
      return texto ? `[Áudio do cliente, transcrito automaticamente] ${texto}` : "[O cliente mandou um áudio que não deu para ouvir.]";
    case "video":
      return `[O cliente mandou um vídeo${texto ? ` com a legenda "${texto}"` : ""}. A assistente não assiste vídeos.]`;
    case "image":
    case "document": {
      const oQue = mensagem.tipo === "image" ? `uma foto${texto ? ` com a legenda "${texto}"` : ""}` : `um documento${texto ? ` ("${texto}")` : ""}`;
      const arquivo = abrirArquivo ? await blocoDoArquivo(mensagem) : null;
      if (arquivo) return [arquivo, { type: "text", text: `[O cliente mandou ${oQue}; o arquivo está acima.]` }];
      return `[O cliente mandou ${oQue}; o arquivo ${abrirArquivo ? "não pôde ser aberto" : "é antigo e não está mais à vista"}.]`;
    }
    default:
      return texto ?? "";
  }
}

// Histórico salvo no banco vira a conversa do Claude: cliente = user, IA e
// corretor = assistant. Mensagens do sistema ficam de fora.
async function montarConversa(historico: Mensagem[]): Promise<Anthropic.Beta.BetaMessageParam[]> {
  const comArquivo = new Set(
    historico.filter((m) => m.autor === "cliente" && (m.tipo === "image" || m.tipo === "document")).slice(-MAX_ARQUIVOS_NA_CONVERSA),
  );
  const doCliente = await Promise.all(historico.map((m) => (m.autor === "cliente" ? conteudoDoCliente(m, comArquivo.has(m)) : null)));

  const porWhatsappId = new Map(historico.filter((m) => m.whatsapp_id).map((m) => [m.whatsapp_id!, m]));
  const conversa: Anthropic.Beta.BetaMessageParam[] = [];
  historico.forEach((mensagem, i) => {
    if (mensagem.autor === "cliente") {
      let conteudo = doCliente[i]!;
      // Resposta citando uma mensagem: a citação vai junto, como o cliente vê.
      const citada = mensagem.cita_whatsapp_id ? porWhatsappId.get(mensagem.cita_whatsapp_id) : null;
      if (citada?.conteudo) {
        const nota = `[Respondendo à mensagem: "${citada.conteudo.replace(/\s+/g, " ").slice(0, 300)}"] `;
        conteudo = typeof conteudo === "string" ? nota + conteudo : [{ type: "text", text: nota }, ...conteudo];
      }
      if (conteudo.length) conversa.push({ role: "user", content: conteudo });
    } else if (mensagem.autor !== "sistema" && mensagem.conteudo) {
      const texto = mensagem.autor === "corretor" ? `[Mensagem enviada pelo corretor] ${mensagem.conteudo}` : mensagem.conteudo;
      conversa.push({ role: "assistant", content: texto });
    }
  });
  // A API exige que a conversa comece pelo cliente.
  while (conversa.length && conversa[0].role !== "user") conversa.shift();
  return conversa;
}

function somarUso(total: UsoDeTokens, uso: Anthropic.Beta.BetaUsage) {
  total.entrada += uso.input_tokens ?? 0;
  total.saida += uso.output_tokens ?? 0;
  total.cache_lido += uso.cache_read_input_tokens ?? 0;
  total.cache_gravado += uso.cache_creation_input_tokens ?? 0;
}

export async function responderLead(leadId: string): Promise<ResultadoAgente> {
  const lead = exigir(await banco.from("leads").select("*").eq("id", leadId).single(), "ler lead") as Lead;
  const historico = (exigir(
    await banco
      .from("mensagens")
      .select("autor, conteudo, tipo, midia_url, midia_tipo, criado_em, whatsapp_id, cita_whatsapp_id")
      .eq("lead_id", leadId)
      .order("criado_em", { ascending: false })
      .limit(LIMITE_HISTORICO),
    "ler histórico",
  ) as Mensagem[]).reverse();

  const resultado: ResultadoAgente = {
    respostas: [],
    ferramentas: [],
    parada: "",
    chamadas: 0,
    uso: { entrada: 0, saida: 0, cache_lido: 0, cache_gravado: 0 },
  };

  const conversa = await montarConversa(historico);
  // A última mensagem precisa ser do cliente; se não for (o corretor ou a IA já
  // falaram depois dele), não há o que responder.
  if (conversa.at(-1)?.role !== "user") return resultado;
  marcarCache(conversa);

  const mensagens: Anthropic.Beta.BetaMessageParam[] = [
    ...conversa,
    // Mensagem de sistema no meio da conversa: dados do momento sem mexer nas
    // instruções fixas (que ficam em cache).
    { role: "system", content: await montarContexto(lead) } as unknown as Anthropic.Beta.BetaMessageParam,
  ];

  let repeticoesPorMarcacao = 0;
  let repeticoesPorRelatorio = 0;
  let pediuMensagem = false;
  for (let rodada = 0; rodada < MAX_RODADAS; rodada++) {
    resultado.chamadas = rodada + 1;
    const resposta = await claude.beta.messages.create({
      model: MODELO,
      max_tokens: 16000,
      system: [{ type: "text", text: INSTRUCOES, cache_control: { type: "ephemeral" } }],
      tools: FERRAMENTAS,
      messages: mensagens,
      output_config: { effort: ESFORCO },
      // Se um filtro de segurança recusar por engano, a Anthropic refaz o pedido
      // em outro modelo recomendado em vez de devolver a recusa.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    somarUso(resultado.uso, resposta.usage);
    resultado.parada = resposta.stop_reason ?? "";

    if (resposta.stop_reason === "refusal") {
      return chamarHumano(resultado, lead, "A assistente não conseguiu responder a última mensagem.");
    }

    if (resposta.stop_reason === "pause_turn") {
      mensagens.push({ role: "assistant", content: resposta.content });
      continue;
    }

    if (resposta.stop_reason === "tool_use") {
      const chamadas = resposta.content.filter((bloco): bloco is Anthropic.Beta.BetaToolUseBlock => bloco.type === "tool_use");
      const executar = (chamada: Anthropic.Beta.BetaToolUseBlock) => executarChamada(chamada, lead, resultado);

      // A mensagem ao cliente veio junto com o registro da ficha: registra e
      // responde sem uma segunda chamada à IA, que só repetiria a resposta.
      const textoJunto = textoDaResposta(resposta.content);
      if (textoJunto && !MARCACAO_INTERNA.test(textoJunto) && chamadas.every((chamada) => chamada.name === "atualizar_lead") && !(await ehRelatorio(textoJunto, lead))) {
        await Promise.all(chamadas.map(executar));
        resultado.respostas = dividirMensagens(textoJunto);
        return resultado;
      }

      // O conteúdo volta inteiro, sem alterar: os blocos de raciocínio do
      // Claude precisam voltar exatamente como vieram.
      mensagens.push({ role: "assistant", content: resposta.content });
      const resultados: Anthropic.Beta.BetaContentBlockParam[] = await Promise.all(chamadas.map(executar));
      // O texto escrito junto com uma busca não sai: sem este aviso, a IA acha
      // que já respondeu e depois escreve um relatório do que fez.
      if (textoJunto) {
        resultados.push({
          type: "text",
          text: "(Aviso do sistema: o texto que você escreveu junto com as ferramentas NÃO foi enviado ao cliente. Depois de ver o resultado, escreva a mensagem completa para o cliente.)",
        });
      }
      mensagens.push({ role: "user", content: resultados });
      continue;
    }

    const texto = textoDaResposta(resposta.content);
    // Depois das ferramentas, a IA às vezes encerra sem escrever, como se já
    // tivesse respondido antes de buscar. Pede a mensagem uma vez.
    if (!texto && !pediuMensagem && mensagens.at(-1)?.role === "user") {
      console.warn("IA encerrou sem mensagem depois das ferramentas; pedindo a resposta.");
      pediuMensagem = true;
      mensagens.push({
        role: "system",
        content: "Escreva agora a mensagem ao cliente, com base no que as ferramentas retornaram.",
      } as unknown as Anthropic.Beta.BetaMessageParam);
      continue;
    }
    if (MARCACAO_INTERNA.test(texto)) {
      console.warn(`Marcação interna na resposta (tentativa ${repeticoesPorMarcacao + 1}): ${texto.slice(0, 200)}`);
      if (repeticoesPorMarcacao < MAX_REPETICOES_POR_MARCACAO) {
        repeticoesPorMarcacao++;
        resultado.parada = "marcacao_interna";
        continue;
      }
      const limpo = semMarcacaoInterna(texto);
      if (limpo) {
        resultado.respostas = dividirMensagens(limpo);
        return resultado;
      }
      return chamarHumano(resultado, lead, "A assistente não conseguiu montar uma resposta válida.");
    }
    if (await ehRelatorio(texto, lead)) {
      console.warn(`Relatório interno na resposta (tentativa ${repeticoesPorRelatorio + 1}): ${texto.slice(0, 200)}`);
      if (repeticoesPorRelatorio < MAX_REPETICOES_POR_RELATORIO) {
        repeticoesPorRelatorio++;
        resultado.parada = "relatorio_interno";
        // O pedido vai como aviso do sistema numa mensagem "user": a API não
        // aceita mensagem "system" logo depois de uma resposta da IA.
        mensagens.push({ role: "assistant", content: resposta.content });
        mensagens.push({ role: "user", content: [{ type: "text", text: `(Aviso do sistema: ${PEDIDO_DE_MENSAGEM_DIRETA})` }] });
        continue;
      }
      return chamarHumano(resultado, lead, "A assistente não conseguiu montar uma mensagem direta ao cliente.");
    }
    resultado.respostas = dividirMensagens(texto);
    return resultado;
  }

  // Muitas rodadas de ferramentas sem resposta final: melhor chamar um humano.
  resultado.parada = "limite_de_rodadas";
  return chamarHumano(resultado, lead, "A assistente não chegou a uma resposta.");
}

async function executarChamada(
  chamada: Anthropic.Beta.BetaToolUseBlock,
  lead: Lead,
  resultado: ResultadoAgente,
): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
  try {
    const saida = await executarFerramenta(chamada.name, chamada.input as Record<string, unknown>, lead);
    resultado.ferramentas.push({ nome: chamada.name, entrada: chamada.input, resultado: saida });
    return { type: "tool_result", tool_use_id: chamada.id, content: JSON.stringify(saida) };
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    resultado.ferramentas.push({ nome: chamada.name, entrada: chamada.input, resultado: mensagem, erro: true });
    return { type: "tool_result", tool_use_id: chamada.id, content: mensagem, is_error: true };
  }
}

// Quando a IA não consegue responder, o cliente não fica sem retorno: o lead
// vai para o rodízio e o cliente é avisado.
async function chamarHumano(resultado: ResultadoAgente, lead: Lead, motivo: string): Promise<ResultadoAgente> {
  await executarFerramenta("passar_para_corretor", {
    motivo: "outro",
    resumo: `${motivo} O cliente precisa de atendimento humano.`,
  }, lead);
  resultado.respostas = [RESPOSTA_DE_SEGURANCA];
  return resultado;
}
