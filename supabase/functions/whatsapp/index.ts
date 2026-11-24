// Webhook da API oficial do WhatsApp.
// GET: a Meta confirma o endereço com o token de verificação.
// POST: avisos de mensagens recebidas e de entrega. A resposta 200 sai na hora
// e o atendimento continua em segundo plano, para a Meta não reenviar o aviso.
import { confereChave } from "../_shared/acesso.ts";
import { type MidiaDoCliente, receberMensagemDoCliente } from "../_shared/atendimento.ts";
import { banco, exigir } from "../_shared/banco.ts";
import { guardarMidia, transcreverAudio } from "../_shared/midia.ts";
import { BOTAO_DA_OFERTA, type RespostaDaOferta, textoDaResposta } from "../_shared/rodizio.ts";
import { variantesWhatsapp } from "../_shared/telefone.ts";
import { assinaturaValida, enviarTexto, marcarComoLida } from "../_shared/whatsapp.ts";

declare const EdgeRuntime: { waitUntil(promessa: Promise<unknown>): void };

// Tempo para juntar mensagens que o cliente manda em sequência. Se outra chegar
// enquanto a IA pensa, a resposta da anterior é descartada (atendimento.ts).
const ESPERA_ENTRE_MENSAGENS_MS = 2500;

type MidiaWhatsApp = { id: string; mime_type?: string; caption?: string; filename?: string };

type MensagemWhatsApp = {
  id: string;
  from: string;
  type: string;
  text?: { body: string };
  button?: { text: string; payload?: string };
  interactive?: { button_reply?: { title: string }; list_reply?: { title: string } };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  image?: MidiaWhatsApp;
  audio?: MidiaWhatsApp;
  video?: MidiaWhatsApp;
  document?: MidiaWhatsApp;
  referral?: { headline?: string; body?: string; source_url?: string; source_type?: string; source_id?: string; media_type?: string };
  // Quando o cliente responde citando uma mensagem.
  context?: { id?: string; from?: string };
};

async function verificarEndereco(url: URL): Promise<Response> {
  const tokenValido = await confereChave("whatsapp_verificacao", url.searchParams.get("hub.verify_token"));
  if (url.searchParams.get("hub.mode") === "subscribe" && tokenValido) {
    return new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 });
  }
  return new Response("Token de verificação inválido", { status: 403 });
}

// Arquivo guardado no bucket; o áudio ainda é transcrito para a IA ler como texto.
async function prepararMidia(cliente: string, tipo: string, midia: MidiaWhatsApp) {
  const guardada = await guardarMidia(cliente, midia.id);
  if (tipo !== "audio") return { caminho: guardada.caminho, tipo: guardada.tipo };
  const texto = await transcreverAudio(guardada.bytes).catch((erro) => {
    console.error("Áudio não foi transcrito", erro);
    return null;
  });
  return { caminho: guardada.caminho, tipo: guardada.tipo, texto };
}

// Converte cada tipo de mensagem em texto para a IA. Foto, áudio, vídeo e
// documento levam o arquivo, que é baixado depois que a mensagem é registrada.
function lerConteudo(mensagem: MensagemWhatsApp): { texto: string | null; tipo: string; midia?: MidiaDoCliente } | null {
  switch (mensagem.type) {
    case "text":
      return { texto: mensagem.text?.body ?? "", tipo: "texto" };
    case "button":
      return { texto: mensagem.button?.text ?? "", tipo: "botao" };
    case "interactive":
      return { texto: mensagem.interactive?.button_reply?.title ?? mensagem.interactive?.list_reply?.title ?? "", tipo: "botao" };
    case "location": {
      const l = mensagem.location!;
      return { texto: `[Localização enviada: ${[l.name, l.address].filter(Boolean).join(", ") || "sem nome"} (${l.latitude}, ${l.longitude})]`, tipo: "localizacao" };
    }
    case "image":
    case "audio":
    case "video":
    case "document": {
      const midia = mensagem[mensagem.type];
      if (!midia?.id) return null;
      return {
        texto: midia.caption ?? midia.filename ?? null,
        tipo: mensagem.type,
        midia: {
          tipo: midia.mime_type?.split(";")[0].trim() || "application/octet-stream",
          preparar: () => prepararMidia(mensagem.from, mensagem.type, midia),
        },
      };
    }
    case "reaction":
    case "sticker":
      return null; // reação e figurinha não pedem resposta
    default:
      return { texto: `[O cliente enviou uma mensagem do tipo ${mensagem.type}, que a assistente não consegue ler.]`, tipo: mensagem.type };
  }
}

// A Meta manda alguns celulares sem o 9; o cadastro da equipe tem o número completo.
// Os números de teste (configuracoes.numeros_de_teste) são atendidos como cliente
// mesmo sendo da equipe.
async function ehCorretor(numero: string): Promise<boolean> {
  const variantes = variantesWhatsapp(numero);
  const [corretores, teste] = await Promise.all([
    banco.from("corretores").select("id").in("whatsapp", variantes).limit(1),
    banco.from("configuracoes").select("valor").eq("chave", "numeros_de_teste").maybeSingle(),
  ]);
  const numerosDeTeste = (exigir(teste, "ler números de teste") as { valor: string[] } | null)?.valor ?? [];
  if (numerosDeTeste.some((n) => variantes.includes(n))) return false;
  return (exigir(corretores, "procurar corretor") as unknown[]).length > 0;
}

// Toque do corretor em Assumir ou Não posso agora, no aviso do rodízio.
async function responderOferta(mensagem: MensagemWhatsApp, aceitar: boolean, atribuicaoId: string) {
  marcarComoLida(mensagem.id).catch((erro) => console.warn("Não marcou como lida", erro));
  const resposta = exigir(
    await banco.rpc("responder_oferta", { p_atribuicao_id: atribuicaoId, p_whatsapp: variantesWhatsapp(mensagem.from), p_aceitar: aceitar }),
    "responder oferta",
  ) as RespostaDaOferta;
  console.log(`Corretor respondeu à oferta: ${resposta.situacao}${resposta.status ? ` (${resposta.status})` : ""}.`);
  await enviarTexto(mensagem.from, textoDaResposta(resposta));
}

// Saída da lista de divulgação: botão "Não quero receber" dos disparos ou a
// mensagem inteira SAIR / PARAR. A escolha fica guardada para sempre.
const PEDIDO_DE_SAIDA = /^\s*(sair|parar|pare|stop|n[aã]o quero receber( mais)?)\s*[.!]*\s*$/i;
const CONFIRMACAO_DE_SAIDA =
  "Pronto! Você não vai mais receber nossas mensagens de divulgação. Se precisar de algo sobre imóveis, é só escrever aqui. 😊";

async function pedidoDeSaida(mensagem: MensagemWhatsApp): Promise<boolean> {
  const texto = mensagem.type === "button" ? mensagem.button?.text ?? "" : mensagem.type === "text" ? mensagem.text?.body ?? "" : "";
  if (!PEDIDO_DE_SAIDA.test(texto)) return false;
  exigir(await banco.rpc("registrar_descadastro", { p_telefone: mensagem.from, p_origem: mensagem.type === "button" ? "botao" : "texto" }), "registrar saída da lista");
  marcarComoLida(mensagem.id).catch(() => {});
  await enviarTexto(mensagem.from, CONFIRMACAO_DE_SAIDA).catch((erro) => console.warn("Confirmação de saída não saiu", erro));
  console.log("Contato saiu da lista de divulgação.");
  return true;
}

// Resposta a um disparo dos últimos 30 dias: marca como respondeu e devolve o
// nome do disparo, que vai para a ficha do lead.
async function campanhaRespondida(numero: string): Promise<string | null> {
  const desde = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const achado = (await banco
    .from("campanha_destinatarios")
    .select("id, campanhas(nome)")
    .in("telefone", variantesWhatsapp(numero))
    .in("status", ["enviado", "entregue", "lido", "respondeu"])
    .gte("enviado_em", desde)
    .order("enviado_em", { ascending: false })
    .limit(1)).data?.[0] as { id: number; campanhas: { nome: string } | null } | undefined;
  if (!achado) return null;
  await banco.from("campanha_destinatarios").update({ status: "respondeu", atualizado_em: new Date().toISOString() }).eq("id", achado.id);
  return achado.campanhas?.nome ?? "Disparo";
}

async function tratarMensagem(mensagem: MensagemWhatsApp, nome: string | null) {
  const botao = mensagem.type === "button" ? mensagem.button?.payload?.match(BOTAO_DA_OFERTA) : null;
  if (botao) return responderOferta(mensagem, botao[1] === "assumir", botao[2]);

  // Mensagens da equipe para o número oficial não viram lead.
  if (await ehCorretor(mensagem.from)) {
    console.log(`Mensagem de corretor ignorada pelo atendimento (${mensagem.type}).`);
    return;
  }
  if (await pedidoDeSaida(mensagem)) return;
  const conteudo = lerConteudo(mensagem);
  if (!conteudo || (!conteudo.texto?.trim() && !conteudo.midia)) return;

  marcarComoLida(mensagem.id).catch((erro) => console.warn("Não marcou como lida", erro));

  const disparo = mensagem.referral ? null : await campanhaRespondida(mensagem.from).catch(() => null);
  // Clique em anúncio "Enviar mensagem" da Meta traz o anúncio de origem.
  const anuncio = mensagem.referral;
  await receberMensagemDoCliente({
    whatsapp: mensagem.from,
    nome,
    texto: conteudo.texto,
    tipo: conteudo.tipo,
    midia: conteudo.midia,
    whatsappId: mensagem.id,
    citaWhatsappId: mensagem.context?.id ?? null,
    origem: anuncio ? "anuncio" : disparo ? "disparo" : "whatsapp",
    campanha: anuncio ? anuncio.headline ?? anuncio.source_url ?? null : disparo,
    anuncio: anuncio
      ? { titulo: anuncio.headline ?? null, texto: anuncio.body ?? null, tipo: anuncio.source_type ?? null, id: anuncio.source_id ?? null, url: anuncio.source_url ?? null }
      : undefined,
    aguardarMs: ESPERA_ENTRE_MENSAGENS_MS,
    enviar: (texto) => enviarTexto(mensagem.from, texto),
    aoComecarResposta: () => {
      marcarComoLida(mensagem.id, true).catch((erro) => console.warn("Não mostrou \"digitando\"", erro));
    },
  });
}

// A entrega vale para mensagens das conversas e para os avisos aos corretores.
async function atualizarEntrega(status: { id: string; status: string; errors?: { title?: string }[] }) {
  const situacao = status.status === "failed" ? `falhou: ${status.errors?.[0]?.title ?? "sem detalhe"}` : status.status;
  // Disparos: enviado → entregue → lido; falhou guarda o motivo. Quem já
  // respondeu ou saiu da lista não volta atrás.
  const doDisparo = ({ sent: "enviado", delivered: "entregue", read: "lido", failed: "falhou" } as Record<string, string>)[status.status];
  const [mensagem, aviso, disparo] = await Promise.all([
    banco.from("mensagens").update({ status_entrega: situacao }).eq("whatsapp_id", status.id),
    banco.from("atribuicoes").update({ aviso_status: situacao }).eq("aviso_whatsapp_id", status.id),
    doDisparo
      ? banco.from("campanha_destinatarios")
        .update({ status: doDisparo, atualizado_em: new Date().toISOString(), ...(doDisparo === "falhou" ? { erro: situacao.slice(0, 300) } : {}) })
        .eq("whatsapp_id", status.id).not("status", "in", "(respondeu,descadastrado)")
      : Promise.resolve({ error: null }),
  ]);
  for (const { error } of [mensagem, aviso, disparo]) if (error) console.warn("Não atualizou a entrega", error.message);
}

async function processarAviso(aviso: Record<string, unknown>) {
  const numeroOficial = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID")?.trim();
  for (const entrada of (aviso.entry as { changes?: { field: string; value: Record<string, unknown> }[] }[] | undefined) ?? []) {
    for (const mudanca of entrada.changes ?? []) {
      if (mudanca.field !== "messages") continue;
      const valor = mudanca.value as {
        metadata?: { phone_number_id?: string };
        contacts?: { wa_id: string; profile?: { name?: string } }[];
        messages?: MensagemWhatsApp[];
        statuses?: { id: string; status: string; errors?: { title?: string }[] }[];
      };
      // Avisos de outro número da mesma conta não são deste atendimento.
      if (numeroOficial && valor.metadata?.phone_number_id && valor.metadata.phone_number_id !== numeroOficial) continue;
      for (const status of valor.statuses ?? []) await atualizarEntrega(status);
      const nomes = new Map((valor.contacts ?? []).map((c) => [c.wa_id, c.profile?.name ?? null]));
      await Promise.all((valor.messages ?? []).map((m) => tratarMensagem(m, nomes.get(m.from) ?? null)));
    }
  }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET") return verificarEndereco(url);
  if (req.method !== "POST") return new Response("Use POST", { status: 405 });

  const corpo = await req.text();
  if (!(await assinaturaValida(corpo, req.headers.get("x-hub-signature-256")))) {
    return new Response("Assinatura inválida", { status: 401 });
  }
  let aviso: Record<string, unknown>;
  try {
    aviso = JSON.parse(corpo);
  } catch {
    return new Response("Corpo inválido", { status: 400 });
  }
  EdgeRuntime.waitUntil(processarAviso(aviso).catch((erro) => console.error("Falha ao processar aviso do WhatsApp", erro)));
  return new Response("ok", { status: 200 });
});
