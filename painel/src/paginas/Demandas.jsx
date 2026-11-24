// Agenda de demandas da equipe: lista e calendário (dia, semana, mês).
// Todos veem as demandas de todos. O gestor cria para qualquer pessoa; os
// outros, só para si. O responsável muda
// o status; quem criou (e o gestor) edita e exclui. As regras ficam no banco
// (migração demandas); a tela só esconde o que a pessoa não pode fazer.
import { useState } from "react";
import { Carregando, diaIso, diaPorExtenso, Erro, EtiquetaPrazo, hojeIso, hora, jaVenceu, quando, useCarregar } from "../comum.jsx";
import { Janela } from "../crm.jsx";
import { useSessao } from "../sessao.jsx";
import { exigir, mensagemDeErro, supabase } from "../supabase.js";

const STATUS = {
  pendente: ["Pendente", "pendente"],
  em_andamento: ["Em andamento", "alerta"],
  concluida: ["Concluída", "pronto"],
};
const FILTROS = [
  ["abertas", "Abertas", (d) => d.status !== "concluida"],
  ["pendente", "Pendentes", (d) => d.status === "pendente"],
  ["em_andamento", "Em andamento", (d) => d.status === "em_andamento"],
  ["concluida", "Concluídas", (d) => d.status === "concluida"],
  ["todas", "Todas", () => true],
];
const VISOES = [["lista", "Lista"], ["dia", "Dia"], ["semana", "Semana"], ["mes", "Mês"]];
const DIAS_CURTOS = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];

// Datas do calendário como "AAAA-MM-DD", contadas em UTC para não escorregar de dia.
const somarDias = (dia, n) => new Date(Date.parse(`${dia}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const diaDaSemana = (dia) => (new Date(`${dia}T00:00:00Z`).getUTCDay() + 6) % 7; // 0 = segunda
const inicioDaSemana = (dia) => somarDias(dia, -diaDaSemana(dia));
const nomeDoMes = (dia) => new Date(`${dia}T12:00:00Z`).toLocaleDateString("pt-BR", { timeZone: "UTC", month: "long", year: "numeric" });
const rotuloCurto = (dia) => new Date(`${dia}T12:00:00Z`).toLocaleDateString("pt-BR", { timeZone: "UTC", day: "2-digit", month: "2-digit" });

function paraCampo(data) {
  const ajustada = new Date(data.getTime() - data.getTimezoneOffset() * 60000);
  return ajustada.toISOString().slice(0, 16);
}

export default function Demandas() {
  const { eu, souGestorPleno, versao, recarregar } = useSessao();
  const [visao, setVisao] = useState("lista");
  const [filtro, setFiltro] = useState("abertas");
  // Quem não é gestor abre nas próprias demandas; o filtro mostra as dos outros.
  const [pessoa, setPessoa] = useState(() => (souGestorPleno ? "todos" : eu.id));
  const [referencia, setReferencia] = useState(hojeIso);
  const [aberta, setAberta] = useState(null);

  const { dados, erro } = useCarregar(async () => {
    const [rDemandas, rEquipe] = await Promise.all([
      supabase.from("demandas").select("*").order("prazo").limit(1000),
      supabase.from("corretores").select("id, nome, papel").eq("ativo", true).order("nome"),
    ]);
    const equipe = exigir(rEquipe);
    return { demandas: exigir(rDemandas), equipe, nomes: new Map(equipe.map((c) => [c.id, c.nome])) };
  }, [versao]);

  if (!dados) return <section className="vista"><Erro mensagem={erro} /><Carregando /></section>;
  const { demandas, equipe, nomes } = dados;
  const passaFiltro = FILTROS.find(([id]) => id === filtro)[2];
  const visiveis = demandas.filter((d) => passaFiltro(d) && (pessoa === "todos" || d.responsavel_id === pessoa));
  const contagem = (id) => demandas.filter((d) => FILTROS.find(([f]) => f === id)[2](d) && (pessoa === "todos" || d.responsavel_id === pessoa)).length;
  const porDia = new Map();
  for (const d of visiveis) {
    const dia = diaIso(d.prazo);
    if (!porDia.has(dia)) porDia.set(dia, []);
    porDia.get(dia).push(d);
  }

  const andar = (n) => setReferencia((atual) => {
    if (visao === "dia") return somarDias(atual, n);
    if (visao === "semana") return somarDias(atual, 7 * n);
    const [a, m] = atual.split("-").map(Number);
    const data = new Date(Date.UTC(a, m - 1 + n, 1));
    return data.toISOString().slice(0, 10);
  });

  const cartao = (d, compacto = false) => (
    <CartaoDemanda key={d.id} d={d} eu={eu} nomes={nomes} compacto={compacto} aoAbrir={() => setAberta(d)} />
  );

  return (
    <section className="vista" aria-labelledby="t-demandas">
      <div className="cabeca-vista">
        <div>
          <h2 id="t-demandas">Demandas</h2>
          <p>{souGestorPleno ? "Tarefas da equipe. Você cria demandas para qualquer pessoa." : "Tarefas da equipe. Você cria demandas para você mesmo e vê as de todos no filtro por pessoa."}</p>
        </div>
        <button type="button" className="botao acao-principal" onClick={() => setAberta({})}>Nova demanda</button>
      </div>

      <div className="filtros" role="group" aria-label="Status">
        <div className="chips">
          {FILTROS.map(([id, nome]) => (
            <button key={id} type="button" className="filtro" aria-pressed={filtro === id} onClick={() => setFiltro(id)}>{nome} <b>{contagem(id)}</b></button>
          ))}
        </div>
        {(
          <label className="campo campo-pessoa">
            <span className="invisivel">Responsável</span>
            <select value={pessoa} onChange={(e) => setPessoa(e.target.value)}>
              <option value="todos">Toda a equipe</option>
              {equipe.map((c) => <option key={c.id} value={c.id}>{c.id === eu.id ? `${c.nome} (eu)` : c.nome}</option>)}
            </select>
          </label>
        )}
      </div>

      <div className="barra-calendario">
        <div className="abas" role="tablist" aria-label="Visão">
          {VISOES.map(([id, nome]) => <button key={id} type="button" role="tab" className="aba" aria-selected={visao === id} onClick={() => setVisao(id)}>{nome}</button>)}
        </div>
        {visao !== "lista" && (
          <div className="navegar-calendario">
            <button type="button" className="botao secundario pequeno" onClick={() => andar(-1)}>‹ Anterior</button>
            <button type="button" className="botao secundario pequeno" onClick={() => setReferencia(hojeIso())}>Hoje</button>
            <button type="button" className="botao secundario pequeno" onClick={() => andar(1)}>Próximo ›</button>
            <b className="titulo-periodo">
              {visao === "dia" ? diaPorExtenso(`${referencia}T12:00:00Z`)
                : visao === "semana" ? `${rotuloCurto(inicioDaSemana(referencia))} a ${rotuloCurto(somarDias(inicioDaSemana(referencia), 6))}`
                : nomeDoMes(referencia)}
            </b>
          </div>
        )}
      </div>

      {visao === "lista" && <Lista visiveis={visiveis} cartao={cartao} />}
      {visao === "dia" && (
        <div className="painel">
          {(porDia.get(referencia) ?? []).length ? <ul className="lista-demandas">{porDia.get(referencia).map((d) => cartao(d))}</ul>
            : <p className="mudo" style={{ margin: 0 }}>Nenhuma demanda neste dia.</p>}
        </div>
      )}
      {visao === "semana" && (
        <div className="semana-calendario">
          {Array.from({ length: 7 }, (_, n) => somarDias(inicioDaSemana(referencia), n)).map((dia, n) => (
            <div key={dia} className={`coluna-dia ${dia === hojeIso() ? "hoje" : ""}`}>
              <button type="button" className="cabeca-dia" onClick={() => { setReferencia(dia); setVisao("dia"); }}>
                {DIAS_CURTOS[n]} <span className="dado">{rotuloCurto(dia)}</span>
              </button>
              <ul className="lista-demandas">{(porDia.get(dia) ?? []).map((d) => cartao(d, true))}</ul>
            </div>
          ))}
        </div>
      )}
      {visao === "mes" && <Mes referencia={referencia} porDia={porDia} cartao={cartao} abrirDia={(dia) => { setReferencia(dia); setVisao("dia"); }} />}

      {aberta && (
        <FormularioDemanda
          demanda={aberta.id ? aberta : null}
          equipe={equipe}
          nomes={nomes}
          aoFechar={() => setAberta(null)}
          aoSalvar={() => { setAberta(null); recarregar(); }}
        />
      )}
    </section>
  );
}

function Lista({ visiveis, cartao }) {
  const hoje = hojeIso();
  const grupos = [
    ["Atrasadas", visiveis.filter((d) => d.status !== "concluida" && jaVenceu(d.prazo))],
    ["Hoje", visiveis.filter((d) => diaIso(d.prazo) === hoje && !(d.status !== "concluida" && jaVenceu(d.prazo)))],
    ["Próximos dias", visiveis.filter((d) => diaIso(d.prazo) > hoje)],
    ["Anteriores", visiveis.filter((d) => diaIso(d.prazo) < hoje && d.status === "concluida").reverse()],
  ].filter(([, lista]) => lista.length);
  if (!grupos.length) return <div className="painel"><p className="mudo" style={{ margin: 0 }}>Nenhuma demanda com este filtro.</p></div>;
  return grupos.map(([titulo, lista]) => (
    <div key={titulo} className="dia-agenda">
      <h3 className={`rotulo-dia ${titulo === "Atrasadas" ? "texto-alerta" : ""}`}>{titulo} · {lista.length}</h3>
      <ul className="lista-demandas">{lista.map((d) => cartao(d))}</ul>
    </div>
  ));
}

function Mes({ referencia, porDia, cartao, abrirDia }) {
  const primeiro = `${referencia.slice(0, 7)}-01`;
  const inicio = inicioDaSemana(primeiro);
  const mes = referencia.slice(0, 7);
  const hoje = hojeIso();
  const dias = Array.from({ length: 42 }, (_, n) => somarDias(inicio, n));
  const semanas = dias.slice(35, 42).some((d) => d.startsWith(mes)) ? 6 : 5;
  return (
    <div className="mes-calendario" role="grid" aria-label={`Demandas de ${nomeDoMes(referencia)}`}>
      {DIAS_CURTOS.map((d) => <div key={d} className="nome-dia" role="columnheader">{d}</div>)}
      {dias.slice(0, semanas * 7).map((dia) => {
        const lista = porDia.get(dia) ?? [];
        return (
          <div key={dia} role="gridcell" className={`celula-dia ${dia.startsWith(mes) ? "" : "fora"} ${dia === hoje ? "hoje" : ""}`}>
            <button type="button" className="numero-dia" onClick={() => abrirDia(dia)} aria-label={`Abrir ${rotuloCurto(dia)}${lista.length ? `, ${lista.length} demanda${lista.length > 1 ? "s" : ""}` : ""}`}>
              {Number(dia.slice(8))}
            </button>
            <ul className="lista-demandas">{lista.slice(0, 3).map((d) => cartao(d, true))}</ul>
            {lista.length > 3 && <button type="button" className="mais-do-dia" onClick={() => abrirDia(dia)}>+{lista.length - 3}</button>}
          </div>
        );
      })}
    </div>
  );
}

function CartaoDemanda({ d, eu, nomes, compacto, aoAbrir }) {
  const [nomeStatus, cor] = STATUS[d.status];
  const atrasada = d.status !== "concluida" && jaVenceu(d.prazo);
  return (
    <li className={`demanda ${d.status} ${atrasada ? "atrasada" : ""} ${compacto ? "compacta" : ""}`}>
      <button type="button" onClick={aoAbrir} title={d.titulo}>
        <span className="hora-demanda dado">{compacto ? hora(d.prazo) : quando(d.prazo)}</span>
        <span className="titulo-demanda">{d.titulo}</span>
        {!compacto && (
          <span className="info-demanda">
            <EtiquetaPrazo prazo={d.prazo} finalizado={d.status === "concluida"} />
            {d.status === "em_andamento" && <span className={`etiqueta ${cor}`}>{nomeStatus}</span>}
            {d.responsavel_id !== eu.id && <span className="mudo pequeno">para {nomes.get(d.responsavel_id) ?? "—"}</span>}
            {d.criada_por && d.criada_por !== eu.id && d.criada_por !== d.responsavel_id && <span className="mudo pequeno">criada por {nomes.get(d.criada_por) ?? "—"}</span>}
          </span>
        )}
      </button>
    </li>
  );
}

function FormularioDemanda({ demanda, equipe, nomes, aoFechar, aoSalvar }) {
  const { eu, souGestorPleno } = useSessao();
  const nova = !demanda;
  const podeEditar = nova || souGestorPleno || demanda.criada_por === eu.id;
  const podeMudarStatus = podeEditar || demanda.responsavel_id === eu.id;
  const [titulo, setTitulo] = useState(demanda?.titulo ?? "");
  const [descricao, setDescricao] = useState(demanda?.descricao ?? "");
  const [responsavel, setResponsavel] = useState(demanda?.responsavel_id ?? eu.id);
  const [prazo, setPrazo] = useState(() => paraCampo(demanda ? new Date(demanda.prazo) : new Date(Date.now() + 3600 * 1000)));
  const [status, setStatus] = useState(demanda?.status ?? "pendente");
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState(null);
  const [confirmarExclusao, setConfirmarExclusao] = useState(false);

  async function agir(acao) {
    setOcupado(true);
    setErro(null);
    try {
      await acao();
      aoSalvar();
    } catch (e) {
      setErro(mensagemDeErro(e));
    } finally {
      setOcupado(false);
    }
  }
  const salvar = (evento) => {
    evento.preventDefault();
    agir(async () => {
      if (podeEditar) {
        exigir(await supabase.rpc("salvar_demanda", {
          p_id: demanda?.id ?? null, p_titulo: titulo, p_descricao: descricao, p_responsavel_id: responsavel, p_prazo: new Date(prazo).toISOString(), p_status: status,
        }));
      } else {
        exigir(await supabase.rpc("mudar_status_demanda", { p_id: demanda.id, p_status: status }));
      }
    });
  };
  const excluir = () => agir(async () => exigir(await supabase.rpc("excluir_demanda", { p_id: demanda.id })));

  return (
    <Janela titulo={nova ? "Nova demanda" : podeEditar ? "Editar demanda" : "Demanda"} aoFechar={aoFechar}>
      <form className="formulario" onSubmit={salvar}>
        <label className="campo">
          Título
          <input required minLength={2} maxLength={160} value={titulo} disabled={!podeEditar} onChange={(e) => setTitulo(e.target.value)} />
        </label>
        <label className="campo">
          Descrição <small className="mudo">(opcional)</small>
          <textarea rows={3} maxLength={4000} value={descricao} disabled={!podeEditar} onChange={(e) => setDescricao(e.target.value)} />
        </label>
        <div className="grade-prazos">
          <label className="campo">
            Responsável
            <select value={responsavel} disabled={!podeEditar || !souGestorPleno} onChange={(e) => setResponsavel(e.target.value)}>
              {(souGestorPleno ? equipe : equipe.filter((c) => c.id === responsavel)).map((c) => <option key={c.id} value={c.id}>{c.id === eu.id ? `${c.nome} (eu)` : c.nome}</option>)}
            </select>
          </label>
          <label className="campo">
            Prazo
            <input type="datetime-local" required value={prazo} disabled={!podeEditar} onChange={(e) => setPrazo(e.target.value)} />
          </label>
        </div>
        <fieldset className="grupo-status" disabled={!podeMudarStatus}>
          <legend>Status</legend>
          <div className="filtros">
            {Object.entries(STATUS).map(([id, [nome]]) => (
              <button key={id} type="button" className="filtro" aria-pressed={status === id} onClick={() => setStatus(id)}>{nome}</button>
            ))}
          </div>
        </fieldset>
        {!nova && (
          <p className="mudo pequeno" style={{ margin: 0 }}>
            Criada por {nomes.get(demanda.criada_por) ?? "—"} em {diaPorExtenso(demanda.criado_em)}
            {demanda.concluida_em && ` · concluída em ${diaPorExtenso(demanda.concluida_em)} às ${hora(demanda.concluida_em)}`}
          </p>
        )}
        <Erro mensagem={erro} />
        <div className="atalhos" style={{ justifyContent: "flex-end" }}>
          {!nova && podeEditar && (confirmarExclusao ? (
            <button type="button" className="botao perigo" onClick={excluir} disabled={ocupado} style={{ marginRight: "auto" }}>Confirmar exclusão</button>
          ) : (
            <button type="button" className="botao secundario" onClick={() => setConfirmarExclusao(true)} style={{ marginRight: "auto" }}>Excluir</button>
          ))}
          <button type="button" className="botao secundario" onClick={aoFechar}>Voltar</button>
          {podeMudarStatus && <button type="submit" className="botao" disabled={ocupado}>{ocupado ? "Salvando…" : nova ? "Criar" : "Salvar"}</button>}
        </div>
      </form>
    </Janela>
  );
}
