import { useState } from "react";
import { Carregando, dataHora, diasDesde, Erro, EtiquetaPrazo, jaVenceu, nomeTipo, OPERACAO, quando, reais, TIPOS, useCarregar } from "../comum.jsx";
import { ETAPAS, etapaFinal, NOME_DA_ETAPA, useMudarEtapa, valorDigitado } from "../crm.jsx";
import { useSessao } from "../sessao.jsx";
import { chamarPainel, exigir, mensagemDeErro, supabase } from "../supabase.js";

const TIPOS_DE_REGISTRO = [["nota", "Nota"], ["ligacao", "Ligação"], ["visita", "Visita"], ["proposta", "Proposta"]];
const NOME_DO_REGISTRO = { ...Object.fromEntries(TIPOS_DE_REGISTRO), etapa: "Etapa", tarefa: "Passo concluído", imovel_enviado: "Imóvel enviado", prazo: "Prazo perdido" };

// Valor para o campo datetime-local, no horário do aparelho.
function paraCampo(data) {
  const ajustada = new Date(data.getTime() - data.getTimezoneOffset() * 60000);
  return ajustada.toISOString().slice(0, 16);
}

function amanhaAs9() {
  const data = new Date();
  data.setDate(data.getDate() + 1);
  data.setHours(9, 0, 0, 0);
  return data;
}

function emDias(dias) {
  const data = amanhaAs9();
  data.setDate(data.getDate() + dias - 1);
  return data;
}

const ATALHOS_DE_DATA = [
  ["Em 1 hora", () => new Date(Date.now() + 3600 * 1000)],
  ["Amanhã 9h", amanhaAs9],
  ["Em 3 dias", () => emDias(3)],
  ["Em 1 semana", () => emDias(7)],
];

function textoDoRegistro(a) {
  if (a.tipo !== "etapa") return a.conteudo;
  const { de, para, motivo, valor } = a.dados ?? {};
  const caminho = `${de ? `${NOME_DA_ETAPA[de]} → ` : ""}${NOME_DA_ETAPA[para] ?? para}`;
  return [caminho, motivo, valor != null ? reais(valor) : null].filter(Boolean).join(" · ");
}

function Passo({ tarefa, podeEditar, agir, ocupado }) {
  const [remarcando, setRemarcando] = useState(false);
  const [data, setData] = useState(() => paraCampo(amanhaAs9()));
  const atrasado = jaVenceu(tarefa.vence_em);

  const concluir = () => agir(async () => exigir(await supabase.rpc("concluir_tarefa", { p_tarefa_id: tarefa.id })));
  const salvar = () => agir(async () => {
    exigir(await supabase.rpc("remarcar_tarefa", { p_tarefa_id: tarefa.id, p_vence_em: new Date(data).toISOString() }));
    setRemarcando(false);
  });

  return (
    <li className="passo">
      <input type="checkbox" aria-label={`Concluir: ${tarefa.titulo}`} checked={false} disabled={!podeEditar || ocupado} onChange={concluir} />
      <div>
        <span>{tarefa.titulo}</span>
        <span className="pequeno"><EtiquetaPrazo prazo={tarefa.vence_em} /> <span className={atrasado ? "texto-critico" : "mudo"}>{quando(tarefa.vence_em)}</span></span>
        {remarcando && (
          <span className="remarcar">
            <input type="datetime-local" aria-label="Nova data" value={data} onChange={(e) => setData(e.target.value)} />
            <button type="button" className="botao pequeno" disabled={ocupado || !data} onClick={salvar}>Salvar</button>
          </span>
        )}
      </div>
      {podeEditar && <button type="button" className="link-botao pequeno" onClick={() => setRemarcando(!remarcando)}>{remarcando ? "Fechar" : "Remarcar"}</button>}
    </li>
  );
}

// Etapa, próximos passos e histórico do cliente.
export function Negociacao({ lead, podeEditar, nomes }) {
  const { versao, recarregar } = useSessao();
  const etapas = useMudarEtapa();
  const [titulo, setTitulo] = useState("");
  const [vence, setVence] = useState(() => paraCampo(amanhaAs9()));
  const [tipoRegistro, setTipoRegistro] = useState("nota");
  const [registro, setRegistro] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState(null);

  const { dados, erro: erroAoCarregar } = useCarregar(async () => {
    const tarefas = exigir(await supabase.from("tarefas").select("*").eq("lead_id", lead.id).is("concluida_em", null).order("vence_em"));
    const atividades = exigir(await supabase.from("atividades").select("*").eq("lead_id", lead.id).order("id", { ascending: false }).limit(100));
    return { tarefas, atividades };
  }, [lead.id, versao]);

  async function agir(acao) {
    setOcupado(true);
    setErro(null);
    try {
      await acao();
      recarregar();
    } catch (e) {
      setErro(mensagemDeErro(e));
    } finally {
      setOcupado(false);
    }
  }

  const criarPasso = (evento) => {
    evento.preventDefault();
    agir(async () => {
      exigir(await supabase.rpc("criar_tarefa", { p_lead_id: lead.id, p_titulo: titulo, p_vence_em: new Date(vence).toISOString() }));
      setTitulo("");
      setVence(paraCampo(amanhaAs9()));
    });
  };
  const registrar = (evento) => {
    evento.preventDefault();
    agir(async () => {
      exigir(await supabase.rpc("registrar_atividade", { p_lead_id: lead.id, p_tipo: tipoRegistro, p_conteudo: registro }));
      setRegistro("");
    });
  };

  const encerrado = etapaFinal(lead.etapa);
  return (
    <>
      {lead.etapa ? (
        <label className="campo">Etapa · {diasDesde(lead.etapa_desde)}
          <select id="etapa-do-lead" value={lead.etapa} disabled={!podeEditar} onChange={(e) => etapas.pedir(lead, e.target.value)}>
            {ETAPAS.map(([id, nome]) => <option key={id} value={id}>{nome}</option>)}
          </select>
        </label>
      ) : (
        <p className="mudo pequeno" style={{ margin: 0 }}>O cliente entra no funil quando um corretor ficar com ele.</p>
      )}
      {lead.etapa === "perdido" && lead.motivo_perda && <p className="pequeno" style={{ margin: 0 }}><span className="mudo">Motivo:</span> {lead.motivo_perda}</p>}
      {lead.etapa === "fechado" && lead.valor_negocio != null && <p className="pequeno" style={{ margin: 0 }}><span className="mudo">Valor:</span> {reais(lead.valor_negocio)}</p>}
      <Erro mensagem={erro ?? etapas.erro ?? erroAoCarregar} />

      {!dados ? <Carregando /> : (
        <>
          <span className="rotulo">Próximos passos</span>
          {dados.tarefas.length > 0 ? (
            <ul className="lista">
              {dados.tarefas.map((t) => <Passo key={t.id} tarefa={t} podeEditar={podeEditar} agir={agir} ocupado={ocupado} />)}
            </ul>
          ) : !encerrado && <p className="pequeno texto-alerta" style={{ margin: 0 }}>Nenhum passo marcado. O que vem a seguir com este cliente?</p>}
          {podeEditar && !encerrado && (
            <form className="formulario" onSubmit={criarPasso}>
              <input id="novo-passo" aria-label="O que fazer" placeholder="Ex.: ligar para combinar a visita" maxLength={200} required value={titulo} onChange={(e) => setTitulo(e.target.value)} />
              <input id="novo-passo-data" type="datetime-local" aria-label="Quando" required value={vence} onChange={(e) => setVence(e.target.value)} />
              <div className="atalhos">
                {ATALHOS_DE_DATA.map(([rotulo, gerar]) => <button key={rotulo} type="button" className="filtro" onClick={() => setVence(paraCampo(gerar()))}>{rotulo}</button>)}
              </div>
              <button className="botao secundario" type="submit" disabled={ocupado}>Marcar passo</button>
            </form>
          )}

          <span className="rotulo">Histórico</span>
          {podeEditar && (
            <form className="formulario" onSubmit={registrar}>
              <div className="atalhos">
                {TIPOS_DE_REGISTRO.map(([id, nome]) => <button key={id} type="button" className="filtro" aria-pressed={tipoRegistro === id} onClick={() => setTipoRegistro(id)}>{nome}</button>)}
              </div>
              <textarea id="novo-registro" aria-label="O que aconteceu" rows={2} placeholder="O que aconteceu? A equipe vê; o cliente e a IA não." required value={registro} onChange={(e) => setRegistro(e.target.value)} />
              <button className="botao secundario" type="submit" disabled={ocupado}>Registrar</button>
            </form>
          )}
          {dados.atividades.length === 0 ? <p className="mudo pequeno" style={{ margin: 0 }}>Nada registrado ainda.</p> : (
            <ul className="lista historico">
              {dados.atividades.map((a) => (
                <li key={a.id}>
                  <span className="rotulo">{NOME_DO_REGISTRO[a.tipo] ?? a.tipo}</span>
                  <span>{textoDoRegistro(a)}</span>
                  <span className="mudo pequeno">{dataHora(a.criado_em)}{a.corretor_id ? ` · ${nomes.get(a.corretor_id) ?? "Equipe"}` : " · automático"}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {etapas.janela}
    </>
  );
}

const textoDoImovel = (i, lead) => [
  `*${nomeTipo(i.tipo)} · ${i.bairro}*`,
  [`${reais(i.valor)}${lead.interesse === "locacao" ? "/mês" : ""}`, i.dormitorios && `${i.dormitorios} quartos`, i.vagas && `${i.vagas} vagas`].filter(Boolean).join(" · "),
  i.link_site,
].join("\n");

// Imóveis do estoque que combinam com a ficha, prontos para mandar ao cliente.
export function ImoveisCompativeis({ lead, podeEditar, janelaAberta }) {
  const { versao, recarregar } = useSessao();
  const [ocupado, setOcupado] = useState(null);
  const [erro, setErro] = useState(null);
  const [copiado, setCopiado] = useState(null);

  const { dados, erro: erroAoCarregar } = useCarregar(
    async () => exigir(await supabase.rpc("imoveis_compativeis", { p_lead_id: lead.id, p_limite: 8 })),
    [lead.id, lead.interesse, JSON.stringify(lead.ficha), versao],
  );

  async function enviar(imovel) {
    setOcupado(imovel.codigo);
    setErro(null);
    try {
      await chamarPainel("enviar_mensagem", { lead_id: lead.id, texto: textoDoImovel(imovel, lead) });
      exigir(await supabase.rpc("registrar_atividade", {
        p_lead_id: lead.id,
        p_tipo: "imovel_enviado",
        p_conteudo: `${imovel.referencia} · ${nomeTipo(imovel.tipo)} · ${imovel.bairro}`,
        p_dados: { codigo: imovel.codigo, referencia: imovel.referencia },
      }));
      recarregar();
    } catch (e) {
      setErro(mensagemDeErro(e));
    } finally {
      setOcupado(null);
    }
  }

  async function copiar(imovel) {
    try {
      await navigator.clipboard.writeText(textoDoImovel(imovel, lead));
      setCopiado(imovel.codigo);
      setTimeout(() => setCopiado(null), 2000);
    } catch {
      setErro("O navegador não deixou copiar.");
    }
  }

  if (!lead.interesse || !OPERACAO[lead.interesse] || lead.interesse === "administrativo" || lead.interesse === "outro") {
    return <p className="mudo pequeno" style={{ margin: 0 }}>Diga na ficha se o cliente quer comprar ou alugar para ver os imóveis que combinam.</p>;
  }
  return (
    <>
      <p className="mudo pequeno" style={{ margin: 0 }}>Busca pelo que está na ficha: quanto mais completa, melhor. {janelaAberta ? "Enviar manda pelo número oficial e pausa a IA neste lead." : "A janela de 24 horas do WhatsApp está fechada: copie o texto para enviar."}</p>
      <Erro mensagem={erro ?? erroAoCarregar} />
      {!dados ? <Carregando /> : dados.length === 0 ? (
        <p className="pequeno" style={{ margin: 0 }}>Nenhum imóvel ativo combina com a ficha. Tente ampliar a região ou o orçamento.</p>
      ) : (
        <ul className="lista">
          {dados.map((i) => (
            <li key={i.codigo} className="compativel">
              <a className="imovel-mini" href={i.link_site} target="_blank" rel="noopener noreferrer">
                {i.foto_principal && <img src={i.foto_principal} alt={`Foto do imóvel ${i.referencia}`} loading="lazy" />}
                <div>
                  <b>{i.referencia}</b>
                  <strong>{reais(i.valor)}{lead.interesse === "locacao" ? "/mês" : ""}</strong>
                  <span>{nomeTipo(i.tipo)} · {i.bairro}</span>
                  <span>{[i.dormitorios && `${i.dormitorios} quartos`, i.vagas && `${i.vagas} vagas`].filter(Boolean).join(" · ") || "—"}</span>
                </div>
              </a>
              <div className="atalhos">
                {i.acima_do_orcamento && <span className="etiqueta alerta">acima do orçamento</span>}
                {i.ja_enviado && <span className="etiqueta pronto">enviado</span>}
              </div>
              {podeEditar && (
                <div className="atalhos">
                  {janelaAberta && <button type="button" className="botao pequeno" disabled={ocupado !== null} onClick={() => enviar(i)}>{ocupado === i.codigo ? "Enviando…" : "Enviar"}</button>}
                  <button type="button" className="botao secundario pequeno" onClick={() => copiar(i)}>{copiado === i.codigo ? "Copiado" : "Copiar texto"}</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// O corretor corrige ou completa a ficha que a Thais começou.
export function EditarCliente({ lead, aoFechar }) {
  const { recarregar } = useSessao();
  const f = lead.ficha ?? {};
  const [campos, setCampos] = useState({
    nome: lead.nome ?? "",
    email: lead.email ?? "",
    interesse: lead.interesse ?? "",
    temperatura: lead.temperatura ?? "",
    tipo_imovel: f.tipo_imovel ? String(f.tipo_imovel).toUpperCase() : "",
    regiao: f.regiao ?? "",
    orcamento_max: f.orcamento_max != null ? String(f.orcamento_max) : "",
    quartos: f.quartos != null ? String(f.quartos) : "",
    forma_pagamento: f.forma_pagamento ?? "",
    urgencia: f.urgencia ?? "",
    pet: f.pet === true,
    observacoes: f.observacoes ?? "",
  });
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState(null);
  const mudar = (campo) => (e) => setCampos({ ...campos, [campo]: e.target.value });

  async function salvar(evento) {
    evento.preventDefault();
    setOcupado(true);
    setErro(null);
    try {
      exigir(await supabase.rpc("editar_cliente", {
        p_lead_id: lead.id,
        p_nome: campos.nome,
        p_email: campos.email,
        p_interesse: campos.interesse || null,
        p_temperatura: campos.temperatura || null,
        p_ficha: {
          tipo_imovel: campos.tipo_imovel || null,
          regiao: campos.regiao.trim() || null,
          orcamento_max: valorDigitado(campos.orcamento_max),
          quartos: valorDigitado(campos.quartos),
          forma_pagamento: campos.forma_pagamento.trim() || null,
          urgencia: campos.urgencia.trim() || null,
          pet: campos.pet || null,
          observacoes: campos.observacoes.trim() || null,
        },
      }));
      recarregar();
      aoFechar();
    } catch (e) {
      setErro(mensagemDeErro(e));
      setOcupado(false);
    }
  }

  return (
    <form className="formulario" onSubmit={salvar}>
      <label className="campo">Nome<input id="ed-nome" maxLength={120} value={campos.nome} onChange={mudar("nome")} /></label>
      <label className="campo">E-mail<input id="ed-email" type="email" value={campos.email} onChange={mudar("email")} /></label>
      <div className="grade-2">
        <label className="campo">Procura
          <select id="ed-interesse" value={campos.interesse} onChange={mudar("interesse")}>
            <option value="">A definir</option>
            {Object.entries(OPERACAO).map(([id, nome]) => <option key={id} value={id}>{nome}</option>)}
          </select>
        </label>
        <label className="campo">Temperatura
          <select id="ed-temperatura" value={campos.temperatura} onChange={mudar("temperatura")}>
            <option value="">A definir</option>
            <option value="quente">Quente</option>
            <option value="morno">Morno</option>
            <option value="frio">Frio</option>
          </select>
        </label>
        <label className="campo">Tipo
          <select id="ed-tipo" value={campos.tipo_imovel} onChange={mudar("tipo_imovel")}>
            <option value="">Qualquer</option>
            {TIPOS.map((t) => <option key={t} value={t}>{nomeTipo(t)}</option>)}
          </select>
        </label>
        <label className="campo">Quartos<input id="ed-quartos" inputMode="numeric" value={campos.quartos} onChange={mudar("quartos")} /></label>
      </div>
      <label className="campo">Região ou bairros<input id="ed-regiao" placeholder="Tiradentes ou Moreninha" value={campos.regiao} onChange={mudar("regiao")} /></label>
      <label className="campo">Orçamento até<input id="ed-orcamento" inputMode="decimal" placeholder="350.000" value={campos.orcamento_max} onChange={mudar("orcamento_max")} /></label>
      <label className="campo">Pagamento<input id="ed-pagamento" value={campos.forma_pagamento} onChange={mudar("forma_pagamento")} /></label>
      <label className="campo">Urgência<input id="ed-urgencia" value={campos.urgencia} onChange={mudar("urgencia")} /></label>
      <label className="pequeno" style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <input id="ed-pet" type="checkbox" checked={campos.pet} onChange={(e) => setCampos({ ...campos, pet: e.target.checked })} />
        <span>Precisa aceitar pet</span>
      </label>
      <label className="campo">Observações<textarea id="ed-observacoes" rows={3} value={campos.observacoes} onChange={mudar("observacoes")} /></label>
      <Erro mensagem={erro} />
      <div className="acoes-formulario">
        <button type="button" className="botao secundario" onClick={aoFechar}>Cancelar</button>
        <button type="submit" className="botao" disabled={ocupado}>{ocupado ? "Salvando…" : "Salvar"}</button>
      </div>
    </form>
  );
}
