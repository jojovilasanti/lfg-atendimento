// Módulo de Locação (substitui o Unilocweb). Só gestor e administrativo; o
// banco recusa o resto (interno.acessa_locacao). Etapa 1: a base do módulo,
// com os parâmetros padrão dos contratos e as unidades de captação.
// Plano completo: documentos/locacao/fase-0-plano.md.
import { useEffect, useState } from "react";
import Segmento from "../base/Segmento.jsx";
import Contador from "../base/Contador.jsx";
import { useAviso } from "../base/Avisos.jsx";
import { Carregando, dataHora, Erro, Interruptor, useCarregar } from "../comum.jsx";
import { useSessao } from "../sessao.jsx";
import { exigir, mensagemDeErro, supabase } from "../supabase.js";

const PARTES = [
  ["visao", "Visão geral"],
  ["parametros", "Parâmetros padrão"],
  ["unidades", "Unidades"],
  ["historico", "Histórico"],
];

// As etapas do plano, na ordem. "pronta" só muda quando a etapa vai ao ar.
const ETAPAS = [
  [1, "Base do módulo", "Acesso só da gestão, parâmetros padrão, unidades e histórico de alterações", "pronta"],
  [2, "Pessoas e imóveis administrados", "Cadastro com CPF/CNPJ, dados bancários e PIX; locadores com % de cada um", "pronta"],
  [3, "Importação do Unilocweb", "Pessoas, imóveis e contratos que já existem, com tela de pendências"],
  [4, "Contratos", "Cadastro com simulação dos períodos, ativação e painel da locação"],
  [5, "Contratos padrão", "Geração do contrato preenchido a partir dos modelos da LFG"],
  [6, "Reajustes", "Índices econômicos e reajuste em lote com histórico"],
  [7, "Lançamentos", "IPTU, condomínio, seguros, acordos e parcelas"],
  [8, "Cobrança", "Emissão individual e em lote, baixa com multa e juros"],
  [9, "Financeiro", "Contas a pagar, plano de contas e controle de caixa"],
  [10, "Repasses", "Por locador, por imóvel e em lote, com IRRF"],
  [11, "Rescisões", "Cálculo da rescisão, estornos e imóvel de volta ao site"],
  [12, "Relatórios e e-mails", "Recibos, informe de IR, DIMOB e listagens"],
  [13, "Banco e notas fiscais", "Boleto, PIX, retorno do banco e NFS-e (escolha no fim do projeto)"],
  [14, "Vistoria", "Laudos de entrada e saída com fotos"],
];

const INDICES = ["IGP-M", "IPCA", "INPC", "IVAR", "IGP-DI", "FIXO"];

export default function Locacao() {
  const [parte, setParte] = useState("visao");
  return (
    <section className="vista" aria-labelledby="t-locacao">
      <div className="cabeca-vista">
        <div>
          <h2 id="t-locacao">Locação</h2>
          <p>Contratos de aluguel, cobrança, repasse aos proprietários e rescisões. Só a gestão vê esta área.</p>
        </div>
      </div>
      <Segmento rotulo="Partes da Locação" valor={parte} aoMudar={setParte} opcoes={PARTES.map(([id, rotulo]) => ({ id, rotulo }))} />
      {parte === "visao" && <VisaoGeral />}
      {parte === "parametros" && <Parametros />}
      {parte === "unidades" && <Unidades />}
      {parte === "historico" && <Historico />}
    </section>
  );
}

// Números dos contratos (locacao_indicadores). Cada cartão abre a lista filtrada.
const INDICADORES = [
  ["ativos", "Contratos ativos", "", null],
  ["novos", "Novos nos últimos 30 dias", "destaque", "novos"],
  ["reajuste", "Reajuste até o fim do mês", "", "reajuste"],
  ["vencendo", "Vencem em até 15 dias", "alerta", "vencendo"],
  ["vencidos", "Vigência vencida", "alerta", "vencidos"],
  ["sem_garantia", "Sem garantia", "alerta", "sem_garantia"],
  ["rascunhos", "Rascunhos", "", null],
];

function NumerosDosContratos() {
  const { versao } = useSessao();
  const { dados, erro } = useCarregar(async () => exigir(await supabase.rpc("locacao_indicadores")), [versao]);
  if (erro) return <Erro mensagem={erro} />;
  return (
    <div className="indicadores indicadores-locacao">
      {INDICADORES.map(([chave, rotulo, cor, filtro]) => (
        <a key={chave} className={`indicador clicavel ${cor}`} href={filtro ? `#contratos?f=${filtro}` : "#contratos"}>
          <span className="rotulo">{rotulo}</span>
          <b>{dados ? <Contador valor={dados[chave] ?? 0} /> : "…"}</b>
        </a>
      ))}
    </div>
  );
}

function VisaoGeral() {
  return (
    <>
    <NumerosDosContratos />
    <div className="painel">
      <h3>Como o módulo vai ficando pronto</h3>
      <p className="mudo pequeno" style={{ marginTop: 0 }}>
        O Unilocweb continua sendo o oficial até a troca (prevista para maio de 2027). Cada etapa é mostrada e aprovada antes de ir ao ar.
      </p>
      <ol className="etapas-locacao">
        {ETAPAS.map(([n, titulo, texto, situacao]) => (
          <li key={n} className={situacao === "pronta" ? "pronta" : ""}>
            <span className="etapa-numero" aria-hidden="true">{situacao === "pronta" ? "✓" : n}</span>
            <div>
              <b>{titulo}</b>
              <span className="mudo pequeno">{texto}</span>
            </div>
            <span className={`etiqueta ${situacao === "pronta" ? "pronto" : "pendente"}`}>{situacao === "pronta" ? "no ar" : "em breve"}</span>
          </li>
        ))}
      </ol>
    </div>
    </>
  );
}

function Parametros() {
  const avisar = useAviso();
  const { versao } = useSessao();
  const { dados, erro } = useCarregar(async () => {
    const linha = exigir(await supabase.from("configuracoes").select("valor, atualizado_em").eq("chave", "locacao_padroes").maybeSingle());
    return linha;
  }, [versao]);
  const [campos, setCampos] = useState(null);
  const [ocupado, setOcupado] = useState(false);
  const [erroSalvar, setErroSalvar] = useState(null);
  useEffect(() => {
    if (dados?.valor && !campos) setCampos(dados.valor);
  }, [dados, campos]);

  if (erro) return <Erro mensagem={erro} />;
  if (!campos) return <Carregando />;
  const numero = (chave) => (e) => setCampos({ ...campos, [chave]: e.target.value === "" ? "" : Number(e.target.value) });
  const escolha = (chave) => (e) => setCampos({ ...campos, [chave]: e.target.value });

  async function salvar(evento) {
    evento.preventDefault();
    setOcupado(true);
    setErroSalvar(null);
    try {
      const { confirmado: _ignorar, ...valor } = campos;
      exigir(await supabase.rpc("salvar_locacao_padroes", { p_valor: valor }));
      setCampos({ ...campos, confirmado: true });
      avisar("Parâmetros padrão salvos.");
    } catch (e) {
      setErroSalvar(mensagemDeErro(e));
    } finally {
      setOcupado(false);
    }
  }

  return (
    <form className="painel formulario" onSubmit={salvar}>
      {!campos.confirmado && (
        <p className="aviso-locacao">
          Estes são os valores da tela de referência. Confira e ajuste para o que a LFG usa; ao salvar, eles passam a valer para os contratos novos.
        </p>
      )}
      <p className="mudo pequeno" style={{ margin: 0 }}>Valem como ponto de partida de cada contrato novo. Em cada contrato dá para mudar.</p>

      <h3 style={{ margin: "8px 0 0" }}>Prazo e reajuste</h3>
      <div className="grade-3">
        <label className="campo">Prazo do contrato (meses)<input type="number" min={1} max={240} required value={campos.prazo_meses} onChange={numero("prazo_meses")} /></label>
        <label className="campo">Reajuste a cada (meses)<input type="number" min={1} max={60} required value={campos.reajuste_meses} onChange={numero("reajuste_meses")} /></label>
        <label className="campo">Índice de reajuste
          <select value={campos.indice} onChange={escolha("indice")}>{INDICES.map((i) => <option key={i} value={i}>{i === "FIXO" ? "Percentual fixo" : i}</option>)}</select>
        </label>
      </div>

      <h3 style={{ margin: "8px 0 0" }}>Cobrança e repasse</h3>
      <div className="grade-2">
        <label className="campo">Dia da cobrança do locatário
          <span className="campo-par">
            <input type="number" min={1} max={31} required value={campos.dia_cobranca} onChange={numero("dia_cobranca")} />
            <select value={campos.cobranca_referencia} onChange={escolha("cobranca_referencia")}>
              <option value="apos_periodo">Após o período</option>
              <option value="no_periodo">No período</option>
            </select>
          </span>
        </label>
        <label className="campo">Dia do repasse ao locador
          <span className="campo-par">
            <input type="number" min={1} max={31} required value={campos.dia_repasse} onChange={numero("dia_repasse")} />
            <select value={campos.repasse_referencia} onChange={escolha("repasse_referencia")}>
              <option value="apos_periodo">Após o período</option>
              <option value="no_periodo">No período</option>
            </select>
          </span>
        </label>
        <label className="campo">Desconto de pontualidade (%)<input type="number" min={0} max={100} step="0.01" required value={campos.desconto_pontualidade} onChange={numero("desconto_pontualidade")} /></label>
      </div>

      <h3 style={{ margin: "8px 0 0" }}>Taxas da imobiliária</h3>
      <div className="grade-3">
        <label className="campo">Taxa de administração<input type="number" min={0} step="0.01" required value={campos.taxa_administracao} onChange={numero("taxa_administracao")} /></label>
        <label className="campo">Calculada sobre
          <select value={campos.taxa_base} onChange={escolha("taxa_base")}>
            <option value="percentual_aluguel">% do aluguel</option>
            <option value="percentual_cobranca">% do total cobrado</option>
            <option value="valor_fixo">Valor fixo (R$)</option>
          </select>
        </label>
        <label className="campo">Taxa de intermediação (% do 1º aluguel)<input type="number" min={0} max={200} step="0.01" required value={campos.taxa_intermediacao} onChange={numero("taxa_intermediacao")} /></label>
      </div>

      <h3 style={{ margin: "8px 0 0" }}>Atraso</h3>
      <div className="grade-3">
        <label className="campo">Multa por atraso (%)<input type="number" min={0} max={100} step="0.01" required value={campos.multa_percentual} onChange={numero("multa_percentual")} /></label>
        <label className="campo">Forma da multa
          <select value={campos.multa_forma} onChange={escolha("multa_forma")}>
            <option value="integral">Integral após o vencimento</option>
            <option value="diaria_30">Diária até 30 dias após o vencimento</option>
          </select>
        </label>
        <label className="campo">Multa sobre
          <select value={campos.multa_base} onChange={escolha("multa_base")}>
            <option value="total">Valor total da cobrança</option>
            <option value="aluguel">Só o aluguel</option>
          </select>
        </label>
        <label className="campo">Multa a partir do dia (após o vencimento)<input type="number" min={0} max={60} required value={campos.multa_a_partir_dia} onChange={numero("multa_a_partir_dia")} /></label>
        <label className="campo">Juros de mora (%)<input type="number" min={0} step="0.001" required value={campos.juros_percentual} onChange={numero("juros_percentual")} /></label>
        <label className="campo">Juros
          <select value={campos.juros_periodo} onChange={escolha("juros_periodo")}>
            <option value="dia">Ao dia</option>
            <option value="mes">Ao mês</option>
          </select>
        </label>
        <label className="campo">Juros a partir do dia (após o vencimento)<input type="number" min={0} max={60} required value={campos.juros_a_partir_dia} onChange={numero("juros_a_partir_dia")} /></label>
      </div>

      <h3 style={{ margin: "8px 0 0" }}>Rescisão</h3>
      <div className="grade-3">
        <label className="campo">Multa rescisória (nº de aluguéis)<input type="number" min={0} max={12} step="0.5" required value={campos.multa_rescisoria_alugueis} onChange={numero("multa_rescisoria_alugueis")} /></label>
      </div>

      <Erro mensagem={erroSalvar} />
      <div className="atalhos" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <span className="mudo pequeno">{dados?.atualizado_em ? `Última alteração em ${dataHora(dados.atualizado_em)}` : ""}</span>
        <button type="submit" className="botao" disabled={ocupado}>{ocupado ? "Salvando…" : "Salvar parâmetros"}</button>
      </div>
    </form>
  );
}

function Unidades() {
  const avisar = useAviso();
  const [rodada, setRodada] = useState(0);
  const { dados, erro } = useCarregar(async () => exigir(await supabase.from("locacao_unidades").select("id, nome, ativa").order("nome")), [rodada]);
  const [nova, setNova] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [erroAcao, setErroAcao] = useState(null);

  async function salvar(id, nome, ativa) {
    setOcupado(true);
    setErroAcao(null);
    try {
      exigir(await supabase.rpc("salvar_locacao_unidade", { p_id: id, p_nome: nome, p_ativa: ativa }));
      setRodada((n) => n + 1);
      return true;
    } catch (e) {
      setErroAcao(mensagemDeErro(e));
      return false;
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="painel formulario">
      <p className="mudo pequeno" style={{ margin: 0 }}>Unidade que captou cada contrato. Aparece no cadastro do contrato e nos relatórios.</p>
      <Erro mensagem={erro || erroAcao} />
      {!dados ? <Carregando /> : (
        <ul className="lista unidades-locacao">
          {dados.map((u) => (
            <li key={u.id}>
              <b>{u.nome}</b>
              <label className="linha-interruptor" style={{ alignItems: "center" }}>
                <Interruptor ligado={u.ativa} aoMudar={(ligada) => salvar(u.id, u.nome, ligada)} rotulo={`${u.ativa ? "Desativar" : "Ativar"} a unidade ${u.nome}`} desativado={ocupado} />
                <span className="pequeno mudo">{u.ativa ? "ativa" : "desativada"}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <form className="atalhos" onSubmit={async (e) => { e.preventDefault(); if (await salvar(null, nova, true)) { avisar(`Unidade ${nova.trim()} criada.`); setNova(""); } }}>
        <label className="campo" style={{ flex: 1, margin: 0 }}>
          <span className="invisivel">Nome da nova unidade</span>
          <input placeholder="Nova unidade (ex.: Filial Centro)" maxLength={80} value={nova} onChange={(e) => setNova(e.target.value)} />
        </label>
        <button type="submit" className="botao secundario" disabled={ocupado || nova.trim().length < 2}>Adicionar</button>
      </form>
    </div>
  );
}

const NOME_DA_TABELA = { locacao_unidades: "Unidade", configuracoes: "Parâmetros padrão" };
const NOME_DA_ACAO = { criar: "criou", alterar: "alterou", excluir: "excluiu" };

function Historico() {
  const { versao } = useSessao();
  const { dados, erro } = useCarregar(async () => {
    const [rLinhas, rEquipe] = await Promise.all([
      supabase.from("locacao_auditoria").select("id, tabela, registro_id, acao, depois, corretor_id, criado_em").order("criado_em", { ascending: false }).limit(100),
      supabase.from("corretores").select("id, nome"),
    ]);
    return { linhas: exigir(rLinhas), nomes: new Map(exigir(rEquipe).map((c) => [c.id, c.nome])) };
  }, [versao]);
  if (erro) return <Erro mensagem={erro} />;
  if (!dados) return <Carregando />;
  return (
    <div className="painel">
      <p className="mudo pequeno" style={{ marginTop: 0 }}>Toda alteração na Locação fica registrada aqui: quem fez, o quê e quando. As operações financeiras também vão entrar.</p>
      {dados.linhas.length === 0 ? <p className="mudo" style={{ margin: 0 }}>Nada alterado ainda.</p> : (
        <ul className="lista historico-locacao">
          {dados.linhas.map((l) => (
            <li key={l.id}>
              <span className="dado pequeno">{dataHora(l.criado_em)}</span>
              <span><b>{dados.nomes.get(l.corretor_id) ?? "Sistema"}</b> {NOME_DA_ACAO[l.acao]} {(NOME_DA_TABELA[l.tabela] ?? l.tabela).toLowerCase()}{l.depois?.nome ? `: ${l.depois.nome}` : ""}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
