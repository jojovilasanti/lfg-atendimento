// API de imóveis para outro site ou parceiro (Configurações gerais → Chave da API).
//
// GET /functions/v1/api-imoveis   cabeçalho x-api-key: <chave gerada pelo gestor>
//   200 { total, gerado_em, imoveis: [...] }   401 sem chave ou chave errada
// Quais campos e quais imóveis saem é decidido no banco (public.api_imoveis).
import { banco } from "../_shared/banco.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "x-api-key, authorization, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function responder(corpo: unknown, status = 200, extras: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", ...extras },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "GET") return responder({ erro: "Use GET." }, 405);

  const chave = (req.headers.get("x-api-key") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "").trim();
  if (!/^lfg_[0-9a-f]{48}$/.test(chave)) return responder({ erro: "Informe a chave no cabeçalho x-api-key." }, 401);

  const { data, error } = await banco.rpc("api_imoveis", { p_chave: chave });
  if (error) {
    console.error("api_imoveis", error);
    return responder({ erro: "Não foi possível ler os imóveis agora. Tente de novo." }, 500);
  }
  if (data === null) return responder({ erro: "Chave inválida ou desligada." }, 401);
  const imoveis = data as unknown[];
  return responder({ total: imoveis.length, gerado_em: new Date().toISOString(), imoveis }, 200, { "Cache-Control": "private, max-age=60" });
});
