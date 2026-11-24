// API oficial do WhatsApp (Cloud API da Meta).
// Segredos no Supabase: WHATSAPP_TOKEN (token permanente) e
// WHATSAPP_PHONE_NUMBER_ID (ID do número). WHATSAPP_API_VERSION é opcional.
const VERSAO_API = Deno.env.get("WHATSAPP_API_VERSION") ?? "v23.0";

function credenciais(): { token: string; numeroId: string } {
  const token = Deno.env.get("WHATSAPP_TOKEN")?.trim();
  const numeroId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID")?.trim();
  if (!token || !numeroId) throw new Error("WhatsApp sem configuração: faltam WHATSAPP_TOKEN ou WHATSAPP_PHONE_NUMBER_ID.");
  return { token, numeroId };
}

// `caminho` é relativo ao número (ex.: "messages") ou absoluto quando começa com "/".
async function chamarApi(caminho: string, metodo: "GET" | "POST", corpo?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { token, numeroId } = credenciais();
  const endereco = caminho.startsWith("/")
    ? `https://graph.facebook.com/${VERSAO_API}${caminho}`
    : `https://graph.facebook.com/${VERSAO_API}/${numeroId}${caminho ? `/${caminho}` : ""}`;
  const resposta = await fetch(endereco, {
    method: metodo,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const json = await resposta.json().catch(() => ({}));
  if (!resposta.ok) {
    const erro = (json as { error?: { message?: string; code?: number } }).error;
    throw new Error(`WhatsApp recusou (HTTP ${resposta.status}${erro?.code ? `, código ${erro.code}` : ""}): ${erro?.message ?? "sem detalhe"}`);
  }
  return json;
}

// Devolve o ID da mensagem no WhatsApp (wamid), usado para acompanhar a entrega.
// Com `citar` (wamid de uma mensagem da conversa), o cliente recebe a resposta
// citando aquela mensagem, como no WhatsApp.
export async function enviarTexto(para: string, texto: string, citar?: string | null): Promise<string | null> {
  const json = await chamarApi("messages", "POST", {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: para,
    ...(citar ? { context: { message_id: citar } } : {}),
    type: "text",
    text: { body: texto, preview_url: true },
  });
  return (json.messages as { id: string }[] | undefined)?.[0]?.id ?? null;
}

// Sobe um arquivo para a Meta; o ID devolvido é o que vai na mensagem.
export async function subirMidia(bytes: Uint8Array<ArrayBuffer>, tipo: string, nomeDoArquivo: string): Promise<string> {
  const { token, numeroId } = credenciais();
  const corpo = new FormData();
  corpo.append("messaging_product", "whatsapp");
  corpo.append("type", tipo);
  corpo.append("file", new Blob([bytes], { type: tipo }), nomeDoArquivo);
  const resposta = await fetch(`https://graph.facebook.com/${VERSAO_API}/${numeroId}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: corpo,
  });
  const json = await resposta.json().catch(() => ({})) as { id?: string; error?: { message?: string } };
  if (!resposta.ok || !json.id) throw new Error(`WhatsApp recusou o arquivo (HTTP ${resposta.status}): ${json.error?.message ?? "sem detalhe"}`);
  return json.id;
}

// Foto ou documento por link: a Meta baixa o arquivo do endereço (assinado e
// temporário) e entrega ao cliente. Foto: JPG ou PNG até 5 MB; documento até 100 MB.
export async function enviarArquivo(
  para: string,
  tipo: "image" | "document",
  link: string,
  opcoes: { legenda?: string | null; nomeDoArquivo?: string | null; citar?: string | null } = {},
): Promise<string | null> {
  const arquivo: Record<string, string> = { link };
  if (opcoes.legenda) arquivo.caption = opcoes.legenda;
  if (tipo === "document" && opcoes.nomeDoArquivo) arquivo.filename = opcoes.nomeDoArquivo;
  const json = await chamarApi("messages", "POST", {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: para,
    ...(opcoes.citar ? { context: { message_id: opcoes.citar } } : {}),
    type: tipo,
    [tipo]: arquivo,
  });
  return (json.messages as { id: string }[] | undefined)?.[0]?.id ?? null;
}

export async function enviarAudio(para: string, midiaId: string): Promise<string | null> {
  const json = await chamarApi("messages", "POST", {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: para,
    type: "audio",
    audio: { id: midiaId },
  });
  return (json.messages as { id: string }[] | undefined)?.[0]?.id ?? null;
}

// Mensagem-modelo aprovada pela Meta, a única que abre conversa com quem não
// escreveu nas últimas 24 horas. `botoes` são os códigos devolvidos no webhook
// quando a pessoa toca em cada botão de resposta rápida, na ordem do modelo.
export async function enviarModelo(para: string, modelo: string, variaveis: string[], botoes: string[] = []): Promise<string | null> {
  const json = await chamarApi("messages", "POST", {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: para,
    type: "template",
    template: {
      name: modelo,
      language: { code: "pt_BR" },
      components: [
        // Modelo sem variáveis no texto não leva o componente "body".
        ...(variaveis.length ? [{ type: "body", parameters: variaveis.map((text) => ({ type: "text", text })) }] : []),
        ...botoes.map((payload, index) => ({
          type: "button",
          sub_type: "quick_reply",
          index: String(index),
          parameters: [{ type: "payload", payload }],
        })),
      ],
    },
  });
  return (json.messages as { id: string }[] | undefined)?.[0]?.id ?? null;
}

// Modelos ficam na conta do WhatsApp (WABA) e passam pela aprovação da Meta.
export function criarModelo(contaId: string, modelo: Record<string, unknown>): Promise<Record<string, unknown>> {
  return chamarApi(`/${contaId}/message_templates`, "POST", modelo);
}

export function listarModelos(contaId: string): Promise<Record<string, unknown>> {
  return chamarApi(`/${contaId}/message_templates?fields=name,status,category,language,rejected_reason`, "GET");
}

// Com o texto de cada modelo (componentes), para o painel mostrar e escolher.
export function listarModelosDetalhados(contaId: string): Promise<Record<string, unknown>> {
  return chamarApi(`/${contaId}/message_templates?fields=name,status,category,language,rejected_reason,components&limit=100`, "GET");
}

// Arquivo que o cliente mandou (foto, áudio, documento). A Meta devolve um
// endereço temporário, que só abre com o mesmo token.
export async function baixarMidia(midiaId: string, limiteBytes: number): Promise<{ bytes: Uint8Array<ArrayBuffer>; tipo: string }> {
  const info = await chamarApi(`/${midiaId}`, "GET") as { url?: string; mime_type?: string; file_size?: number };
  if (!info.url) throw new Error("A Meta não informou o endereço da mídia.");
  if ((info.file_size ?? 0) > limiteBytes) throw new Error(`Mídia de ${info.file_size} bytes, acima do limite de ${limiteBytes}.`);
  const resposta = await fetch(info.url, { headers: { Authorization: `Bearer ${credenciais().token}` } });
  if (!resposta.ok) throw new Error(`Download da mídia recusado (HTTP ${resposta.status}).`);
  const bytes = new Uint8Array(await resposta.arrayBuffer());
  if (bytes.length > limiteBytes) throw new Error(`Mídia de ${bytes.length} bytes, acima do limite de ${limiteBytes}.`);
  return { bytes, tipo: (info.mime_type ?? resposta.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim() };
}

// Os dois tracinhos azuis: o cliente vê que a mensagem foi lida. Com `digitando`,
// aparece também "digitando…" até a resposta sair (ou por até 25 segundos).
export async function marcarComoLida(mensagemId: string, digitando = false): Promise<void> {
  await chamarApi("messages", "POST", {
    messaging_product: "whatsapp",
    status: "read",
    message_id: mensagemId,
    ...(digitando ? { typing_indicator: { type: "text" } } : {}),
  });
}

// Situação do número na Meta: nome aprovado, verificação, qualidade e se já está ligado à API.
export function consultarNumero(): Promise<Record<string, unknown>> {
  const campos = ["display_phone_number", "verified_name", "name_status", "code_verification_status", "quality_rating", "platform_type", "status", "messaging_limit_tier"];
  return chamarApi(`?fields=${campos.join(",")}`, "GET");
}

// Conta do WhatsApp (WABA): moeda e revisão da Meta. A forma de pagamento não
// aparece aqui: a Meta só mostra esse campo a provedores (BSP).
export function consultarConta(contaId: string): Promise<Record<string, unknown>> {
  const campos = ["name", "currency", "timezone_id", "account_review_status", "business_verification_status"];
  return chamarApi(`/${contaId}?fields=${campos.join(",")}`, "GET");
}

// Liga o número à Cloud API. O PIN de 6 dígitos vira a confirmação em duas
// etapas do número; guarde-o, ele é pedido se o número for registrado de novo.
export function registrarNumero(pin: string): Promise<Record<string, unknown>> {
  return chamarApi("register", "POST", { messaging_product: "whatsapp", pin });
}

// Faz a conta do WhatsApp (WABA) mandar os avisos de mensagem para o nosso app.
export function assinarAvisosDaConta(contaId: string): Promise<Record<string, unknown>> {
  return chamarApi(`/${contaId}/subscribed_apps`, "POST");
}

// Confere a assinatura X-Hub-Signature-256 que a Meta manda em cada aviso,
// com a chave secreta do app (WHATSAPP_APP_SECRET).
export async function assinaturaValida(corpo: string, cabecalho: string | null): Promise<boolean> {
  const segredo = Deno.env.get("WHATSAPP_APP_SECRET")?.trim();
  if (!segredo || !cabecalho?.startsWith("sha256=")) return false;
  const chave = await crypto.subtle.importKey("raw", new TextEncoder().encode(segredo), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const assinatura = new Uint8Array(await crypto.subtle.sign("HMAC", chave, new TextEncoder().encode(corpo)));
  const esperado = Array.from(assinatura, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const recebido = cabecalho.slice("sha256=".length).toLowerCase();
  if (recebido.length !== esperado.length) return false;
  let diferenca = 0;
  for (let i = 0; i < esperado.length; i++) diferenca |= esperado.charCodeAt(i) ^ recebido.charCodeAt(i);
  return diferenca === 0;
}
