import { useState } from "react";
import { Carregando, diasDesde, Erro, EtiquetaPrazo, jaVenceu, OPERACAO, quando, reais, Temperatura, useCarregar, useEhCelular } from "../comum.jsx";
import { ETAPAS, etapaFinal, Janela, NOME_DA_ETAPA, ORIGENS, useMudarEtapa } from "../crm.jsx";
import { useSessao } from "../sessao.jsx";
import { exigir, mensagemDeErro, supabase } from "../supabase.js";

const ehTeste = (l) => l.whatsapp.startsWith("sim-");

function oQueProcura(lead) {
  const f = lead.ficha ?? {};
  return [
    OPERACAO[lead.interesse],
    f.regiao,
    f.orcamento_max != null ? `até ${reais(f.orcamento_max)}` : null,
  ].filter(Boolean).join(" · ");
}

function CartaoDoFunil({ lead, passo, corretor, podeMover, celular, aoAbrir, aoMover }) {
  const final = etapaFinal(lead.etapa);
  const atrasado = passo && jaVenceu(passo.vence_em);
  return (
    <article
      className="cartao-funil"
      draggable={podeMover && !celular}
      onDragStart={(e) => e.dataTransfer.setData("text/plain", lead.id)}
      onClick={aoAbrir}
    >
      <div className="topo-cartao">
        <button type="button" className="nome" onClick={aoAbrir}>{lead.nome ?? "Cliente sem nome"}</button>
        <Temperatura valor={lead.temperatura} />
      </div>
      {oQueProcura(lead) && <span className="mudo">{oQueProcura(lead)}</span>}
      {final ? (
        <span className="mudo">{lead.etapa === "perdido" ? lead.motivo_perda : lead.valor_negocio != null ? reais(lead.valor_negocio) : "Negócio fechado"}</span>
      ) : passo ? (
        <span className={`proximo ${atrasado ? "atrasado" : ""}`}><EtiquetaPrazo prazo={passo.vence_em} /> <b>{quando(passo.vence_em)}</b> {passo.titulo}</span>
      ) : (
        <span className="proximo sem">Sem próximo passo</span>
      )}
      <span className="rodape-cartao mudo">
        <span>{diasDesde(lead.etapa_desde)}{ehTeste(lead) ? " · teste" : ""}</span>
        {corretor && <span>{corretor}</span>}
      </span>
      {podeMover && (
        <select
          aria-label={`Mudar a etapa de ${lead.nome ?? "cliente sem nome"}`}
          value={lead.etapa}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => aoMover(lead, e.target.value)}
        >
          {ETAPAS.map(([id, nome]) => <option key={id} value={id}>{nome}</option>)}
        </select>
      )}
    </article>
  );
}

function NovoCliente({ equipe, aoCriar, aoFechar }) {
  const { eu, souGestor } = useSessao();
  const [campos, setCampos] = useState({ nome: "", telefone: "", email: "", origem: "indicacao", interesse: "", corretor: eu.id, observacoes: "" });
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState(null);
  const [existente, setExistente] = useState(null);
  const mudar = (campo) => (e) => setCampos({ ...campos, [campo]: e.target.value });

  async function salvar(evento) {
    evento.preventDefault();
    setOcupado(true);
    setErro(null);
    setExistente(null);
    try {
      const r = exigir(await supabase.rpc("criar_cliente", {
        p_nome: campos.nome,
        p_whatsapp: campos.telefone,
        p_email: campos.email,
        p_origem: campos.origem,
        p_interesse: campos.interesse || null,
        p_corretor_id: souGestor ? campos.corretor : null,
        p_observacoes: campos.observacoes,
      }));
      if (r.situacao === "criado") return aoCriar(r.lead_id);
      setExistente(r);
    } catch (e) {
      setErro(mensagemDeErro(e));
    }
    setOcupado(false);
  }

  return (
    <Janela titulo="Novo cliente" aoFechar={aoFechar}>
      <form onSubmit={salvar} className="formulario">
        <label className="campo">Nome<input id="novo-nome" required maxLength={120} value={campos.nome} onChange={mudar("nome")} /></label>
        <div className="grade-2">
          <label className="campo">WhatsApp ou telefone<input id="novo-telefone" required inputMode="tel" placeholder="(67) 99999-9999" value={campos.telefone} onChange={mudar("telefone")} /></label>
          <label className="campo">E-mail (opcional)<input id="novo-email" type="email" value={campos.email} onChange={mudar("email")} /></label>
          <label className="campo">Como chegou
            <select id="novo-origem" value={campos.origem} onChange={mudar("origem")}>
              {Object.entries(ORIGENS).map(([id, nome]) => <option key={id} value={id}>{nome}</option>)}
            </select>
          </label>
          <label className="campo">Procura
            <select id="novo-interesse" value={campos.interesse} onChange={mudar("interesse")}>
              <option value="">A definir</option>
              <option value="compra">Comprar</option>
              <option value="locacao">Alugar</option>
              <option value="outro">Outro assunto</option>
            </select>
          </label>
        </div>
        {souGestor && (
          <label className="campo">Corretor
            <select id="novo-corretor" value={campos.corretor} onChange={mudar("corretor")}>
              {equipe.filter((p) => p.ativo).map((p) => <option key={p.id} value={p.id}>{p.nome}</option>)}
            </select>
          </label>
        )}
        <label className="campo">Observações (opcional)<textarea id="novo-observacoes" rows={2} value={campos.observacoes} onChange={mudar("observacoes")} /></label>
        <p className="mudo pequeno" style={{ margin: 0 }}>A IA não fala com clientes cadastrados aqui. Eles entram em "A contatar".</p>
        <Erro mensagem={erro} />
        {existente && (
          <p className="aviso-erro" role="alert" style={{ margin: 0 }}>
            Esse número já está cadastrado{existente.corretor_nome ? `, com ${existente.corretor_nome}` : ", ainda sem corretor"}.{" "}
            {existente.lead_id ? <button type="button" className="link-botao" onClick={() => aoCriar(existente.lead_id)}>Abrir o cliente</button> : "Fale com o gestor."}
          </p>
        )}
        <div className="acoes-formulario">
          <button type="button" className="botao secundario" onClick={aoFechar}>Cancelar</button>
          <button type="submit" className="botao" disabled={ocupado}>{ocupado ? "Salvando…" : "Cadastrar"}</button>
        </div>
      </form>
    </Janela>
  );
}

export default function Funil({ abrirLead }) {
  const { eu, versao, souGestor } = useSessao();
  const celular = useEhCelular();
  const [filtroCorretor, setFiltroCorretor] = useState("");
  const [busca, setBusca] = useState("");
  const [mostrarTestes, setMostrarTestes] = useState(false);
  const [colunaNoCelular, setColunaNoCelular] = useState(ETAPAS[0][0]);
  const [colunaAlvo, setColunaAlvo] = useState(null);
  const [criando, setCriando] = useState(false);
  const etapas = useMudarEtapa();

  const { dados, erro } = useCarregar(async () => {
    // Fechados e perdidos ficam à vista por 30 dias; depois, só na lista de leads.
    const desde = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const leads = exigir(
      await supabase
        .from("leads")
        .select("id, nome, whatsapp, temperatura, interesse, ficha, corretor_id, etapa, etapa_desde, motivo_perda, valor_negocio")
        .in("status", ["com_corretor", "encerrado"])
        .not("etapa", "is", null)
        .or(`etapa.in.(a_contatar,em_contato,visita,proposta),etapa_desde.gte."${desde}"`)
        .order("etapa_desde", { ascending: false })
        .limit(500),
    );
    const tarefas = exigir(await supabase.from("tarefas").select("id, lead_id, titulo, vence_em").is("concluida_em", null).order("vence_em"));
    const equipe = exigir(await supabase.from("corretores").select("id, nome, ativo").order("nome"));
    const passos = new Map();
    for (const t of tarefas) if (!passos.has(t.lead_id)) passos.set(t.lead_id, t);
    return { leads, passos, equipe, nomes: new Map(equipe.map((p) => [p.id, p.nome])) };
  }, [versao]);

  const termo = busca.trim().toLowerCase();
  const todos = dados?.leads ?? [];
  const testes = todos.filter(ehTeste).length;
  const visiveis = todos
    .filter((l) => mostrarTestes || !ehTeste(l))
    .filter((l) => !filtroCorretor || l.corretor_id === filtroCorretor)
    .filter((l) => !termo || `${l.nome ?? ""} ${l.whatsapp} ${l.ficha?.regiao ?? ""}`.toLowerCase().includes(termo));
  const abertos = visiveis.filter((l) => !etapaFinal(l.etapa));
  const semPasso = abertos.filter((l) => !dados.passos.has(l.id)).length;
  const atrasados = abertos.filter((l) => dados.passos.has(l.id) && jaVenceu(dados.passos.get(l.id).vence_em)).length;
  const colunas = ETAPAS.filter(([id]) => !celular || id === colunaNoCelular);
  const podeMover = (lead) => souGestor || lead.corretor_id === eu.id;

  function soltar(evento, etapa) {
    evento.preventDefault();
    setColunaAlvo(null);
    const lead = todos.find((l) => l.id === evento.dataTransfer.getData("text/plain"));
    if (lead && podeMover(lead)) etapas.pedir(lead, etapa);
  }

  return (
    <section className="vista larga" aria-labelledby="t-funil">
      <div className="cabeca-vista">
        <div>
          <h2 id="t-funil">Funil</h2>
          <p>Em que pé está cada negociação e qual é o próximo passo. O cliente entra aqui quando um corretor fica com ele.</p>
        </div>
        <button type="button" className="botao acao-principal" onClick={() => setCriando(true)}>Novo cliente</button>
      </div>

      <div className="filtros">
        {celular && (
          <div className="chips">
            {ETAPAS.map(([id, nome]) => (
              <button key={id} type="button" className="filtro" aria-pressed={colunaNoCelular === id} onClick={() => setColunaNoCelular(id)}>
                {nome} <b>{visiveis.filter((l) => l.etapa === id).length}</b>
              </button>
            ))}
          </div>
        )}
        {testes > 0 && (
          <button type="button" className="filtro" aria-pressed={mostrarTestes} onClick={() => setMostrarTestes(!mostrarTestes)}>Testes do simulador <b>{testes}</b></button>
        )}
        {souGestor && (
          <select id="funil-corretor" aria-label="Filtrar por corretor" className="filtro-select" value={filtroCorretor} onChange={(e) => setFiltroCorretor(e.target.value)}>
            <option value="">Toda a equipe</option>
            {(dados?.equipe ?? []).map((p) => <option key={p.id} value={p.id}>{p.nome}</option>)}
          </select>
        )}
        <input className="busca" id="busca-funil" type="search" placeholder="Buscar por nome, número ou região" value={busca} onChange={(e) => setBusca(e.target.value)} />
      </div>

      <Erro mensagem={erro ?? etapas.erro} />
      {!dados ? <Carregando /> : (
        <>
          <p className="mudo pequeno" style={{ margin: 0 }}>
            {abertos.length} em negociação
            {semPasso > 0 && <> · <span className="texto-alerta">{semPasso} sem próximo passo</span></>}
            {atrasados > 0 && <> · <span className="texto-critico">{atrasados} com passo atrasado</span></>}
          </p>
          <div className="quadro">
            {colunas.map(([id, nome]) => {
              const daEtapa = visiveis.filter((l) => l.etapa === id);
              return (
                <div
                  key={id}
                  className={`coluna ${colunaAlvo === id ? "alvo" : ""}`}
                  onDragOver={(e) => (e.preventDefault(), setColunaAlvo(id))}
                  onDragLeave={() => setColunaAlvo(null)}
                  onDrop={(e) => soltar(e, id)}
                >
                  <div className="cabeca-coluna"><span className="rotulo">{nome}</span><span className="dado mudo">{daEtapa.length}</span></div>
                  {daEtapa.map((l) => (
                    <CartaoDoFunil
                      key={l.id}
                      lead={l}
                      passo={dados.passos.get(l.id)}
                      corretor={souGestor ? dados.nomes.get(l.corretor_id) : null}
                      podeMover={podeMover(l)}
                      celular={celular}
                      aoAbrir={() => abrirLead(l.id)}
                      aoMover={etapas.pedir}
                    />
                  ))}
                  {daEtapa.length === 0 && <p className="mudo pequeno" style={{ margin: 0, padding: "4px" }}>{NOME_DA_ETAPA[id] === "A contatar" ? "Ninguém esperando contato." : "Nenhum cliente aqui."}</p>}
                </div>
              );
            })}
          </div>
        </>
      )}
      {etapas.janela}
      {criando && dados && <NovoCliente equipe={dados.equipe} aoCriar={(id) => { setCriando(false); abrirLead(id); }} aoFechar={() => setCriando(false)} />}
    </section>
  );
}
