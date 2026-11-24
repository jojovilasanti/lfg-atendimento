// Fotos, áudios e documentos do cliente: o arquivo vai para o bucket privado
// "midias" (pasta do cliente) e o áudio é transcrito no serviço da VPS.
import { banco, exigir } from "./banco.ts";
import { baixarMidia } from "./whatsapp.ts";

export const TRANSCRICAO_URL = "https://srv2083149.hstgr.cloud/transcrever";
const CONVERSAO_URL = "https://srv2083149.hstgr.cloud/converter";
// Limite do bucket. O WhatsApp já limita áudio e vídeo a 16 MB.
const LIMITE_BYTES = 20 * 1024 * 1024;
// Áudio que não fica pronto nesse tempo vira aviso, e a IA pede o resumo por escrito.
const LIMITE_TRANSCRICAO_MS = 75_000;

const EXTENSOES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/amr": "amr",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/plain": "txt",
  "text/csv": "csv",
};

export type MidiaGuardada = { caminho: string; tipo: string; bytes: Uint8Array<ArrayBuffer> };

export async function guardarMidia(whatsapp: string, midiaId: string): Promise<MidiaGuardada> {
  const { bytes, tipo } = await baixarMidia(midiaId, LIMITE_BYTES);
  const caminho = `${whatsapp}/${midiaId}.${EXTENSOES[tipo] ?? "bin"}`;
  exigir(await banco.storage.from("midias").upload(caminho, bytes, { contentType: tipo, upsert: true }), "guardar mídia");
  return { caminho, tipo, bytes };
}

// Devolve o texto falado; vazio quando o áudio não tem fala reconhecível.
export async function transcreverAudio(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const token = exigir(await banco.rpc("segredo_transcricao"), "ler token da transcrição") as string;
  const resposta = await fetch(TRANSCRICAO_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
    body: bytes,
    signal: AbortSignal.timeout(LIMITE_TRANSCRICAO_MS),
  });
  const json = await resposta.json().catch(() => ({})) as { texto?: string; erro?: string; duracao_s?: number; processamento_s?: number };
  if (!resposta.ok) throw new Error(`Transcrição recusada (HTTP ${resposta.status}): ${json.erro ?? "sem detalhe"}`);
  console.log(`Áudio de ${json.duracao_s}s transcrito em ${json.processamento_s}s.`);
  return (json.texto ?? "").trim();
}

// Áudio gravado no painel (WebM, MP4 ou Ogg, conforme o navegador) vira Ogg/Opus,
// o formato de mensagem de voz do WhatsApp. A conversão roda no mesmo serviço
// da VPS que transcreve.
export async function converterParaVoz(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const token = exigir(await banco.rpc("segredo_transcricao"), "ler token da transcrição") as string;
  const resposta = await fetch(CONVERSAO_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
    body: bytes,
    signal: AbortSignal.timeout(30_000),
  });
  if (!resposta.ok) {
    const json = await resposta.json().catch(() => ({})) as { erro?: string };
    throw new Error(`Conversão do áudio recusada (HTTP ${resposta.status}): ${json.erro ?? "sem detalhe"}`);
  }
  return new Uint8Array(await resposta.arrayBuffer());
}

// Arquivo do bucket para a IA ler (fotos e PDFs).
export async function lerMidia(caminho: string): Promise<Uint8Array<ArrayBuffer>> {
  const arquivo = exigir(await banco.storage.from("midias").download(caminho), "ler mídia") as Blob;
  return new Uint8Array(await arquivo.arrayBuffer());
}
