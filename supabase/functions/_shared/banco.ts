import { createClient } from "npm:@supabase/supabase-js@2.118.0";

// Chave de servidor: ignora as regras de acesso (RLS). Nunca vai para o navegador.
// Projetos novos usam SUPABASE_SECRET_KEYS; a chave antiga vale até o fim de 2026.
function chaveDoServidor(): string {
  const novas = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (novas) return JSON.parse(novas).default;
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
}

export const banco = createClient(Deno.env.get("SUPABASE_URL")!, chaveDoServidor(), {
  auth: { persistSession: false, autoRefreshToken: false },
});

export type Lead = {
  id: string;
  whatsapp: string;
  nome: string | null;
  origem: string | null;
  campanha: string | null;
  status: string;
  temperatura: string | null;
  interesse: string | null;
  ficha: Record<string, unknown>;
  resumo: string | null;
  imovel_codigo: string | null;
  corretor_id: string | null;
  ia_ativa: boolean;
  campanha_ia_id?: string | null;
  // Triagem: cliente, empresa (vende produto/serviço) ou outros. Vazio = não classificado.
  categoria?: string | null;
};

export type Mensagem = {
  autor: "cliente" | "ia" | "corretor" | "sistema";
  conteudo: string | null;
  tipo: string;
  midia_url: string | null;
  midia_tipo: string | null;
  criado_em: string;
  whatsapp_id?: string | null;
  cita_whatsapp_id?: string | null;
};

// Supabase devolve { data, error }; aqui o erro vira exceção com contexto.
export function exigir<T>(resultado: { data: T | null; error: { message: string } | null }, contexto: string): T {
  if (resultado.error) throw new Error(`${contexto}: ${resultado.error.message}`);
  return resultado.data as T;
}
