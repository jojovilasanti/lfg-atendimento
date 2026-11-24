// Agenda: visitas de aluguel e de venda, captações e outros compromissos.
// O corretor vê e mexe só na própria agenda; gestor e administrativo veem a de
// todos, com filtro por corretor. Permissões, conflito no mesmo imóvel, grade
// do aluguel e histórico do lead ficam no banco (agenda_do_corretor); a tela só
// avisa quando o corretor já tem outro compromisso no mesmo horário.
import { useEffect, useMemo, useState } from "react";
import { Carregando, diaIso, diaPorExtenso, Erro, hojeIso, hora, instanteNoFuso, nomeTipo, telefone, useCarregar } from "../comum.jsx";
import { Janela } from "../crm.jsx";
import { ehMinhaCaptacao, semAcento } from "../imoveis.js";
import { useSessao } from "../sessao.jsx";
import { exigir, mensagemDeErro, supabase } from "../supabase.js";

export const TIPOS_DE_VISITA = {
  acompanhada: "Acompanhada (com corretor)",
  sozinha: "Sozinha (cliente vai sem corretor)",
};

// Tipo do compromisso: nome, nome curto e classe da cor.
export const TIPOS = {
  aluguel: ["Visita de aluguel", "Aluguel"],
  venda: ["Visita de venda", "Venda"],
  captacao: ["Captação", "Captação"],
  outro: ["Outro compromisso", "Outro"],
};
const STATUS = {
  agendada: ["Agendada", "pendente"],
  confirmada: ["Confirmada", "pronto"],
  realizada: ["Realizada", "pronto"],
  cancelada: ["Cancelada", "alerta"],
  nao_compareceu: ["Não compareceu", "alerta"],
};
const RETORNOS = [
  ["gostou", "Gostou"],
  ["nao_gostou", "Não gostou"],
  ["quer_proposta", "Quer proposta"],
  ["quer_ver_outros", "Quer ver outros"],
];
const ativa = (v) => v.status === "agendada" || v.status === "confirmada";
// Visitas (aluguel e venda) usam a grade de horários; captação e outro, horário livre.
const NA_GRADE = (tipo) => tipo === "aluguel" || tipo === "venda";

const VISOES = [["hoje", "Hoje"], ["dia", "Dia"], ["semana", "Semana"], ["mes", "Mês"]];
const DIAS_CURTOS = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];
const somarDias = (dia, n) => new Date(Date.parse(`${dia}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const diaDaSemana = (dia) => (new Date(`${dia}T00:00:00Z`).getUTCDay() + 6) % 7;
const inicioDaSemana = (dia) => somarDias(dia, -diaDaSemana(dia));
const nomeDoMes = (dia) => new Date(`${dia}T12:00:00Z`).toLocaleDateString("pt-BR", { timeZone: "UTC", month: "long", year: "numeric" });
const rotuloCurto = (dia) => new Date(`${dia}T12:00:00Z`).toLocaleDateString("pt-BR", { timeZone: "UTC", day: "2-digit", month: "2-digit" });

const primeiroNome = (nome) => nome?.trim().split(" ")[0] ?? "";
const nomeDoImovel = (i) => (i ? [i.referencia, nomeTipo(i.tipo) || null, i.bairro].filter(Boolean).join(" · ") : "");
const tituloDo = (v) => nomeDoImovel(v.imoveis) || v.local || TIPOS[v.tipo]?.[0] || "Compromisso";
const enderecoDo = (v) => {
  const i = v.imoveis;
  if (i) return [[i.endereco, i.numero].filter(Boolean).join(", "), i.bairro, i.cidade].filter(Boolean).join(" · ");
  return v.local ?? "";
};

// "#agenda/novo?lead=…&imovel=…&tipo=…", "#agenda/novo/CODIGO" (antigo) e "#agenda/visita/ID".
function lerEndereco() {
  const [caminho, busca = ""] = location.hash.slice(1).split("?");
  const [vista, acao, valor] = caminho.split("/");
  if (vista !== "agenda") return {};
  const p = new URLSearchParams(busca);
  if (acao === "novo") return { novo: { imovel: valor ? decodeURIComponent(valor) : p.get("imovel"), lead: p.get("lead"), tipo: p.get("tipo") } };
  if (acao === "visita" && valor) return { visita: valor };
  return {};
}
const limparEndereco = () => history.replaceState(null, "", "#agenda");

export default function Agenda() {
  const { eu, versao, recarregar } = useSessao();
  const inicial = useMemo(lerEndereco, []);
  const [visao, setVisao] = useState("hoje");
  const [referencia, setReferencia] = useState(hojeIso);
  const [pessoa, setPessoa] = useState("todos");
  const [formulario, setFormulario] = useState(inicial.novo ? { preenchido: inicial.novo } : null);
  const [aberta, setAberta] = useState(inicial.visita ?? null);

  // Chegou por um link (lembrete, ficha do imóvel, conversa) com a tela já aberta.
  useEffect(() => {
    const aoMudar = () => {
      const e = lerEndereco();
      if (e.novo) setFormulario({ preenchido: e.novo });
      if (e.visita) setAberta(e.visita);
    };
    window.addEventListener("hashchange", aoMudar);
    return () => window.removeEventListener("hashchange", aoMudar);
  }, []);

  const base = useCarregar(async () => {
    const [rEquipe, rImoveis] = await Promise.all([
      supabase.from("corretores").select("id, nome, nome_no_univen, papel").eq("ativo", true).order("nome"),
      supabase.from("imoveis").select("codigo, referencia, titulo, tipo, bairro, cidade, venda, locacao, captador").eq("ativo", true).is("rascunho_de", null).order("referencia"),
    ]);
    return { equipe: exigir(rEquipe), imoveis: exigir(rImoveis) };
  }, [versao]);

  // Período carregado: hoje + 30 dias na visão Hoje; o período inteiro nas outras.
  const [desde, ate] = useMemo(() => {
    if (visao === "hoje") return [hojeIso(), somarDias(hojeIso(), 31)];
    if (visao === "dia") return [referencia, somarDias(referencia, 1)];
    if (visao === "semana") return [inicioDaSemana(referencia), somarDias(inicioDaSemana(referencia), 7)];
    const primeiro = `${referencia.slice(0, 7)}-01`;
    return [inicioDaSemana(primeiro), somarDias(inicioDaSemana(primeiro), 42)];
  }, [visao, referencia]);

  // Agenda da equipe toda: nome e telefone do cliente só vêm para quem pode
  // mexer na visita (corretor dela, quem marcou, gestor e administrativo).
  const lista = useCarregar(async () => exigir(await supabase.rpc("agenda_da_equipe", {
    p_desde: instanteNoFuso(desde, "00:00"),
    p_ate: instanteNoFuso(ate, "00:00"),
    p_corretor: pessoa !== "todos" ? pessoa : null,
  })), [desde, ate, pessoa, versao]);

  const porDia = new Map();
  for (const v of lista.dados ?? []) {
    const dia = diaIso(v.inicio);
    if (!porDia.has(dia)) porDia.set(dia, []);
    porDia.get(dia).push(v);
  }

  const andar = (n) => setReferencia((atual) => {
    if (visao === "dia") return somarDias(atual, n);
    if (visao === "semana") return somarDias(atual, 7 * n);
    const [a, m] = atual.split("-").map(Number);
    return new Date(Date.UTC(a, m - 1 + n, 1)).toISOString().slice(0, 10);
  });
  const abrirDia = (dia) => { setReferencia(dia); setVisao("dia"); };
  const item = (v, compacto = false) => <Compromisso key={v.id} v={v} compacto={compacto} mostrarCorretor aoAbrir={() => setAberta(v.id)} />;

  return (
    <section className="vista" aria-labelledby="t-agenda">
      <div className="cabeca-vista">
        <div>
          <h2 id="t-agenda">Agenda</h2>
          <p>Visitas, captações e compromissos da equipe. Cada um edita e cancela só o que marcou ou o que é dele.</p>
        </div>
      </div>
      <button type="button" className="botao botao-agendar" onClick={() => setFormulario({})} disabled={!base.dados}>
        <span aria-hidden="true">+</span> Agendar visita
      </button>

      <div className="barra-calendario">
        <div className="abas" role="tablist" aria-label="Visão">
          {VISOES.map(([id, nome]) => <button key={id} type="button" role="tab" className="aba" aria-selected={visao === id} onClick={() => { setVisao(id); if (id === "hoje") setReferencia(hojeIso()); }}>{nome}</button>)}
        </div>
        {base.dados && (
          <label className="campo campo-pessoa">
            <span className="invisivel">Corretor</span>
            <select value={pessoa} onChange={(e) => setPessoa(e.target.value)}>
              <option value="todos">Toda a equipe</option>
              {base.dados.equipe.filter((c) => c.papel !== "administrativo").map((c) => <option key={c.id} value={c.id}>{c.id === eu.id ? `${c.nome} (eu)` : c.nome}</option>)}
            </select>
          </label>
        )}
      </div>
      {visao !== "hoje" && (
        <div className="navegar-calendario">
          <button type="button" className="botao secundario pequeno" onClick={() => andar(-1)} aria-label="Anterior">‹</button>
          <button type="button" className="botao secundario pequeno" onClick={() => setReferencia(hojeIso())}>Hoje</button>
          <button type="button" className="botao secundario pequeno" onClick={() => andar(1)} aria-label="Próximo">›</button>
          <b className="titulo-periodo">
            {visao === "dia" ? diaPorExtenso(`${referencia}T12:00:00Z`)
              : visao === "semana" ? `${rotuloCurto(inicioDaSemana(referencia))} a ${rotuloCurto(somarDias(inicioDaSemana(referencia), 6))}`
              : nomeDoMes(referencia)}
          </b>
        </div>
      )}
      <Legenda />

      <Erro mensagem={lista.erro || base.erro} />
      {!lista.dados ? <Carregando /> : (
        <>
          {visao === "hoje" && <VisaoHoje porDia={porDia} item={item} />}
          {visao === "dia" && (
            (porDia.get(referencia) ?? []).length
              ? <ul className="lista-compromissos">{porDia.get(referencia).map((v) => item(v))}</ul>
              : <div className="painel"><p className="mudo" style={{ margin: 0 }}>Nada marcado neste dia.</p></div>
          )}
          {visao === "semana" && (
            <div className="semana-calendario">
              {Array.from({ length: 7 }, (_, n) => somarDias(inicioDaSemana(referencia), n)).map((dia, n) => (
                <div key={dia} className={`coluna-dia ${dia === hojeIso() ? "hoje" : ""}`}>
                  <button type="button" className="cabeca-dia" onClick={() => abrirDia(dia)}>
                    {DIAS_CURTOS[n]} <span className="dado">{rotuloCurto(dia)}</span>
                  </button>
                  <ul className="lista-compromissos">{(porDia.get(dia) ?? []).map((v) => item(v, true))}</ul>
                </div>
              ))}
            </div>
          )}
          {visao === "mes" && <Mes referencia={referencia} porDia={porDia} item={item} abrirDia={abrirDia} />}
        </>
      )}

      {formulario && base.dados && (
        <FormularioCompromisso
          {...base.dados}
          visita={formulario.visita}
          preenchido={formulario.preenchido}
          aoFechar={() => { setFormulario(null); limparEndereco(); }}
          aoSalvar={(id) => { setFormulario(null); limparEndereco(); recarregar(); if (id) setAberta(id); }}
        />
      )}
      {aberta && !formulario && (
        <DetalhesDaVisita
          id={aberta}
          aoFechar={() => { setAberta(null); limparEndereco(); }}
          aoEditar={(v) => setFormulario({ visita: v })}
          aoMudar={recarregar}
        />
      )}
    </section>
  );
}

function Legenda() {
  return (
    <ul className="legenda-agenda" aria-label="Cores por tipo">
      {Object.entries(TIPOS).map(([id, [, curto]]) => <li key={id} className={`tipo-${id}`}><span aria-hidden="true" />{curto}</li>)}
    </ul>
  );
}

function VisaoHoje({ porDia, item }) {
  const hoje = hojeIso();
  const deHoje = porDia.get(hoje) ?? [];
  const proximos = [...porDia.entries()].filter(([dia]) => dia > hoje).flatMap(([, l]) => l).filter(ativa);
  const dias = [];
  for (const v of proximos.slice(0, 30)) {
    const dia = diaIso(v.inicio);
    if (dias.at(-1)?.dia === dia) dias.at(-1).lista.push(v);
    else dias.push({ dia, lista: [v] });
  }
  return (
    <>
      <div className="dia-agenda">
        <h3 className="rotulo-dia">Hoje · {diaPorExtenso(new Date().toISOString())}</h3>
        {deHoje.length ? <ul className="lista-compromissos">{deHoje.map((v) => item(v))}</ul>
          : <div className="painel"><p className="mudo" style={{ margin: 0 }}>Nada marcado para hoje.</p></div>}
      </div>
      <div className="dia-agenda">
        <h3 className="rotulo-dia">Próximos</h3>
        {!dias.length && <div className="painel"><p className="mudo" style={{ margin: 0 }}>Nada marcado nos próximos 30 dias.</p></div>}
        {dias.map(({ dia, lista }) => (
          <div key={dia} className="dia-agenda">
            <h4 className="rotulo-dia mudo">{diaPorExtenso(lista[0].inicio)}</h4>
            <ul className="lista-compromissos">{lista.map((v) => item(v))}</ul>
          </div>
        ))}
      </div>
    </>
  );
}

function Mes({ referencia, porDia, item, abrirDia }) {
  const primeiro = `${referencia.slice(0, 7)}-01`;
  const inicio = inicioDaSemana(primeiro);
  const mes = referencia.slice(0, 7);
  const hoje = hojeIso();
  const dias = Array.from({ length: 42 }, (_, n) => somarDias(inicio, n));
  const semanas = dias.slice(35, 42).some((d) => d.startsWith(mes)) ? 6 : 5;
  return (
    <div className="mes-calendario" role="grid" aria-label={`Agenda de ${nomeDoMes(referencia)}`}>
      {DIAS_CURTOS.map((d) => <div key={d} className="nome-dia" role="columnheader">{d}</div>)}
      {dias.slice(0, semanas * 7).map((dia) => {
        const lista = porDia.get(dia) ?? [];
        return (
          <div key={dia} role="gridcell" className={`celula-dia ${dia.startsWith(mes) ? "" : "fora"} ${dia === hoje ? "hoje" : ""}`}>
            <button type="button" className="numero-dia" onClick={() => abrirDia(dia)} aria-label={`Abrir ${rotuloCurto(dia)}${lista.length ? `, ${lista.length} compromisso${lista.length > 1 ? "s" : ""}` : ""}`}>
              {Number(dia.slice(8))}
            </button>
            <ul className="lista-compromissos">{lista.slice(0, 3).map((v) => item(v, true))}</ul>
            {lista.length > 3 && <button type="button" className="mais-do-dia" onClick={() => abrirDia(dia)}>+{lista.length - 3}</button>}
          </div>
        );
      })}
    </div>
  );
}

function Compromisso({ v, compacto, mostrarCorretor, aoAbrir }) {
  const [nomeStatus, cor] = STATUS[v.status] ?? [v.status, "pendente"];
  return (
    <li className={`compromisso tipo-${v.tipo} ${ativa(v) ? "" : "inativo"} ${compacto ? "compacto" : ""}`}>
      <button type="button" onClick={aoAbrir} aria-label={`${TIPOS[v.tipo]?.[0]} às ${hora(v.inicio)}: ${tituloDo(v)}`}>
        <span className="hora-compromisso dado">{hora(v.inicio)}</span>
        <span className="titulo-compromisso">{compacto ? tituloDo(v) : <><b>{TIPOS[v.tipo]?.[1]}</b> · {tituloDo(v)}</>}</span>
        {!compacto && (
          <span className="info-compromisso">
            {v.cliente_nome && <span>{v.cliente_nome}</span>}
            {mostrarCorretor && <span className="mudo">{v.corretor?.nome ? primeiroNome(v.corretor.nome) : "sem corretor"}</span>}
            <span className={`etiqueta ${cor}`}>{nomeStatus}</span>
            {v.retorno && <span className="etiqueta pronto">{RETORNOS.find(([id]) => id === v.retorno)?.[1]}</span>}
          </span>
        )}
      </button>
    </li>
  );
}

// --- Detalhes ---------------------------------------------------------------

function DetalhesDaVisita({ id, aoFechar, aoEditar, aoMudar }) {
  const [rodada, setRodada] = useState(0);
  const { dados: v, erro } = useCarregar(async () => exigir(await supabase.rpc("agenda_da_equipe", { p_id: id }))[0] ?? null, [id, rodada]);
  const [ocupado, setOcupado] = useState(false);
  const [aviso, setAviso] = useState(null);
  const [cancelando, setCancelando] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [retorno, setRetorno] = useState(null);
  const [obs, setObs] = useState(null);

  async function chamar(funcao, parametros, mensagem) {
    setOcupado(true);
    setAviso(null);
    try {
      exigir(await supabase.rpc(funcao, parametros));
      setAviso(["ok", mensagem]);
      setCancelando(false);
      setRodada((n) => n + 1);
      aoMudar();
    } catch (e) {
      setAviso(["erro", mensagemDeErro(e)]);
    } finally {
      setOcupado(false);
    }
  }

  if (v === null) {
    return <Janela titulo="Compromisso" aoFechar={aoFechar}><p className="mudo" style={{ margin: 0 }}>Este compromisso não foi encontrado. Ele pode ter sido apagado.</p></Janela>;
  }
  if (!v) return <Janela titulo="Compromisso" aoFechar={aoFechar}><Erro mensagem={erro} /><Carregando /></Janela>;

  const passou = new Date(v.inicio).getTime() <= Date.now();
  const endereco = enderecoDo(v);
  const i = v.imoveis;
  const temCoordenada = i?.latitude && i?.longitude;
  const destino = temCoordenada ? `${i.latitude},${i.longitude}` : endereco;
  const mapa = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(destino)}`;
  const waze = temCoordenada ? `https://waze.com/ul?ll=${encodeURIComponent(destino)}&navigate=yes` : `https://waze.com/ul?q=${encodeURIComponent(destino)}&navigate=yes`;
  const fone = (v.cliente_telefone ?? "").replace(/\D/g, "");
  const foneCompleto = fone ? (fone.startsWith("55") ? fone : `55${fone}`) : null;
  const ondeCurto = i ? [i.bairro, i.referencia].filter(Boolean).join(" · ") : v.local;
  const textoConfirmar = `Olá ${primeiroNome(v.cliente_nome)}, confirmando nossa visita ao imóvel ${ondeCurto ?? ""} no dia ${rotuloCurto(diaIso(v.inicio))} às ${hora(v.inicio)}. Posso confirmar?`;
  const [nomeStatus, cor] = STATUS[v.status] ?? [v.status, "pendente"];
  const retornoAtual = retorno ?? v.retorno;
  const obsAtual = obs ?? v.retorno_obs ?? "";

  return (
    <Janela titulo={TIPOS[v.tipo]?.[0] ?? "Compromisso"} aoFechar={aoFechar}>
      <div className="detalhes-visita">
        <div className={`faixa-tipo tipo-${v.tipo}`}>
          <b className="dado">{hora(v.inicio)}–{hora(v.fim)}</b>
          <span>{diaPorExtenso(v.inicio)}</span>
          <span className={`etiqueta ${cor}`}>{nomeStatus}</span>
        </div>

        <div className="bloco-detalhe">
          <span className="rotulo-detalhe">{i ? "Imóvel" : "Local"}</span>
          {i ? <a href={`#imoveis/${v.imovel_codigo}`}>{nomeDoImovel(i)}</a> : <span>{v.local}</span>}
          {i && endereco && <span className="mudo pequeno">{endereco}</span>}
          {destino && (
            <div className="atalhos">
              <a className="botao secundario" href={mapa} target="_blank" rel="noopener noreferrer">Abrir no mapa</a>
              <a className="botao secundario" href={waze} target="_blank" rel="noopener noreferrer">Waze</a>
            </div>
          )}
        </div>

        {(v.cliente_nome || v.cliente_telefone) && (
          <div className="bloco-detalhe">
            <span className="rotulo-detalhe">{v.tipo === "captacao" ? "Proprietário" : "Cliente"}</span>
            <span><b>{v.cliente_nome}</b>{fone && <> · <a href={`tel:+${foneCompleto}`}>{telefone(fone)}</a></>}</span>
            {v.lead_id && <a className="pequeno" href={`#leads/${v.lead_id}`}>Abrir a conversa do lead</a>}
            {foneCompleto && ativa(v) && (
              <a className="botao botao-whatsapp-grande" href={`https://wa.me/${foneCompleto}?text=${encodeURIComponent(textoConfirmar)}`} target="_blank" rel="noopener noreferrer">
                Confirmar pelo WhatsApp
              </a>
            )}
          </div>
        )}

        <div className="bloco-detalhe pequeno">
          <span>Corretor: <b>{v.corretor?.nome ?? "a definir"}</b>{v.quem?.nome && <span className="mudo"> · agendado por {primeiroNome(v.quem.nome)}</span>}</span>
          {(v.tipo === "aluguel" || v.tipo === "venda") && <span className="mudo">Visita {TIPOS_DE_VISITA[v.tipo_visita]?.toLowerCase()}</span>}
          {v.remarcada_de && <span className="mudo">Remarcada (era {diaPorExtenso(v.remarcada_de)} às {hora(v.remarcada_de)})</span>}
          {v.observacoes && <span>“{v.observacoes}”</span>}
          {v.status === "cancelada" && v.motivo_cancelamento && <span className="texto-alerta">Motivo: {v.motivo_cancelamento}</span>}
        </div>

        {aviso && <p className={aviso[0] === "ok" ? "aviso-ok" : "aviso-erro"} role="status" style={{ margin: 0 }}>{aviso[1]}</p>}

        {!v.pode_mexer && (
          <p className="mudo pequeno" style={{ margin: 0 }}>Os dados do cliente e as ações ficam com o corretor da visita, com quem marcou, com o gestor e com o administrativo.</p>
        )}

        {v.pode_mexer && ativa(v) && !cancelando && (
          <div className="acoes-visita">
            {v.status === "agendada" && !passou && (
              <button type="button" className="botao" disabled={ocupado} onClick={() => chamar("mudar_status_visita", { p_id: v.id, p_status: "confirmada" }, "Marcada como confirmada.")}>Confirmada</button>
            )}
            {passou && (
              <>
                <button type="button" className="botao" disabled={ocupado} onClick={() => chamar("mudar_status_visita", { p_id: v.id, p_status: "realizada" }, "Marcada como realizada. Registre o retorno do cliente abaixo.")}>Realizada</button>
                <button type="button" className="botao secundario" disabled={ocupado} onClick={() => chamar("mudar_status_visita", { p_id: v.id, p_status: "nao_compareceu" }, "Registrado: o cliente não compareceu.")}>Não compareceu</button>
              </>
            )}
            {!passou && <button type="button" className="botao secundario" disabled={ocupado} onClick={() => aoEditar(v)}>Remarcar ou editar</button>}
            <button type="button" className="botao secundario" disabled={ocupado} onClick={() => setCancelando(true)}>Cancelar</button>
          </div>
        )}
        {cancelando && (
          <div className="confirmar-bolsao">
            <label className="campo">
              Motivo do cancelamento <small className="mudo">(opcional)</small>
              <input maxLength={200} value={motivo} onChange={(e) => setMotivo(e.target.value)} />
            </label>
            <div className="atalhos">
              <button type="button" className="botao perigo" disabled={ocupado} onClick={() => chamar("mudar_status_visita", { p_id: v.id, p_status: "cancelada", p_motivo: motivo }, "Cancelada.")}>{ocupado ? "Aguarde…" : "Sim, cancelar"}</button>
              <button type="button" className="botao secundario" onClick={() => setCancelando(false)}>Voltar</button>
            </div>
          </div>
        )}

        {v.pode_mexer && passou && v.status !== "cancelada" && v.status !== "nao_compareceu" && (v.tipo === "aluguel" || v.tipo === "venda") && (
          <div className="bloco-detalhe">
            <span className="rotulo-detalhe">Retorno do cliente</span>
            <div className="filtros" role="group" aria-label="Retorno do cliente">
              {RETORNOS.map(([idRetorno, nome]) => (
                <button key={idRetorno} type="button" className="filtro" aria-pressed={retornoAtual === idRetorno} onClick={() => setRetorno(idRetorno)}>{nome}</button>
              ))}
            </div>
            <textarea rows={2} maxLength={1000} placeholder="Observação (opcional)" value={obsAtual} onChange={(e) => setObs(e.target.value)} aria-label="Observação do retorno" />
            <button type="button" className="botao" style={{ alignSelf: "flex-start" }} disabled={ocupado || !retornoAtual}
              onClick={() => chamar("registrar_retorno_visita", { p_id: v.id, p_retorno: retornoAtual, p_obs: obsAtual }, "Retorno salvo no histórico.")}>
              Salvar retorno
            </button>
          </div>
        )}
      </div>
    </Janela>
  );
}

// --- Agendar e editar ------------------------------------------------------

const TELEFONE_VALIDO = (t) => { const d = t.replace(/\D/g, ""); return d.length >= 10 && d.length <= 13; };

function FormularioCompromisso({ equipe, imoveis, visita, preenchido, aoFechar, aoSalvar }) {
  const { eu, souGestor } = useSessao();
  const editando = !!visita;
  const [tipo, setTipo] = useState(() => {
    if (visita) return visita.tipo;
    if (TIPOS[preenchido?.tipo]) return preenchido.tipo;
    const i = imoveis.find((x) => x.codigo === preenchido?.imovel);
    return i && !i.locacao && i.venda ? "venda" : "aluguel";
  });
  const [codigo, setCodigo] = useState(visita?.imovel_codigo ?? preenchido?.imovel ?? "");
  const [buscaImovel, setBuscaImovel] = useState("");
  const [lead, setLead] = useState(null); // { id, nome, whatsapp }
  const [buscaLead, setBuscaLead] = useState("");
  const [nome, setNome] = useState(visita?.cliente_nome ?? "");
  const [fone, setFone] = useState(visita?.cliente_telefone ? telefone(visita.cliente_telefone) : "");
  const [local, setLocal] = useState(visita?.local ?? "");
  const [dia, setDia] = useState(visita ? diaIso(visita.inicio) : hojeIso());
  const [inicio, setInicio] = useState(visita?.inicio ?? null); // aluguel: horário da grade
  const [horaLivre, setHoraLivre] = useState(visita && !NA_GRADE(visita.tipo) ? hora(visita.inicio) : "");
  const [duracao, setDuracao] = useState(visita ? Math.round((new Date(visita.fim) - new Date(visita.inicio)) / 60000) : 60);
  const imovelEscolhido = imoveis.find((i) => i.codigo === codigo);
  const [corretor, setCorretor] = useState(visita?.corretor_id ?? eu.id);
  const [obs, setObs] = useState(visita?.observacoes ?? "");
  // Acompanhada pelo corretor ou cliente vai sozinho (começa no padrão do imóvel).
  const [acompanhamento, setAcompanhamento] = useState(visita?.tipo_visita ?? "acompanhada");
  const [conflitos, setConflitos] = useState(null);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState(null);
  const [rodada, setRodada] = useState(0);
  const ehVisita = NA_GRADE(tipo);

  // Lead vindo da conversa ou da visita em edição.
  useEffect(() => {
    const id = visita?.lead_id ?? preenchido?.lead;
    if (!id) return;
    supabase.from("leads").select("id, nome, whatsapp").eq("id", id).maybeSingle().then(({ data }) => {
      if (!data) return;
      setLead(data);
      if (!visita) {
        setNome(data.nome ?? "");
        setFone(/^\d+$/.test(data.whatsapp) ? telefone(data.whatsapp) : "");
      }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Busca de leads pelo nome ou telefone (só os que a pessoa pode ver).
  const leads = useCarregar(async () => {
    const termo = buscaLead.trim();
    if (termo.length < 2) return [];
    const digitos = termo.replace(/\D/g, "");
    let consulta = supabase.from("leads").select("id, nome, whatsapp").limit(8).order("ultima_mensagem_cliente_em", { ascending: false, nullsFirst: false });
    consulta = digitos.length >= 4 ? consulta.like("whatsapp", `%${digitos}%`) : consulta.ilike("nome", `%${termo.replace(/[%_,()]/g, " ")}%`);
    return exigir(await consulta);
  }, [buscaLead]);

  const candidatos = useMemo(() => {
    const termo = semAcento(buscaImovel);
    const servem = imoveis.filter((i) => (tipo === "aluguel" ? i.locacao : tipo === "venda" ? i.venda : true));
    if (!termo) return [];
    return servem.filter((i) => semAcento(`${i.referencia} ${i.codigo} ${i.bairro} ${i.titulo}`).includes(termo)).slice(0, 8);
  }, [buscaImovel, imoveis, tipo]);

  // Grade de horários do aluguel.
  const grade = useCarregar(async () => {
    if (!ehVisita || !codigo || !dia) return [];
    return exigir(await supabase.rpc("horarios_de_visita", { p_imovel: codigo, p_dia: dia, p_ignorar: visita?.id ?? null }));
  }, [tipo, codigo, dia, rodada]);

  useEffect(() => {
    if (!editando || diaIso(visita.inicio) !== dia || codigo !== visita.imovel_codigo) setInicio(null);
    else setInicio(visita.inicio);
    setConflitos(null);
  }, [codigo, dia, tipo]); // eslint-disable-line react-hooks/exhaustive-deps

  const padraoDoImovel = (cod) =>
    supabase.from("imoveis_tipo_visita").select("tipo").eq("imovel_codigo", cod).maybeSingle()
      .then(({ data }) => setAcompanhamento(data?.tipo ?? "acompanhada"));
  useEffect(() => {
    if (!visita && codigo) padraoDoImovel(codigo);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const escolherImovel = (i) => {
    setCodigo(i.codigo);
    setBuscaImovel("");
    if (!editando) padraoDoImovel(i.codigo);
    if (souGestor && !editando) {
      const captador = equipe.find((c) => ehMinhaCaptacao(i, c));
      if (captador) setCorretor(captador.id);
    }
  };
  const escolherLead = (l) => {
    setLead(l);
    setBuscaLead("");
    setNome(l.nome ?? "");
    setFone(/^\d+$/.test(l.whatsapp) ? telefone(l.whatsapp) : "");
  };
  const trocarTipo = (novo) => {
    setTipo(novo);
    const i = imoveis.find((x) => x.codigo === codigo);
    if (i && ((novo === "aluguel" && !i.locacao) || (novo === "venda" && !i.venda))) setCodigo("");
  };

  const instante = ehVisita ? inicio : horaLivre && dia ? instanteNoFuso(dia, horaLivre) : null;
  const naGrade = grade.dados?.find((h) => h.inicio === inicio);
  const fimPrevisto = instante ? new Date(new Date(instante).getTime() + (ehVisita ? (naGrade ? new Date(naGrade.fim) - new Date(inicio) : 3600000) : duracao * 60000)).toISOString() : null;

  async function salvar(evento, mesmoAssim = false) {
    evento?.preventDefault();
    setErro(null);
    if (!tipo) return setErro("Escolha o tipo.");
    if (!instante) return setErro(ehVisita ? "Escolha um horário livre na grade." : "Escolha o horário.");
    if (ehVisita && !codigo) return setErro("Escolha o imóvel.");
    if (!ehVisita && !codigo && !local.trim()) return setErro("Escolha um imóvel ou escreva o local.");
    if (ehVisita && (!nome.trim() || !TELEFONE_VALIDO(fone))) return setErro("Informe o nome e o telefone do cliente (com DDD).");
    if (fone && !TELEFONE_VALIDO(fone)) return setErro("Telefone com DDD, por exemplo (67) 99999-0000.");
    setOcupado(true);
    try {
      const responsavel = souGestor ? corretor || null : eu.id;
      if (!mesmoAssim && responsavel) {
        const achados = exigir(await supabase.rpc("conflitos_na_agenda", { p_corretor_id: responsavel, p_inicio: instante, p_fim: fimPrevisto, p_ignorar: visita?.id ?? null }));
        if (achados.length) {
          setConflitos(achados);
          return;
        }
      }
      const dados = {
        p_inicio: instante,
        p_imovel: codigo || null,
        p_lead_id: lead?.id ?? null,
        p_cliente_nome: nome.trim() || null,
        p_cliente_telefone: fone.replace(/\D/g, "") || null,
        p_local: local.trim() || null,
        p_corretor_id: responsavel,
        p_observacoes: obs,
        p_tipo_visita: ehVisita ? acompanhamento : null,
      };
      let id = visita?.id;
      if (editando) exigir(await supabase.rpc("editar_visita", { p_id: visita.id, p_tipo: tipo, ...dados }));
      else id = exigir(await supabase.rpc("agendar_visita", { p_tipo: tipo, p_duracao: ehVisita ? null : Number(duracao), ...dados }));
      aoSalvar(id);
    } catch (e) {
      setErro(mensagemDeErro(e));
      setConflitos(null);
      setRodada((n) => n + 1);
    } finally {
      setOcupado(false);
    }
  }

  const horarios = grade.dados ?? [];
  return (
    <Janela titulo={editando ? "Editar compromisso" : "Agendar"} aoFechar={aoFechar}>
      <form className="formulario" onSubmit={salvar}>
        <div className="seletor-tipo" role="radiogroup" aria-label="Tipo">
          {Object.entries(TIPOS).map(([id, [, curto]]) => (
            <button key={id} type="button" role="radio" aria-checked={tipo === id} className={`tipo-${id}`} onClick={() => trocarTipo(id)}>{curto}</button>
          ))}
        </div>

        <div className="campo">
          <span>{tipo === "captacao" ? "Proprietário" : "Cliente"} {!ehVisita && <small className="mudo">(opcional)</small>}</span>
          {lead ? (
            <div className="escolhido">
              <span><b>{lead.nome ?? "Lead sem nome"}</b> · {telefone(lead.whatsapp)}</span>
              <button type="button" className="link-botao pequeno" onClick={() => setLead(null)}>Trocar</button>
            </div>
          ) : (
            <>
              <input type="search" placeholder="Buscar lead pelo nome ou telefone" value={buscaLead} onChange={(e) => setBuscaLead(e.target.value)} autoComplete="off" aria-label="Buscar lead" />
              {buscaLead.trim().length >= 2 && (
                <ul className="sugestoes">
                  {(leads.dados ?? []).map((l) => (
                    <li key={l.id}><button type="button" onClick={() => escolherLead(l)}><b>{l.nome ?? "Sem nome"}</b> <span className="mudo">{telefone(l.whatsapp)}</span></button></li>
                  ))}
                  {leads.dados && !leads.dados.length && <li className="mudo pequeno">Nenhum lead encontrado. Preencha o nome e o telefone abaixo.</li>}
                </ul>
              )}
            </>
          )}
          <div className="grade-prazos">
            <input placeholder="Nome" required={ehVisita} minLength={2} maxLength={120} value={nome} onChange={(e) => setNome(e.target.value)} autoComplete="off" aria-label="Nome" />
            <input type="tel" inputMode="tel" placeholder="(67) 99999-0000" required={ehVisita} value={fone} onChange={(e) => setFone(e.target.value)} autoComplete="off" aria-label="Telefone" />
          </div>
        </div>

        <div className="campo">
          <span>Imóvel {!ehVisita && <small className="mudo">(opcional)</small>}</span>
          {imovelEscolhido ? (
            <div className="escolhido">
              <span><b>{imovelEscolhido.referencia}</b> · {nomeTipo(imovelEscolhido.tipo)}{imovelEscolhido.bairro ? ` · ${imovelEscolhido.bairro}` : ""}</span>
              <button type="button" className="link-botao pequeno" onClick={() => setCodigo("")}>Trocar</button>
            </div>
          ) : (
            <>
              <input type="search" placeholder={tipo === "aluguel" ? "Código ou bairro (imóveis de aluguel)" : tipo === "venda" ? "Código ou bairro (imóveis à venda)" : "Código ou bairro"} value={buscaImovel} onChange={(e) => setBuscaImovel(e.target.value)} autoComplete="off" aria-label="Buscar imóvel" />
              {buscaImovel && (
                <ul className="sugestoes">
                  {candidatos.map((i) => (
                    <li key={i.codigo}><button type="button" onClick={() => escolherImovel(i)}><b>{i.referencia}</b> {nomeTipo(i.tipo)}{i.bairro ? ` · ${i.bairro}` : ""}</button></li>
                  ))}
                  {!candidatos.length && <li className="mudo pequeno">Nenhum imóvel com esse código ou bairro.</li>}
                </ul>
              )}
            </>
          )}
          {codigo && !imovelEscolhido && <small className="texto-alerta">Este imóvel não está ativo para {TIPOS[tipo]?.[1].toLowerCase()}.</small>}
        </div>
        {!ehVisita && (
          <label className="campo">
            Local {codigo ? <small className="mudo">(opcional)</small> : null}
            <input maxLength={300} placeholder="Endereço ou ponto de encontro" value={local} onChange={(e) => setLocal(e.target.value)} />
          </label>
        )}

        <div className="grade-prazos">
          <label className="campo">
            Data
            <input type="date" required value={dia} min={hojeIso()} onChange={(e) => setDia(e.target.value)} />
          </label>
          {!ehVisita && (
            <>
              <label className="campo">
                Horário
                <input type="time" required value={horaLivre} onChange={(e) => { setHoraLivre(e.target.value); setConflitos(null); }} />
              </label>
              <label className="campo">
                Duração
                <select value={duracao} onChange={(e) => { setDuracao(Number(e.target.value)); setConflitos(null); }}>
                  {[30, 60, 90, 120, 180].map((m) => <option key={m} value={m}>{m < 60 ? `${m} min` : `${m / 60} h`.replace(".5", ",5")}</option>)}
                </select>
              </label>
            </>
          )}
        </div>
        {ehVisita && codigo && (
          <fieldset className="grade-horarios">
            <legend>Horário {inicio && <span className="mudo">· escolhido: {hora(inicio)}</span>}</legend>
            {grade.erro ? <Erro mensagem={grade.erro} /> : !grade.dados ? <Carregando texto="Lendo a agenda…" /> : horarios.length === 0 ? (
              <p className="mudo pequeno" style={{ margin: 0 }}>Não há visitas neste dia da semana. Escolha outro dia.</p>
            ) : (
              [["Manhã", horarios.filter((h) => Number(hora(h.inicio).slice(0, 2)) < 12)], ["Tarde", horarios.filter((h) => Number(hora(h.inicio).slice(0, 2)) >= 12)]]
                .filter(([, lista]) => lista.length)
                .map(([periodo, lista]) => (
                  <div key={periodo} className="periodo-horarios">
                    <span className="rotulo-periodo">{periodo}</span>
                    <div className="horarios">
                      {lista.map((h) => (
                        <button key={h.inicio} type="button" className={`horario ${!h.livre ? "reservado" : ""} ${h.passado ? "passou" : ""}`}
                          aria-pressed={inicio === h.inicio} disabled={!h.livre || h.passado} onClick={() => { setInicio(h.inicio); setConflitos(null); }}
                          aria-label={`${hora(h.inicio)}, ${!h.livre ? `ocupado${h.quem ? ` por ${h.quem}` : ""}` : h.passado ? "já passou" : "livre"}`}>
                          <span className="dado">{hora(h.inicio)}</span>
                          <small>{!h.livre ? (h.quem ?? "ocupado") : h.passado ? "passou" : "livre"}</small>
                        </button>
                      ))}
                    </div>
                  </div>
                ))
            )}
          </fieldset>
        )}

        {ehVisita && (
          <div className="campo">
            <span>Visita</span>
            <div className="filtros" role="radiogroup" aria-label="Acompanhamento da visita">
              {Object.entries(TIPOS_DE_VISITA).map(([id, nome]) => (
                <button key={id} type="button" role="radio" className="filtro" aria-checked={acompanhamento === id} aria-pressed={acompanhamento === id} onClick={() => setAcompanhamento(id)}>{nome}</button>
              ))}
            </div>
          </div>
        )}

        {souGestor && (
          <label className="campo">
            Corretor
            <select value={corretor ?? ""} onChange={(e) => { setCorretor(e.target.value); setConflitos(null); }}>
              <option value="">A definir</option>
              {equipe.filter((c) => c.papel !== "administrativo").map((c) => <option key={c.id} value={c.id}>{c.id === eu.id ? `${c.nome} (eu)` : c.nome}</option>)}
            </select>
          </label>
        )}
        <label className="campo">
          Observação <small className="mudo">(opcional)</small>
          <textarea rows={2} maxLength={1000} value={obs} onChange={(e) => setObs(e.target.value)} />
        </label>

        {conflitos && (
          <div className="confirmar-bolsao" role="alert">
            <b>{souGestor && corretor !== eu.id ? "Este corretor já tem" : "Você já tem"} compromisso nesse horário:</b>
            <ul className="pequeno" style={{ margin: 0, paddingLeft: 18 }}>
              {conflitos.map((c) => <li key={c.id}>{hora(c.inicio)}–{hora(c.fim)} · {TIPOS[c.tipo]?.[1]} · {c.titulo}</li>)}
            </ul>
            <div className="atalhos">
              <button type="button" className="botao" disabled={ocupado} onClick={() => salvar(null, true)}>Agendar mesmo assim</button>
              <button type="button" className="botao secundario" onClick={() => setConflitos(null)}>Mudar o horário</button>
            </div>
          </div>
        )}
        <Erro mensagem={erro} />
        {!conflitos && (
          <div className="atalhos" style={{ justifyContent: "flex-end" }}>
            <button type="button" className="botao secundario" onClick={aoFechar}>Voltar</button>
            <button type="submit" className="botao" disabled={ocupado}>{ocupado ? "Salvando…" : editando ? "Salvar" : "Agendar"}</button>
          </div>
        )}
      </form>
    </Janela>
  );
}

// --- Ficha do imóvel ------------------------------------------------------

// Na ficha do imóvel: visitas marcadas e já feitas (as que a pessoa vê), tipo
// de visita do aluguel e atalho para agendar já com o imóvel.
export function VisitasDoImovel({ imovel }) {
  const { eu, souGestor } = useSessao();
  const podeMudar = souGestor || ehMinhaCaptacao(imovel, eu);
  const { dados, erro } = useCarregar(async () => {
    const [rTipo, rVisitas] = await Promise.all([
      supabase.from("imoveis_tipo_visita").select("tipo").eq("imovel_codigo", imovel.codigo).maybeSingle(),
      supabase.rpc("agenda_da_equipe", { p_imovel: imovel.codigo }).limit(20),
    ]);
    return { tipo: exigir(rTipo)?.tipo ?? "acompanhada", visitas: exigir(rVisitas) };
  }, [imovel.codigo]);
  const [tipo, setTipo] = useState(null);
  const [aviso, setAviso] = useState(null);
  const [erroSalvar, setErroSalvar] = useState(null);
  const atual = tipo ?? dados?.tipo;
  const tipoAgenda = imovel.locacao ? "aluguel" : "venda";
  const proximas = (dados?.visitas ?? []).filter((v) => ativa(v) && new Date(v.inicio) > new Date());

  async function mudar(novo) {
    setErroSalvar(null);
    setAviso(null);
    const antes = atual;
    setTipo(novo);
    try {
      exigir(await supabase.rpc("definir_tipo_visita", { p_imovel: imovel.codigo, p_tipo: novo }));
      setAviso("Salvo. Vale para as próximas visitas agendadas.");
    } catch (e) {
      setTipo(antes);
      setErroSalvar(mensagemDeErro(e));
    }
  }

  return (
    <div className="painel">
      <h3>Visitas {proximas.length > 0 && <span className="etiqueta pronto">{proximas.length} marcada{proximas.length > 1 ? "s" : ""}</span>}</h3>
      <Erro mensagem={erro || erroSalvar} />
      {!dados ? <Carregando /> : (
        <div className="formulario">
          <a className="botao botao-agendar" href={`#agenda/novo?imovel=${encodeURIComponent(imovel.codigo)}&tipo=${tipoAgenda}`}><span aria-hidden="true">+</span> Agendar visita</a>
          {imovel.locacao && (
            <label className="campo">
              Tipo de visita (aluguel)
              <select value={atual} disabled={!podeMudar} onChange={(e) => mudar(e.target.value)}>
                {Object.entries(TIPOS_DE_VISITA).map(([id, nome]) => <option key={id} value={id}>{nome}</option>)}
              </select>
              {!podeMudar && <small className="mudo">Muda: o corretor responsável pelo imóvel, o gestor ou o administrativo.</small>}
            </label>
          )}
          {aviso && <p className="aviso-ok" role="status" style={{ margin: 0 }}>{aviso}</p>}
          {dados.visitas.length > 0 && (
            <ul className="historico-visitas">
              {dados.visitas.map((v) => (
                <li key={v.id}>
                  <a href={`#agenda/visita/${v.id}`}>
                    <span className="dado">{rotuloCurto(diaIso(v.inicio))} {hora(v.inicio)}</span>
                    <span>{TIPOS[v.tipo]?.[1]}{v.cliente_nome ? ` · ${v.cliente_nome}` : ""}{v.corretor?.nome ? ` · ${primeiroNome(v.corretor.nome)}` : ""}</span>
                    <span className={`etiqueta ${STATUS[v.status]?.[1] ?? "pendente"}`}>{STATUS[v.status]?.[0] ?? v.status}</span>
                    {v.retorno && <span className="etiqueta pronto">{RETORNOS.find(([id]) => id === v.retorno)?.[1]}</span>}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// Configurações → Regras: grade da agenda de aluguel (gestor e administrativo).
const DIAS_DA_SEMANA = [[1, "Seg"], [2, "Ter"], [3, "Qua"], [4, "Qui"], [5, "Sex"], [6, "Sáb"], [7, "Dom"]];

export function GradeDaAgenda() {
  const { souGestor, versao, recarregar } = useSessao();
  const { dados, erro } = useCarregar(async () => {
    const linha = exigir(await supabase.from("configuracoes").select("valor").eq("chave", "agenda_visitas").maybeSingle());
    return { duracao_minutos: 60, dias: [1, 2, 3, 4, 5, 6], inicio: "08:00", ultimo_inicio: "15:00", ...(linha?.valor ?? {}) };
  }, [versao]);
  const [campos, setCampos] = useState(null);
  const [salvo, setSalvo] = useState(null);
  const [erroSalvar, setErroSalvar] = useState(null);
  const [ocupado, setOcupado] = useState(false);
  useEffect(() => {
    if (dados) setCampos(dados);
  }, [dados]);

  async function salvar(evento) {
    evento.preventDefault();
    setSalvo(null);
    setErroSalvar(null);
    setOcupado(true);
    try {
      exigir(await supabase.rpc("salvar_agenda_visitas", { p_duracao: Number(campos.duracao_minutos), p_dias: campos.dias, p_inicio: campos.inicio, p_ultimo_inicio: campos.ultimo_inicio }));
      setSalvo("Agenda salva. Vale para os próximos agendamentos; as visitas já marcadas continuam como estão.");
      recarregar();
    } catch (e) {
      setErroSalvar(mensagemDeErro(e));
    } finally {
      setOcupado(false);
    }
  }

  if (!campos) return <><Erro mensagem={erro} /><Carregando /></>;
  const alternarDia = (d) => setCampos({ ...campos, dias: campos.dias.includes(d) ? campos.dias.filter((x) => x !== d) : [...campos.dias, d].sort() });
  return (
    <form className="painel formulario" onSubmit={salvar}>
      <h3 style={{ margin: 0 }}>Grade das visitas (aluguel e venda)</h3>
      <p className="mudo" style={{ margin: 0 }}>Dias e horários oferecidos para visitar os imóveis, de 1 em 1 hora, da primeira visita até o último início. Cada visita ocupa o imóvel pela duração escolhida; um horário ocupado aparece com o nome de quem marcou e ninguém mais consegue escolher. Captações e outros compromissos têm horário livre. Horário de Campo Grande.</p>
      <div className="filtros" role="group" aria-label="Dias com visita">
        {DIAS_DA_SEMANA.map(([d, nome]) => (
          <button key={d} type="button" className="filtro" aria-pressed={campos.dias.includes(d)} disabled={!souGestor} onClick={() => alternarDia(d)}>{nome}</button>
        ))}
      </div>
      <div className="grade-prazos">
        <label className="campo">
          Primeira visita às
          <input type="time" required value={campos.inicio} disabled={!souGestor} onChange={(e) => setCampos({ ...campos, inicio: e.target.value })} />
        </label>
        <label className="campo">
          Último início às
          <input type="time" required value={campos.ultimo_inicio} disabled={!souGestor} onChange={(e) => setCampos({ ...campos, ultimo_inicio: e.target.value })} />
        </label>
        <label className="campo">
          Duração de cada visita (minutos)
          <input type="number" required min={15} max={240} step={15} value={campos.duracao_minutos} disabled={!souGestor} onChange={(e) => setCampos({ ...campos, duracao_minutos: e.target.value })} />
        </label>
      </div>
      <Erro mensagem={erroSalvar} />
      {salvo && <p className="aviso-ok" role="status">{salvo}</p>}
      {souGestor && <button className="botao" type="submit" disabled={ocupado} style={{ alignSelf: "flex-start" }}>{ocupado ? "Salvando…" : "Salvar agenda"}</button>}
    </form>
  );
}
