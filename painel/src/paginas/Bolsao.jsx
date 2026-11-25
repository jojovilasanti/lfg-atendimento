// Bolsão: leads que nem o captador nem 2 corretores do rodízio assumiram.
// Qualquer corretor vê e assume; o banco trava para um só (assumir_do_bolsao).
// Gestor e administrativo também passam o lead direto para alguém, ou
// finalizam/excluem sem mandar mensagem ao cliente (o banco recusa para corretor).
// Antes de assumir, o corretor vê só o essencial: nada de telefone ou conversa.
import { useEffect, useState } from "react";
import { Carregando, Erro, haQuanto, OPERACAO, reais, Temperatura, useCarregar } from "../comum.jsx";
import { useAviso } from "../base/Avisos.jsx";
import { useSessao } from "../sessao.jsx";
import { exigir, mensagemDeErro, supabase } from "../supabase.js";

export default function Bolsao() {
  const { eu, souGestor, versao, recarregar } = useSessao();
  const avisar = useAviso();
  const [rodada, setRodada] = useState(0);
  const [aviso, setAviso] = useState(null);
  const [ocupado, setOcupado] = useState(null);
  const [destino, setDestino] = useState({});
  // { id, acao: "finalizar" | "excluir" } esperando a confirmação.
  const [confirmando, setConfirmando] = useState(null);
  const podeAssumir = eu.papel !== "administrativo";
  // Quando abri o Bolsão da última vez, antes desta visita: lead que entrou
  // depois disso ganha a etiqueta NOVO até eu sair e voltar. undefined = lendo.
  const [vistoAntes, setVistoAntes] = useState(undefined);

  const { dados, erro } = useCarregar(async () => {
    const [rLeads, rEquipe] = await Promise.all([
      supabase.rpc("leads_do_bolsao"),
      souGestor ? supabase.from("corretores").select("id, nome, papel").eq("ativo", true).neq("papel", "administrativo").order("nome") : { data: [], error: null },
    ]);
    return { leads: exigir(rLeads) ?? [], equipe: exigir(rEquipe) ?? [] };
  }, [versao, rodada]);

  // Abrir a tela marca o Bolsão como visto; cada nova leitura com a tela aberta
  // marca de novo, para o ponto verde do menu não voltar enquanto estou aqui.
  useEffect(() => {
    if (!dados) return;
    supabase.rpc("marcar_bolsao_visto").then(({ data, error }) => {
      if (!error) setVistoAntes((atual) => (atual === undefined ? data ?? null : atual));
    });
  }, [dados]);

  const ehNovo = (l) => vistoAntes !== undefined && (vistoAntes === null || new Date(l.bolsao_desde) > new Date(vistoAntes));

  // A lista se atualiza sozinha: quem já foi assumido some para todos.
  useEffect(() => {
    const atualizar = () => setRodada((n) => n + 1);
    const id = setInterval(atualizar, 20_000);
    window.addEventListener("focus", atualizar);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", atualizar);
    };
  }, []);

  async function assumir(lead) {
    setOcupado(lead.id);
    setAviso(null);
    try {
      exigir(await supabase.rpc("assumir_do_bolsao", { p_lead_id: lead.id }));
      recarregar();
      location.hash = `leads/${lead.id}`;
    } catch (e) {
      setAviso(["erro", mensagemDeErro(e)]);
      setRodada((n) => n + 1);
    } finally {
      setOcupado(null);
    }
  }

  async function tirar(lead, acao) {
    setOcupado(lead.id);
    setAviso(null);
    try {
      exigir(await supabase.rpc(acao === "excluir" ? "excluir_do_bolsao" : "finalizar_do_bolsao", { p_lead_id: lead.id }));
      avisar(`${lead.nome ?? "Lead"} ${acao === "excluir" ? "excluído" : "finalizado"}. O cliente não recebeu mensagem.`);
      recarregar();
    } catch (e) {
      setAviso(["erro", mensagemDeErro(e)]);
    } finally {
      setConfirmando(null);
      setOcupado(null);
      setRodada((n) => n + 1);
    }
  }

  async function passar(lead) {
    const corretor = destino[lead.id];
    if (!corretor) return;
    setOcupado(lead.id);
    setAviso(null);
    try {
      exigir(await supabase.rpc("passar_lead", { p_lead_id: lead.id, p_corretor_id: corretor, p_direto: true }));
      const nome = dados.equipe.find((c) => c.id === corretor)?.nome ?? "o corretor";
      avisar(`${lead.nome ?? "Lead"} passado para ${nome}.`);
      setRodada((n) => n + 1);
      recarregar();
    } catch (e) {
      setAviso(["erro", mensagemDeErro(e)]);
      setRodada((n) => n + 1);
    } finally {
      setOcupado(null);
    }
  }

  return (
    <section className="vista" aria-labelledby="t-bolsao">
      <div className="cabeca-vista">
        <div>
          <h2 id="t-bolsao">Bolsão {dados && <span className="etiqueta alerta">{dados.leads.length}</span>}</h2>
          <p>Leads que o captador e 2 corretores do rodízio não assumiram a tempo. {podeAssumir ? "Quem assumir primeiro fica com o lead." : "Você pode passar cada lead para um corretor."}</p>
        </div>
      </div>
      {aviso && <p className={aviso[0] === "ok" ? "aviso-ok" : "aviso-erro"} role="status" style={{ margin: 0 }}>{aviso[1]}</p>}
      <Erro mensagem={erro} />
      {!dados ? <Carregando /> : dados.leads.length === 0 ? (
        <div className="vazio"><span className="marcador pronto">✓</span><div><b>Bolsão vazio</b><p>Nenhum lead esperando. Quando ninguém assumir no rodízio, o lead aparece aqui.</p></div></div>
      ) : (
        <ul className="lista-bolsao">
          {dados.leads.map((l) => (
            <li key={l.id} className={`painel lead-bolsao${ehNovo(l) ? " novo" : ""}${l.temperatura === "quente" ? " quente" : ""}`}>
              <div className="topo-bolsao">
                <b>{l.nome ?? "Cliente sem nome"}</b>
                {ehNovo(l) && <span className="etiqueta novo-bolsao">Novo</span>}
                <Temperatura valor={l.temperatura} />
                <span className="etiqueta pendente">no bolsão {haQuanto(l.bolsao_desde)}</span>
              </div>
              <p className="dados-bolsao">
                {[OPERACAO[l.interesse], l.regiao, l.orcamento ? `até ${reais(l.orcamento)}` : null, l.imovel_referencia ? `imóvel ${l.imovel_referencia}${l.imovel_bairro ? ` (${l.imovel_bairro})` : ""}` : null].filter(Boolean).join(" · ") || "Sem detalhes ainda"}
              </p>
              {l.resumo && <p className="resumo-bolsao">{l.resumo}</p>}
              <div className="atalhos acoes-bolsao">
                {podeAssumir && (
                  <button type="button" className="botao" disabled={ocupado === l.id} onClick={() => assumir(l)}>{ocupado === l.id ? "Assumindo…" : "Assumir"}</button>
                )}
                {souGestor && (
                  <span className="passar-bolsao">
                    <select aria-label={`Passar ${l.nome ?? "o lead"} para`} value={destino[l.id] ?? ""} onChange={(e) => setDestino({ ...destino, [l.id]: e.target.value })}>
                      <option value="">Passar para…</option>
                      {dados.equipe.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
                    </select>
                    <button type="button" className="botao secundario" disabled={!destino[l.id] || ocupado === l.id} onClick={() => passar(l)}>Passar</button>
                  </span>
                )}
                {souGestor && confirmando?.id !== l.id && (
                  <span className="atalhos">
                    <button type="button" className="botao secundario" disabled={ocupado === l.id} onClick={() => setConfirmando({ id: l.id, acao: "finalizar" })}>Finalizar</button>
                    <button type="button" className="botao perigo" disabled={ocupado === l.id} onClick={() => setConfirmando({ id: l.id, acao: "excluir" })}>Excluir</button>
                  </span>
                )}
                {souGestor && confirmando?.id === l.id && (
                  <span className="confirmar-bolsao" role="alert">
                    <b>Tem certeza? O cliente não receberá mensagem.</b>
                    <span className="atalhos">
                      <button type="button" className={confirmando.acao === "excluir" ? "botao perigo" : "botao"} disabled={ocupado === l.id} onClick={() => tirar(l, confirmando.acao)}>
                        {ocupado === l.id ? "Aguarde…" : confirmando.acao === "excluir" ? "Sim, excluir" : "Sim, finalizar"}
                      </button>
                      <button type="button" className="botao secundario" onClick={() => setConfirmando(null)}>Voltar</button>
                    </span>
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
