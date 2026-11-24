import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { definirFuso } from "./comum.jsx";
import { desligarDaConta } from "./notificacoes.js";
import { supabase } from "./supabase.js";

const ContextoSessao = createContext(null);

// Configurações gerais da empresa. Antes do login só nome, logo e fuso (empresa_publica).
export const EMPRESA_PADRAO = {
  nome: "LFG Imóveis",
  logo_url: null,
  fuso: "America/Campo_Grande",
  marca: { ativa: true, imagem_url: null, tamanho: 42, posicao: "centro", opacidade: 55 },
  rodape_descricao: "",
  api: { mostrar_internos: false, mostrar_indisponiveis: false },
};
export const logoDaEmpresa = (empresa) => empresa?.logo_url || "/logo-lfg.png";

// Sessão do Supabase + cadastro da pessoa na equipe (tabela corretores) +
// "versão" que aumenta a cada mudança em tempo real, para as telas recarregarem.
export function SessaoProvider({ children }) {
  const [sessao, setSessao] = useState(undefined);
  const [eu, setEu] = useState(undefined);
  const [versao, setVersao] = useState(0);
  const [empresa, setEmpresa] = useState(EMPRESA_PADRAO);
  const [versaoEmpresa, setVersaoEmpresa] = useState(0);
  const espera = useRef(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSessao(data.session));
    const { data } = supabase.auth.onAuthStateChange((_evento, nova) => setSessao(nova));
    return () => data.subscription.unsubscribe();
  }, []);

  const usuarioId = sessao?.user?.id;
  const recarregarEu = useCallback(async () => {
    if (!usuarioId) return setEu(null);
    const { data } = await supabase.from("corretores").select("*").eq("usuario_id", usuarioId).maybeSingle();
    setEu(data ?? null);
  }, [usuarioId]);

  useEffect(() => {
    if (sessao !== undefined) recarregarEu();
  }, [sessao, recarregarEu, versao]);

  useEffect(() => {
    if (sessao === undefined) return;
    let vivo = true;
    (async () => {
      const lida = usuarioId
        ? (await supabase.from("configuracoes").select("valor").eq("chave", "empresa").maybeSingle()).data?.valor
        : (await supabase.rpc("empresa_publica")).data;
      if (!vivo || !lida) return;
      const nova = { ...EMPRESA_PADRAO, ...lida, marca: { ...EMPRESA_PADRAO.marca, ...(lida.marca ?? {}) } };
      definirFuso(nova.fuso);
      setEmpresa(nova);
    })();
    return () => {
      vivo = false;
    };
  }, [sessao, usuarioId, versaoEmpresa]);

  // Tempo real: qualquer mudança nessas tabelas faz as telas recarregarem.
  useEffect(() => {
    if (!usuarioId) return;
    const avisar = () => {
      clearTimeout(espera.current);
      espera.current = setTimeout(() => setVersao((v) => v + 1), 300);
    };
    const canal = supabase.channel("painel-lfg");
    for (const tabela of ["leads", "mensagens", "atribuicoes", "corretores", "tarefas", "atividades"]) {
      canal.on("postgres_changes", { event: "*", schema: "public", table: tabela }, avisar);
    }
    canal.subscribe();
    return () => {
      clearTimeout(espera.current);
      supabase.removeChannel(canal);
    };
  }, [usuarioId]);

  const valor = {
    sessao,
    eu,
    versao,
    // Gestão: gestor ou administrativo (o administrativo vê e faz o que o gestor faz,
    // menos criar acessos, site e disparos: para isso, souGestorPleno).
    souGestor: eu?.papel === "gestor" || eu?.papel === "administrativo",
    souGestorPleno: eu?.papel === "gestor",
    empresa,
    recarregarEmpresa: () => setVersaoEmpresa((v) => v + 1),
    recarregar: () => setVersao((v) => v + 1),
    // Quem sai não recebe mais os avisos dessa conta neste aparelho; no próximo login voltam sozinhos.
    sair: async () => {
      await desligarDaConta().catch(() => {});
      await supabase.auth.signOut();
    },
  };
  return <ContextoSessao.Provider value={valor}>{children}</ContextoSessao.Provider>;
}

export const useSessao = () => useContext(ContextoSessao);
