// Confere se os segredos do sistema estão configurados, sem revelar valores:
// mostra só se existem, o tamanho e o formato público (ex.: começa com sk-ant-api).
// Também confere se o serviço de transcrição da VPS aceita o token do Vault.
//
// POST /functions/v1/saude
// Cabeçalho: x-simulador-chave
import { chaveInternaValida, json } from "../_shared/acesso.ts";
import { banco, exigir } from "../_shared/banco.ts";
import { TRANSCRICAO_URL } from "../_shared/midia.ts";

const SEGREDOS = ["ANTHROPIC_API_KEY", "WHATSAPP_TOKEN", "WHATSAPP_APP_SECRET", "WHATSAPP_PHONE_NUMBER_ID", "UNIVEN_API_TOKEN"];

// Formatos conhecidos: chave da Anthropic (sk-ant-...), token da Meta (EAA...),
// chave secreta do app da Meta (32 caracteres hexadecimais), ID numérico,
// UUID e JWT (três partes separadas por ponto).
function formato(valor: string): string {
  const limpo = valor.trim();
  const anthropic = limpo.match(/^sk-ant-[a-z]{3}/);
  if (anthropic) return anthropic[0];
  if (/^EAA[A-Za-z0-9]+$/.test(limpo)) return "token da Meta (EAA...)";
  if (/^[0-9a-f]{32}$/.test(limpo)) return "32 caracteres hexadecimais";
  if (/^[0-9]+$/.test(limpo)) return "só números";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(limpo)) return "UUID";
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(limpo)) return "JWT";
  if (/^[A-Za-z0-9]+$/.test(limpo)) return "letras e números";
  return "desconhecido";
}

function descrever(valor: string | undefined) {
  if (valor === undefined) return { configurado: false };
  return {
    configurado: true,
    tamanho: valor.length,
    formato: formato(valor),
    espacos_ou_quebras_nas_pontas: valor !== valor.trim(),
    aspas: /^["']|["']$/.test(valor.trim()),
  };
}

// Pedido sem áudio: 413 quer dizer token aceito; 401, token diferente do hash da VPS.
async function transcricao() {
  try {
    const token = exigir(await banco.rpc("segredo_transcricao"), "ler token da transcrição") as string;
    const resposta = await fetch(TRANSCRICAO_URL, { method: "POST", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    await resposta.body?.cancel();
    return { status: resposta.status, token_aceito: resposta.status === 413 };
  } catch (erro) {
    return { erro: erro instanceof Error ? erro.message : String(erro) };
  }
}

Deno.serve(async (req) => {
  if (!(await chaveInternaValida(req))) return json({ erro: "Chave inválida." }, 401);
  return json({
    ...Object.fromEntries(SEGREDOS.map((nome) => [nome, descrever(Deno.env.get(nome))])),
    transcricao: await transcricao(),
  });
});
