import { banco, exigir } from "./banco.ts";

export async function sha256(texto: string): Promise<string> {
  const resumo = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
  return Array.from(new Uint8Array(resumo), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Confere um valor contra o hash guardado em chaves_acesso (o valor em si fica
// só no .env.local de quem administra).
export async function confereChave(nome: string, valor: string | null): Promise<boolean> {
  if (!valor) return false;
  const registro = exigir(
    await banco.from("chaves_acesso").select("hash_sha256").eq("nome", nome).maybeSingle(),
    `ler chave ${nome}`,
  ) as { hash_sha256: string } | null;
  return registro !== null && registro.hash_sha256 === (await sha256(valor));
}

// Ferramentas internas (simulador, saúde, número do WhatsApp) usam a chave do
// simulador no cabeçalho x-simulador-chave.
export function chaveInternaValida(req: Request): Promise<boolean> {
  return confereChave("simulador", req.headers.get("x-simulador-chave"));
}

export function json(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
