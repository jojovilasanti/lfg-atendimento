import { createClient } from "@supabase/supabase-js";

// Endereço e chave pública do projeto: podem ficar no navegador. Quem protege
// os dados são as regras de acesso (RLS) do banco.
export const SUPABASE_URL = "https://nlbonjxmzmwsyuirxnzu.supabase.co";
const CHAVE_PUBLICA = "sb_publishable_oKbJ2oePBC6Lc916feMfSQ_qlsizS69";

export const supabase = createClient(SUPABASE_URL, CHAVE_PUBLICA);

// Supabase devolve { data, error }; aqui o erro vira exceção.
export function exigir({ data, error }) {
  if (error) throw new Error(error.message);
  return data;
}

// Ações que precisam do servidor (função "painel" no Supabase).
export const chamarPainel = (acao, dados = {}) => chamarFuncao("painel", acao, dados);
// Disparos em massa e modelos da Meta (função "disparos"), só o gestor.
export const chamarDisparos = (acao, dados = {}) => chamarFuncao("disparos", acao, dados);
// Conexão com o Google Agenda de cada pessoa (função "google-agenda").
export const chamarGoogle = (acao, dados = {}) => chamarFuncao("google-agenda", acao, dados);

async function chamarFuncao(funcao, acao, dados) {
  const { data, error } = await supabase.functions.invoke(funcao, { body: { acao, ...dados } });
  if (error) {
    let mensagem = "Não foi possível concluir. Tente de novo.";
    try {
      const corpo = await error.context?.json();
      if (corpo?.erro) mensagem = corpo.erro;
    } catch {
      // resposta sem corpo: fica a mensagem genérica
    }
    throw new Error(mensagem);
  }
  return data;
}

export const mensagemDeErro = (erro) => (erro instanceof Error ? erro.message : String(erro));
