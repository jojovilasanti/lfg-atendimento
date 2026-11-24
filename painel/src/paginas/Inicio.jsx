import { useState } from "react";
import { Carregando, contagem, Erro, EtiquetaPrazo, Interruptor, jaVenceu, OPERACAO, PRAZO_ATENCAO_LEAD, quando, Temperatura, useAgora, useCarregar, venceAteHoje } from "../comum.jsx";
import { useSessao } from "../sessao.jsx";
import { exigir, mensagemDeErro, supabase } from "../supabase.js";
import { ProximoDoRodizio } from "./FilaRodizio.jsx";

function inicioDoMes() {
  const agora = new Date();
  return new Date(agora.getFullYear(), agora.getMonth(), 1).toISOString();
}

// 451 s vira "7 min 31 s"; 2 h e pouco vira "2 h 05 min".
function duracao(segundos) {
  if (segundos == null) return "—";
  const total = Math.round(Number(segundos));
  if (total < 60) return `${total} s`;
  if (total < 3600) return `${Math.floor(total / 60)} min${total % 60 ? ` ${total % 60} s` : ""}`;
  const minutos = Math.round((total % 3600) / 60);
  return `${Math.floor(total / 3600)} h${minutos ? ` ${String(minutos).padStart(2, "0")} min` : ""}`;
}

// O administrativo não acompanha atendimentos: o Início dele tem só os atalhos
// do trabalho dele (a agenda de visitas entra aqui quando estiver pronta).
const ATALHOS_ADMINISTRATIVO = [
  ["imoveis", "Imóveis", "Estoque, cadastro e fotos dos imóveis"],
  ["plantao", "Plantão", "Quem está de plantão e a fila do rodízio"],
  ["configuracoes", "Configurações", "Empresa, regras do plantão e equipe"],
];

function InicioAdministrativo({ ir }) {
  const { eu } = useSessao();
  return (
    <section className="vista" aria-labelledby="t-inicio">
      <div className="cabeca-vista">
        <div>
          <h2 id="t-inicio">Olá, {eu.nome.split(" ")[0]}</h2>
          <p>Por onde você quer começar?</p>
        </div>
      </div>
      <div className="cartoes-imoveis">
        {ATALHOS_ADMINISTRATIVO.map(([id, titulo, texto]) => (
          <button key={id} type="button" className="painel atalho-inicio" onClick={() => ir(id)}>
            <b>{titulo}</b>
            <span className="mudo">{texto}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

export default function Inicio(props) {
  const { eu } = useSessao();
  return eu.papel === "administrativo" ? <InicioAdministrativo ir={props.ir} /> : <InicioDaEquipe {...props} />;
}

function InicioDaEquipe({ abrirLead, ir }) {
  const { eu, versao, souGestor } = useSessao();
  const agora = useAgora();
  const mes = new Date().toLocaleDateString("pt-BR", { month: "long", year: "numeric" });

  const resumo = useCarregar(async () => exigir(await supabase.rpc("painel_resumo", { p_desde: inicioDoMes() })), [versao]);
  const fila = useCarregar(async () => {
    const ofertas = exigir(
      await supabase.from("atribuicoes").select("id, lead_id, corretor_id, prazo_em").eq("status", "pendente").order("prazo_em"),
    );
    const aguardando = exigir(
      await supabase
        .from("leads")
        .select("id, nome, whatsapp, status, temperatura, interesse, resumo, corretor_id")
        .in("status", ["aguardando_corretor", "com_corretor"])
        .order("ultima_mensagem_em", { ascending: false, nullsFirst: false })
        .limit(30),
    );
    return { ofertas, aguardando };
  }, [versao]);

  const passos = useCarregar(async () => {
    const tarefas = exigir(
      await supabase.from("tarefas").select("id, lead_id, titulo, vence_em, leads(nome)").eq("corretor_id", eu.id).is("concluida_em", null).order("vence_em").limit(50),
    );
    return tarefas.filter((t) => venceAteHoje(t.vence_em));
  }, [versao, eu.id]);

  const r = resumo.dados;
  const ofertasMinhas = (fila.dados?.ofertas ?? []).filter((o) => o.corretor_id === eu.id);
  const leadsPorId = new Map((fila.dados?.aguardando ?? []).map((l) => [l.id, l]));
  const paraFazer = (fila.dados?.aguardando ?? []).filter((l) =>
    souGestor ? l.status === "aguardando_corretor" : l.corretor_id === eu.id || ofertasMinhas.some((o) => o.lead_id === l.id),
  );
  const funil = r
    ? [
        ["Chegaram", r.leads, "clientes falaram com a IA"],
        ["Qualificados", r.qualificados, "com interesse, região e orçamento"],
        ["Passados ao corretor", r.passados, "entraram no rodízio"],
        ["Assumidos", r.assumidos, "um corretor pegou o lead"],
      ]
    : [];

  return (
    <section className="vista" aria-labelledby="t-inicio">
      <div className="cabeca-vista">
        <div>
          <h2 id="t-inicio">Olá, {eu.nome.split(" ")[0]}</h2>
          <p>{souGestor ? "Como está o atendimento da LFG neste mês e o que precisa da equipe agora." : "Seus leads e o que precisa de você agora."}</p>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <ProximoDoRodizio ir={ir} />
          {!souGestor && eu.no_rodizio && <MeuPlantao />}
          <span className="seletor"><span className="rotulo">Mês</span>{mes}</span>
        </div>
      </div>

      {ofertasMinhas.length > 0 && (
        <div className="painel" style={{ borderColor: "var(--limao)" }}>
          <h3>Leads oferecidos a você <span className="etiqueta pronto">{ofertasMinhas.length}</span></h3>
          <div className="lista">
            {ofertasMinhas.map((oferta) => {
              const lead = leadsPorId.get(oferta.lead_id);
              return (
                <button type="button" key={oferta.id} className="tarefa quente" onClick={() => abrirLead(oferta.lead_id)}>
                  <div>
                    <div className="linha1">{lead?.nome ?? "Cliente sem nome"} <Temperatura valor={lead?.temperatura} /> <EtiquetaPrazo prazo={oferta.prazo_em} atencaoMin={PRAZO_ATENCAO_LEAD} agora={agora}>assumir em {contagem(oferta.prazo_em, agora)}</EtiquetaPrazo></div>
                    <p>{lead?.resumo ?? "Abra para ver a conversa."}</p>
                  </div>
                  <span className="ir">Abrir →</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {passos.dados?.length > 0 && (
        <div className="painel">
          <h3>
            Seus próximos passos para hoje <span className="etiqueta alerta">{passos.dados.length}</span>
            <button type="button" className="link-botao acao" onClick={() => ir("leads")}>Ver os leads</button>
          </h3>
          <div className="lista">
            {passos.dados.map((t) => (
              <button type="button" key={t.id} className={`tarefa ${jaVenceu(t.vence_em) ? "quente" : ""}`} onClick={() => abrirLead(t.lead_id)}>
                <div>
                  <div className="linha1">{t.leads?.nome ?? "Cliente sem nome"} <EtiquetaPrazo prazo={t.vence_em}>{quando(t.vence_em)}</EtiquetaPrazo></div>
                  <p>{t.titulo}</p>
                </div>
                <span className="ir">Abrir →</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <Erro mensagem={resumo.erro ?? passos.erro} />
      {!r ? <Carregando /> : (
        <>
          <div className="indicadores">
            <div className="indicador"><span className="rotulo">Leads no mês</span><b>{r.leads}</b><small>sem contar os testes</small></div>
            <div className="indicador alerta"><span className="rotulo">Aguardando corretor</span><b>{r.aguardando}</b><small>passados e ainda sem dono</small></div>
            <div className="indicador alerta"><span className="rotulo">Prazos vencidos</span><b>{r.prazos_vencidos}</b><small>corretor não assumiu a tempo</small></div>
            <div className="indicador destaque"><span className="rotulo">Leads quentes</span><b>{r.quentes}</b><small>prontos para avançar</small></div>
          </div>
          <div className="grade-3-1">
            <div className="painel">
              <h3>Do primeiro contato ao corretor</h3>
              <div className="funil">
                {funil.map(([titulo, n, descricao], i) => (
                  <div key={titulo} className={`etapa ${i === funil.length - 1 ? "fim" : ""}`}>
                    <span className="rotulo">{titulo}</span><b>{n}</b><span>{descricao}</span>
                    <span className="faixa"><i style={{ width: `${r.leads ? (n / r.leads) * 100 : 0}%` }} /></span>
                  </div>
                ))}
              </div>
            </div>
            <div className="painel">
              <h3>Tempo de resposta</h3>
              <dl className="pares">
                <dt>IA</dt><dd><b className="dado" style={{ fontSize: 20 }}>{duracao(r.resposta_ia_segundos)}</b></dd>
                <dt>Corretor assumir</dt><dd><b className="dado" style={{ fontSize: 20 }}>{duracao(r.assumir_segundos)}</b></dd>
              </dl>
            </div>
          </div>
        </>
      )}

      <div className="painel">
        <h3>
          Para fazer agora <span className="etiqueta alerta">{paraFazer.length}</span>
          <button type="button" className="link-botao acao" onClick={() => ir("leads")}>Ver todos os leads</button>
        </h3>
        {fila.dados === undefined ? <Carregando /> : paraFazer.length === 0 ? (
          <div className="vazio"><span className="marcador pronto">✓</span><div><b>Nada pendente</b><p>Quando a IA passar um lead, ele aparece aqui.</p></div></div>
        ) : (
          <div className="lista">
            {paraFazer.map((l) => (
              <button type="button" key={l.id} className={`tarefa ${l.temperatura === "quente" ? "quente" : ""}`} onClick={() => abrirLead(l.id)}>
                <div>
                  <div className="linha1">{l.nome ?? "Cliente sem nome"} <Temperatura valor={l.temperatura} /> {l.interesse && <span className="etiqueta pendente">{OPERACAO[l.interesse]}</span>} {l.whatsapp.startsWith("sim-") && <span className="etiqueta pendente">teste</span>}</div>
                  <p>{l.resumo ?? "Sem resumo ainda."}</p>
                </div>
                <span className="ir">Abrir →</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

// O corretor liga e desliga o próprio plantão aqui (a tela Plantão é da gestão).
function MeuPlantao() {
  const { eu, recarregar } = useSessao();
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState(null);
  async function mudar(ligado) {
    setOcupado(true);
    setErro(null);
    try {
      exigir(await supabase.rpc("definir_meu_plantao", { p_de_plantao: ligado }));
      recarregar();
    } catch (e) {
      setErro(mensagemDeErro(e));
    } finally {
      setOcupado(false);
    }
  }
  return (
    <span className="seletor meu-plantao" title={eu.de_plantao ? "Você está na fila e recebe leads no WhatsApp" : "Ligue para entrar na fila do rodízio"}>
      <span className="rotulo">Meu plantão</span>
      <Interruptor ligado={eu.de_plantao} aoMudar={mudar} rotulo={eu.de_plantao ? "Sair do plantão" : "Entrar no plantão"} desativado={ocupado} />
      <b>{eu.de_plantao ? "de plantão" : "fora"}</b>
      {erro && <span className="texto-critico pequeno">{erro}</span>}
    </span>
  );
}
