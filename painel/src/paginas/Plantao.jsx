import { useState } from "react";
import { Carregando, contagem, Erro, EtiquetaPrazo, Interruptor, nomeDoPapel, PRAZO_ATENCAO_LEAD, telefone, Temperatura, useAgora, useCarregar } from "../comum.jsx";
import { useSessao } from "../sessao.jsx";
import { exigir, mensagemDeErro, supabase } from "../supabase.js";
import FilaDoRodizio from "./FilaRodizio.jsx";

const TRINTA_DIAS_MS = 30 * 24 * 3600 * 1000;

export default function Plantao({ abrirLead }) {
  const { eu, versao, souGestor, recarregar } = useSessao();
  const agora = useAgora();
  const [erroAcao, setErroAcao] = useState(null);

  const { dados, erro } = useCarregar(async () => {
    const equipe = exigir(await supabase.from("corretores").select("*").order("ordem_rodizio", { nullsFirst: false }).order("nome"));
    const atribuicoes = exigir(
      await supabase.from("atribuicoes").select("*").gte("oferecida_em", new Date(Date.now() - TRINTA_DIAS_MS).toISOString()).order("oferecida_em", { ascending: false }),
    );
    // Leads das ofertas abertas e dos distribuídos hoje (para mostrar o nome).
    const desdeOntem = new Date(Date.now() - 36 * 3600 * 1000).toISOString();
    const idsVisiveis = [...new Set(atribuicoes.filter((a) => a.status === "pendente" || a.oferecida_em >= desdeOntem).map((a) => a.lead_id))];
    const leads = idsVisiveis.length
      ? exigir(await supabase.from("leads").select("id, nome, temperatura, resumo").in("id", idsVisiveis))
      : [];
    const prazo = exigir(await supabase.from("configuracoes").select("valor").eq("chave", "prazo_rodizio_minutos").maybeSingle());
    return { equipe, atribuicoes, leads: new Map(leads.map((l) => [l.id, l])), prazo: prazo?.valor ?? 5 };
  }, [versao]);

  async function agir(acao) {
    setErroAcao(null);
    try {
      await acao();
      recarregar();
    } catch (e) {
      setErroAcao(mensagemDeErro(e));
    }
  }

  const mudarMeuPlantao = (ligado) => agir(async () => exigir(await supabase.rpc("definir_meu_plantao", { p_de_plantao: ligado })));
  const mudarPessoa = (pessoa, campo, valor) => agir(async () => exigir(await supabase.from("corretores").update({ [campo]: valor }).eq("id", pessoa.id)));

  if (!dados) return <section className="vista"><Erro mensagem={erro} /><Carregando /></section>;

  const nomes = new Map(dados.equipe.map((c) => [c.id, c.nome]));
  const pendentes = dados.atribuicoes.filter((a) => a.status === "pendente");
  const deplantao = dados.equipe.filter((c) => c.ativo && c.no_rodizio && c.de_plantao);
  const numeros = (id) => {
    const minhas = dados.atribuicoes.filter((a) => a.corretor_id === id);
    const aceitas = minhas.filter((a) => a.status === "aceita" && a.respondida_em);
    const media = aceitas.length ? aceitas.reduce((s, a) => s + (new Date(a.respondida_em) - new Date(a.oferecida_em)), 0) / aceitas.length / 60000 : null;
    return { recebidos: minhas.length, aceitas: aceitas.length, vencidas: minhas.filter((a) => a.status === "expirada").length, media };
  };

  return (
    <section className="vista" aria-labelledby="t-plantao">
      <div className="cabeca-vista">
        <div>
          <h2 id="t-plantao">Plantão</h2>
          <p>Quem recebe lead agora, as ofertas em andamento e como cada corretor está respondendo nos últimos 30 dias.</p>
        </div>
        <span className="seletor"><span className="rotulo">Prazo para assumir</span>{dados.prazo} min</span>
      </div>
      <Erro mensagem={erro || erroAcao} />

      <FilaDoRodizio atribuicoes={dados.atribuicoes} leads={dados.leads} abrirLead={abrirLead} />

      <div className="grade-2">
        <div className="painel">
          <h3>Meu plantão</h3>
          {eu.no_rodizio ? (
            <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
              <Interruptor ligado={eu.de_plantao} aoMudar={mudarMeuPlantao} rotulo="Estou de plantão" />
              <div>
                <b>{eu.de_plantao ? "Você está de plantão" : "Você está fora do plantão"}</b>
                <p className="mudo pequeno" style={{ margin: "2px 0 0" }}>{eu.de_plantao ? "Você entra na fila e recebe leads no seu WhatsApp." : "Ligue para entrar na fila do rodízio."}</p>
              </div>
            </div>
          ) : (
            <p className="mudo pequeno" style={{ margin: 0 }}>Você não participa do rodízio. {souGestor ? "Ligue \"No rodízio\" na sua linha da equipe, abaixo, se quiser receber leads." : ""}</p>
          )}
          <p className="pequeno mudo" style={{ margin: "14px 0 0" }}>De plantão agora: <b style={{ color: "var(--texto)" }}>{deplantao.length ? deplantao.map((c) => c.nome.split(" ")[0]).join(", ") : "ninguém"}</b></p>
        </div>

        <div className="painel">
          <h3>Ofertas em andamento <span className={`etiqueta ${pendentes.length ? "alerta" : "pendente"}`}>{pendentes.length}</span></h3>
          {pendentes.length === 0 ? (
            <div className="vazio"><span className="marcador pronto">✓</span><div><b>Nenhuma oferta aberta</b><p>Quando a IA passar um lead, o tempo para assumir aparece aqui.</p></div></div>
          ) : (
            <div className="lista">
              {pendentes.map((a) => {
                const lead = dados.leads.get(a.lead_id);
                return (
                  <button type="button" key={a.id} className="tarefa quente" onClick={() => abrirLead(a.lead_id)}>
                    <div>
                      <div className="linha1">{lead?.nome ?? "Cliente sem nome"} <Temperatura valor={lead?.temperatura} /></div>
                      <p>Com {nomes.get(a.corretor_id) ?? "corretor"} · {a.aviso_pendente
                        ? <span className="etiqueta azul">aviso no fim da pausa noturna</span>
                        : <EtiquetaPrazo prazo={a.prazo_em} atencaoMin={PRAZO_ATENCAO_LEAD} agora={agora}>faltam {contagem(a.prazo_em, agora)}</EtiquetaPrazo>}</p>
                    </div>
                    <span className="ir">{a.corretor_id === eu.id ? "Assumir →" : "Ver →"}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div>
        <div className="titulo-secao"><h3>Equipe</h3><span className="etiqueta pendente">{dados.equipe.length} pessoas</span></div>
        {dados.equipe.length <= 1 && (
          <div className="vazio" style={{ marginBottom: 12 }}>
            <span className="marcador alerta">!</span>
            <div><b>Cadastre os corretores</b><p>Em Configurações → Equipe e acessos, o gestor cria o acesso de cada corretor com o WhatsApp dele. Aí é só ligar o plantão.</p></div>
          </div>
        )}
        <div className="tabela-caixa">
          <table className="tabela-cartoes">
            <thead><tr><th>Pessoa</th><th>De plantão</th><th>No rodízio</th><th>Recebidos</th><th>Assumidos</th><th>Perdidos no prazo</th><th>Tempo para assumir</th></tr></thead>
            <tbody>
              {dados.equipe.map((c) => {
                const n = numeros(c.id);
                const podeMudar = souGestor && c.ativo;
                return (
                  <tr key={c.id}>
                    <td><span className="forte">{c.nome}</span><span className="sub">{nomeDoPapel(c.papel)} · {telefone(c.whatsapp)}{c.ativo ? "" : " · inativo"}</span></td>
                    <td data-rotulo="De plantão"><Interruptor ligado={c.de_plantao} aoMudar={(v) => (c.id === eu.id ? mudarMeuPlantao(v) : mudarPessoa(c, "de_plantao", v))} rotulo={`Plantão de ${c.nome}`} desativado={!(podeMudar || c.id === eu.id) || !c.no_rodizio} /></td>
                    <td data-rotulo="No rodízio"><Interruptor ligado={c.no_rodizio} aoMudar={(v) => mudarPessoa(c, "no_rodizio", v)} rotulo={`${c.nome} no rodízio`} desativado={!podeMudar} /></td>
                    <td className="dado" data-rotulo="Recebidos">{n.recebidos}</td>
                    <td className="dado" data-rotulo="Assumidos">{n.aceitas}</td>
                    <td className="dado" data-rotulo="Perdidos no prazo">{n.vencidas}</td>
                    <td className="dado" data-rotulo="Tempo para assumir">{n.media == null ? "—" : `${Math.round(n.media)} min`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
