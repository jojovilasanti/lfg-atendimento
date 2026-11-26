// Locação → Contratos: lista, cadastro (rascunho), simulação dos períodos e
// ativação. As contas ficam no banco (interno.calcular_periodos); a tela só
// mostra a simulação que o banco devolve. Só gestor e administrativo.
import { useEffect, useMemo, useRef, useState } from "react";
import Segmento from "../base/Segmento.jsx";
import { useAviso } from "../base/Avisos.jsx";
import { Carregando, dataHora, Erro, nomeTipo, reais, useCarregar } from "../comum.jsx";
import { Janela } from "../crm.jsx";
import { useSessao } from "../sessao.jsx";
import { exigir, mensagemDeErro, supabase } from "../supabase.js";
import { formatarDocumento, percentual } from "../locacao.js";
import { EscolherPessoa } from "./Pessoas.jsx";

const SITUACOES = {
  rascunho: ["Rascunho", "pendente", "R"],
  ativo: ["Ativo", "pronto", "A"],
  rescindido: ["Rescindido", "alerta", "X"],
  encerrado: ["Encerrado", "pendente", "E"],
};
const FILTROS = [
  ["ativos", "Ativos", (c) => c.situacao === "ativo"],
  ["rascunhos", "Rascunhos", (c) => c.situacao === "rascunho"],
  ["encerrados", "Encerrados", (c) => c.situacao === "rescindido" || c.situacao === "encerrado"],
  ["todos", "Todos", () => true],
];
// Filtros vindos dos indicadores do painel da Locação (#contratos?f=...).
const FILTROS_DO_PAINEL = {
  novos: ["Novos (30 dias)", (c, hoje) => c.situacao === "ativo" && c.inicio >= somarDias(hoje, -30)],
  reajuste: ["Para reajuste", (c, hoje) => c.situacao === "ativo" && c.proximo_reajuste && c.proximo_reajuste <= fimDoMes(hoje)],
  vencendo: ["Vencem em até 15 dias", (c, hoje) => c.situacao === "ativo" && c.termino >= hoje && c.termino <= somarDias(hoje, 15)],
  vencidos: ["Vigência vencida", (c, hoje) => c.situacao === "ativo" && c.termino < hoje],
  sem_garantia: ["Sem garantia", (c) => c.situacao === "ativo" && c.garantia_tipo === "nenhuma"],
};
const GARANTIAS_DO_CONTRATO = [
  ["nenhuma", "Nenhuma"], ["seguro_fianca_vista", "Seguro fiança à vista"], ["seguro_fianca_parcelado", "Seguro fiança parcelado com o aluguel"],
  ["caucao", "Caução"], ["titulo_capitalizacao", "Título de capitalização"], ["carta_fianca", "Carta fiança"], ["deposito", "Depósito de garantia"],
  ["cartao_credito", "Cartão de crédito"], ["fiador", "Fiador(es)"],
];
const hojeLocal = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const somarDias = (dia, n) => new Date(Date.parse(`${dia}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const fimDoMes = (dia) => { const [a, m] = dia.split("-").map(Number); return new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10); };
const dataCurta = (d) => (d ? d.split("-").reverse().join("/") : "—");
const semAcento = (t) => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

function lerFiltroDoEndereco() {
  const busca = location.hash.split("?")[1] ?? "";
  return new URLSearchParams(busca).get("f");
}

export default function Contratos({ aberto, ir }) {
  if (aberto) return <FichaContrato id={aberto === "novo" ? null : aberto} voltar={() => ir("contratos")} ir={ir} />;
  return <ListaDeContratos ir={ir} />;
}

function ListaDeContratos({ ir }) {
  const { versao } = useSessao();
  const [filtro, setFiltro] = useState("ativos");
  const [doPainel, setDoPainel] = useState(lerFiltroDoEndereco);
  const [busca, setBusca] = useState("");
  const { dados, erro } = useCarregar(async () => {
    const [rContratos, rEquipe] = await Promise.all([
      supabase.from("contratos")
        .select("id, numero, situacao, titulo_rascunho, controle, valor_inicial, valor_atual, inicio, termino, proximo_reajuste, garantia_tipo, supervisor_id, atualizado_em, imovel_codigo, imoveis_locacao(imoveis(referencia, tipo, endereco, numero, complemento, bairro, cidade)), contrato_partes(papel, ordem, pessoas!contrato_partes_pessoa_id_fkey(nome))")
        .order("atualizado_em", { ascending: false }).limit(2000),
      supabase.from("corretores").select("id, nome"),
    ]);
    return { contratos: exigir(rContratos), nomes: new Map(exigir(rEquipe).map((c) => [c.id, c.nome])) };
  }, [versao]);

  const hoje = hojeLocal();
  const termo = semAcento(busca.trim());
  const [, , regra] = FILTROS.find(([id]) => id === filtro);
  const regraDoPainel = doPainel && FILTROS_DO_PAINEL[doPainel];
  const nomeDe = (c, papel) => c.contrato_partes.filter((p) => p.papel === papel).sort((a, b) => a.ordem - b.ordem).map((p) => p.pessoas?.nome).filter(Boolean);
  const visiveis = (dados?.contratos ?? [])
    .filter((c) => (regraDoPainel ? regraDoPainel[1](c, hoje) : regra(c)))
    .filter((c) => !termo || semAcento(`${c.numero ?? ""} ${c.titulo_rascunho ?? ""} ${c.controle ?? ""} ${c.imoveis_locacao?.imoveis?.referencia ?? ""} ${nomeDe(c, "locatario").join(" ")} ${nomeDe(c, "locador").join(" ")}`).includes(termo));

  return (
    <section className="vista" aria-labelledby="t-contratos">
      <div className="cabeca-vista">
        <div>
          <h2 id="t-contratos">Contratos</h2>
          <p>Contratos de locação: rascunhos, ativos e encerrados. Só a gestão vê esta área.</p>
        </div>
        <button type="button" className="botao" onClick={() => ir("contratos", "novo")}>Novo contrato</button>
      </div>
      <div className="filtros">
        {regraDoPainel ? (
          <span className="etiqueta-filtro">{regraDoPainel[0]} <button type="button" aria-label="Tirar o filtro" onClick={() => { setDoPainel(null); history.replaceState(null, "", "#contratos"); }}>×</button></span>
        ) : (
          <Segmento rotulo="Situação dos contratos" valor={filtro} aoMudar={setFiltro} opcoes={FILTROS.map(([id, rotulo, r]) => ({ id, rotulo, conta: (dados?.contratos ?? []).filter(r).length }))} />
        )}
        <input className="busca" type="search" placeholder="Número, controle, imóvel, locatário ou locador" value={busca} onChange={(e) => setBusca(e.target.value)} />
      </div>
      <Erro mensagem={erro} />
      {!dados ? <Carregando /> : (
        <div className="tabela-caixa">
          <table className="tabela-contratos tabela-cartoes">
            <thead><tr><th>Contrato</th><th>Imóvel</th><th>Locatário / Locador</th><th>Valor</th><th>Endereço</th><th>Início</th><th>Supervisor</th></tr></thead>
            <tbody>
              {visiveis.length === 0 ? (
                <tr><td colSpan={7} className="mudo">{dados.contratos.length ? "Nenhum contrato com esse filtro." : "Nenhum contrato ainda. Comece em Novo contrato."}</td></tr>
              ) : visiveis.map((c) => {
                const [nomeSit, cor, letra] = SITUACOES[c.situacao];
                const i = c.imoveis_locacao?.imoveis ?? {};
                return (
                  <tr key={c.id} className="clicavel" tabIndex={0} onClick={() => ir("contratos", c.id)} onKeyDown={(e) => e.key === "Enter" && ir("contratos", c.id)}>
                    <td><span className="contrato-linha"><span className={`bolinha-situacao ${cor}`} title={nomeSit}>{letra}</span><span><span className="forte dado">{c.numero ?? "Rascunho"}</span><span className="sub">{c.titulo_rascunho ?? c.controle ?? ""}</span></span></span></td>
                    <td data-rotulo="Imóvel" className="dado">{i.referencia ?? "—"}<span className="sub">{nomeTipo(i.tipo)}</span></td>
                    <td data-rotulo="Locatário / Locador"><span className="forte">{nomeDe(c, "locatario").join(", ") || "—"}</span><span className="sub">{nomeDe(c, "locador").join(", ")}</span></td>
                    <td data-rotulo="Valor">{c.valor_atual || c.valor_inicial ? reais(c.valor_atual ?? c.valor_inicial) : "—"}</td>
                    <td data-rotulo="Endereço"><span>{[i.endereco, i.numero].filter(Boolean).join(", ") || "—"}</span><span className="sub">{i.complemento ?? ""}</span></td>
                    <td data-rotulo="Bairro / início"><span>{i.bairro ?? ""}</span><span className="sub">{dataCurta(c.inicio)}</span></td>
                    <td data-rotulo="Supervisor" className="pequeno">{dados.nomes.get(c.supervisor_id) ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mudo pequeno" style={{ margin: "10px 2px 0" }}>{visiveis.length} contrato{visiveis.length === 1 ? "" : "s"} encontrado{visiveis.length === 1 ? "" : "s"}</p>
        </div>
      )}
    </section>
  );
}

// Campos do formulário (texto, como nos inputs); números viram texto para o banco.
function camposDoContrato(c, padroes) {
  const p = padroes ?? {};
  const v = (campo, padrao = "") => (c?.[campo] ?? padrao) === null ? "" : String(c?.[campo] ?? padrao);
  return {
    titulo_rascunho: v("titulo_rascunho"), imovel_codigo: v("imovel_codigo"), regime_tributario: v("regime_tributario", "nao_informado"),
    preferencia_pagamento: v("preferencia_pagamento", "indiferente"), desconto_pontualidade: v("desconto_pontualidade", p.desconto_pontualidade ?? 0),
    finalidade: v("finalidade", "residencial"), valor_inicial: v("valor_inicial"), indice: v("indice", p.indice ?? "IGP-M"), indice_fixo: v("indice_fixo"),
    controle: v("controle"), garantia_aluguel: Boolean(c?.garantia_aluguel), garantia_aluguel_meses: v("garantia_aluguel_meses"),
    inicio: v("inicio"), prazo_meses: v("prazo_meses", p.prazo_meses ?? 36), reajuste_meses: v("reajuste_meses", p.reajuste_meses ?? 12),
    dia_inicio_periodo: v("dia_inicio_periodo"), dia_cobranca: v("dia_cobranca", p.dia_cobranca ?? 2), cobranca_referencia: v("cobranca_referencia", p.cobranca_referencia ?? "apos_periodo"),
    dia_repasse: v("dia_repasse", p.dia_repasse ?? 5), repasse_referencia: v("repasse_referencia", p.repasse_referencia ?? "apos_periodo"),
    taxa_administracao: v("taxa_administracao", p.taxa_administracao ?? ""), taxa_base: v("taxa_base", p.taxa_base ?? "percentual_aluguel"),
    taxa_proporcional: c ? Boolean(c.taxa_proporcional) : true, taxa_intermediacao: v("taxa_intermediacao", p.taxa_intermediacao ?? ""),
    multa_percentual: v("multa_percentual", p.multa_percentual ?? 10), multa_forma: v("multa_forma", p.multa_forma ?? "integral"), multa_base: v("multa_base", p.multa_base ?? "total"),
    multa_a_partir_dia: v("multa_a_partir_dia", p.multa_a_partir_dia ?? 1), multa_pj_omitir: Boolean(c?.multa_pj_omitir),
    juros_percentual: v("juros_percentual", p.juros_percentual ?? 0.033), juros_periodo: v("juros_periodo", p.juros_periodo ?? "dia"), juros_a_partir_dia: v("juros_a_partir_dia", p.juros_a_partir_dia ?? 1),
    irrf_modo: v("irrf_modo", "percentual"), garantia_tipo: v("garantia_tipo", "nenhuma"), garantia_dados: c?.garantia_dados ?? {},
    supervisor_id: v("supervisor_id"), comissao_supervisor: v("comissao_supervisor", 0), clausula_pintura: Boolean(c?.clausula_pintura), clausula_meses: Boolean(c?.clausula_meses),
    unidade_id: v("unidade_id"), liberado_lancamentos: c ? Boolean(c.liberado_lancamentos) : true, fora_do_lote: Boolean(c?.fora_do_lote), contrato_parcial: Boolean(c?.contrato_parcial),
    movimentacao_desde: v("movimentacao_desde"), movimentacao_proporcional: Boolean(c?.movimentacao_proporcional), ultimo_reajuste_em: v("ultimo_reajuste_em"),
    valor_vigente: v("valor_vigente"), meses_para_reajuste: v("meses_para_reajuste"), multa_rescisoria_alugueis: v("multa_rescisoria_alugueis", p.multa_rescisoria_alugueis ?? 3),
    observacoes: v("observacoes"),
  };
}

const SECOES = [
  ["c-imovel", "Imóvel"], ["c-locatarios", "Locatários"], ["c-dados", "Dados do contrato"], ["c-periodos", "Períodos"], ["c-taxa", "Taxa administrativa"],
  ["c-atraso", "Multa e juros"], ["c-irrf", "Imposto de renda"], ["c-garantia", "Garantia"], ["c-adicionais", "Adicionais"], ["c-movimentacao", "Início da movimentação"], ["c-demonstrativo", "Demonstrativo"],
];

function FichaContrato({ id, voltar, ir }) {
  const avisar = useAviso();
  const { versao, recarregar } = useSessao();
  const [idAtual, setIdAtual] = useState(id);
  const { dados, erro } = useCarregar(async () => {
    const [rContrato, rPartes, rPadroes, rEquipe, rUnidades, rImoveis] = await Promise.all([
      idAtual ? supabase.from("contratos").select("*").eq("id", idAtual).maybeSingle() : { data: null, error: null },
      idAtual ? supabase.from("contrato_partes").select("pessoa_id, papel, percentual, ordem, pessoas!contrato_partes_pessoa_id_fkey(id, nome, documento, cadastro_completo)").eq("contrato_id", idAtual).order("ordem") : { data: [], error: null },
      supabase.from("configuracoes").select("valor").eq("chave", "locacao_padroes").maybeSingle(),
      supabase.from("corretores").select("id, nome, papel").eq("ativo", true).order("nome"),
      supabase.from("locacao_unidades").select("id, nome, ativa").order("nome"),
      supabase.from("imoveis_locacao").select("imovel_codigo, imoveis(referencia, tipo, endereco, numero, bairro, valor_locacao), imovel_locadores(percentual, pessoas!imovel_locadores_pessoa_id_fkey(nome))"),
    ]);
    const contrato = exigir(rContrato);
    if (idAtual && !contrato) throw new Error("Contrato não encontrado.");
    return { contrato, partes: exigir(rPartes), padroes: exigir(rPadroes)?.valor ?? {}, supervisores: exigir(rEquipe), unidades: exigir(rUnidades), imoveis: exigir(rImoveis) };
  }, [idAtual, versao]);

  const [campos, setCampos] = useState(null);
  const [locatarios, setLocatarios] = useState([]);
  const [fiadores, setFiadores] = useState([]);
  const [escolhendo, setEscolhendo] = useState(null); // "locatario" | "fiador" | "imovel"
  const [ocupado, setOcupado] = useState(false);
  const [erroSalvar, setErroSalvar] = useState(null);
  const [simulacao, setSimulacao] = useState(null);

  useEffect(() => {
    if (!dados) return;
    setCampos(camposDoContrato(dados.contrato, dados.padroes));
    const pessoa = (p) => p.pessoas;
    setLocatarios(dados.partes.filter((p) => p.papel === "locatario").map(pessoa));
    setFiadores(dados.partes.filter((p) => p.papel === "fiador").map(pessoa));
  }, [dados]);

  const ativo = dados?.contrato?.situacao === "ativo";
  const travado = ativo || dados?.contrato?.situacao === "rescindido" || dados?.contrato?.situacao === "encerrado";
  const fechado = dados?.contrato && ["rescindido", "encerrado"].includes(dados.contrato.situacao);

  // Simulação dos períodos: o banco calcula (mesma conta da ativação).
  const chaveSimulacao = campos ? JSON.stringify([campos.inicio, campos.prazo_meses, campos.reajuste_meses, campos.dia_inicio_periodo, campos.dia_cobranca, campos.cobranca_referencia, campos.dia_repasse, campos.repasse_referencia, campos.valor_inicial, campos.taxa_proporcional, campos.movimentacao_desde, campos.valor_vigente]) : "";
  const ultimaSimulacao = useRef(0);
  useEffect(() => {
    if (!campos) return;
    const faltam = ["inicio", "prazo_meses", "reajuste_meses", "dia_cobranca", "dia_repasse", "valor_inicial"].filter((k) => !String(campos[k] ?? "").trim());
    if (faltam.length) { setSimulacao({ faltam }); return; }
    const vez = ++ultimaSimulacao.current;
    const espera = setTimeout(async () => {
      const { data, error } = await supabase.rpc("simular_periodos", { p_dados: campos });
      if (vez !== ultimaSimulacao.current) return;
      setSimulacao(error ? { erro: mensagemDeErro(error) } : { periodos: data ?? [] });
    }, 400);
    return () => clearTimeout(espera);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chaveSimulacao]);

  const mudar = (campo) => (e) => setCampos((c) => ({ ...c, [campo]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const imovelEscolhido = useMemo(() => (dados?.imoveis ?? []).find((i) => i.imovel_codigo === campos?.imovel_codigo), [dados, campos?.imovel_codigo]);
  const somaLocadores = (imovelEscolhido?.imovel_locadores ?? []).reduce((s, l) => s + Number(l.percentual), 0);

  async function salvar(ativar) {
    setOcupado(true);
    setErroSalvar(null);
    try {
      const novoId = exigir(await supabase.rpc("salvar_contrato", {
        p_id: idAtual, p_dados: campos, p_locatarios: locatarios.map((p) => p.id), p_fiadores: fiadores.map((p) => p.id),
      }));
      if (ativar) {
        const numero = exigir(await supabase.rpc("ativar_contrato", { p_id: novoId }));
        avisar(`Contrato nº ${numero} ativado.`);
      } else {
        avisar(ativo ? "Contrato salvo." : "Rascunho salvo.");
      }
      if (!idAtual) {
        setIdAtual(novoId);
        history.replaceState(null, "", `#contratos/${novoId}`);
      }
      recarregar();
    } catch (e) {
      setErroSalvar(mensagemDeErro(e));
    } finally {
      setOcupado(false);
    }
  }

  async function excluir() {
    if (!window.confirm("Excluir este rascunho? Não dá para desfazer.")) return;
    try {
      exigir(await supabase.rpc("excluir_rascunho_contrato", { p_id: idAtual }));
      avisar("Rascunho excluído.");
      voltar();
    } catch (e) {
      setErroSalvar(mensagemDeErro(e));
    }
  }

  async function escolheuPessoa(pessoaId) {
    const p = exigir(await supabase.from("pessoas").select("id, nome, documento, cadastro_completo").eq("id", pessoaId).maybeSingle());
    if (escolhendo === "locatario") setLocatarios((l) => (l.some((x) => x.id === p.id) ? l : [...l, p]));
    else setFiadores((l) => (l.some((x) => x.id === p.id) ? l : [...l, p]));
    setEscolhendo(null);
  }

  if (erro) return <section className="vista"><button type="button" className="voltar" onClick={voltar}>← Contratos</button><Erro mensagem={erro} /></section>;
  if (!campos) return <section className="vista"><Carregando /></section>;
  const c = dados.contrato;
  const [nomeSit, corSit] = SITUACOES[c?.situacao ?? "rascunho"];
  const i = imovelEscolhido?.imoveis;

  const caixa = (campo, rotulo, { travaAtivo = false, ...props } = {}) => (
    <label className="campo">{rotulo}<input value={campos[campo]} onChange={mudar(campo)} disabled={fechado || (travaAtivo && travado)} {...props} /></label>
  );
  const marca = (campo, rotulo, travaAtivo = false) => (
    <label className="linha-marcar"><input type="checkbox" checked={campos[campo]} onChange={mudar(campo)} disabled={fechado || (travaAtivo && travado)} /> {rotulo}</label>
  );

  return (
    <section className="vista vista-larga" aria-labelledby="t-contrato">
      <button type="button" className="voltar" onClick={voltar}>← Contratos</button>
      <div className="cabeca-vista">
        <div>
          <h2 id="t-contrato">{c?.numero ? `Contrato nº ${c.numero}` : idAtual ? "Rascunho de contrato" : "Novo contrato"}</h2>
          <p><span className={`etiqueta ${corSit}`}>{nomeSit}</span>{c?.ativado_em ? ` · ativado em ${dataHora(c.ativado_em)}` : ""}{c?.termino ? ` · termina em ${dataCurta(c.termino)} · próximo reajuste ${dataCurta(c.proximo_reajuste)}` : ""}</p>
        </div>
        {c?.situacao === "rascunho" && <button type="button" className="botao secundario pequeno" onClick={excluir}>Excluir rascunho</button>}
      </div>
      {ativo && <p className="aviso-locacao">Contrato ativo: imóvel, início, prazo, dias e valores ficam travados. Eles mudam por reajuste, aditamento ou rescisão (próximas etapas).</p>}

      <form className="ficha-locacao" onSubmit={(e) => e.preventDefault()}>
        <nav className="ficha-locacao-menu" aria-label="Partes do contrato">
          {SECOES.map(([alvo, nome]) => (
            <a key={alvo} href={`#${alvo}`} onClick={(e) => { e.preventDefault(); document.getElementById(alvo)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>{nome}</a>
          ))}
        </nav>
        <div className="ficha-locacao-corpo">
          <fieldset className="painel formulario" id="c-imovel">
            <legend>Imóvel</legend>
            {i ? (
              <div className="resumo-escolha">
                <div>
                  <b>{i.referencia} · {nomeTipo(i.tipo)}</b>
                  <span className="mudo pequeno">{[[i.endereco, i.numero].filter(Boolean).join(", "), i.bairro].filter(Boolean).join(" · ")}{i.valor_locacao ? ` · anunciado por ${reais(i.valor_locacao)}` : ""}</span>
                  <span className="pequeno">Locadores: {(imovelEscolhido.imovel_locadores ?? []).map((l) => `${l.pessoas?.nome} (${percentual(l.percentual)})`).join(", ") || "nenhum"}
                    {somaLocadores !== 100 && <span className="etiqueta alerta" style={{ marginLeft: 6 }}>{imovelEscolhido.imovel_locadores?.length ? `soma ${percentual(somaLocadores)}` : "sem locador"}</span>}</span>
                </div>
                <div className="atalhos">
                  <button type="button" className="botao secundario pequeno" onClick={() => ir("administrados", campos.imovel_codigo)}>Abrir imóvel</button>
                  {!travado && <button type="button" className="botao secundario pequeno" onClick={() => setEscolhendo("imovel")}>Trocar</button>}
                </div>
              </div>
            ) : (
              <button type="button" className="botao secundario" onClick={() => setEscolhendo("imovel")} disabled={travado}>Informar imóvel</button>
            )}
            <label className="campo" style={{ maxWidth: 320 }}>Regime de tributação (IBS/CBS)
              <select value={campos.regime_tributario} onChange={mudar("regime_tributario")} disabled={fechado}><option value="nao_informado">Não informado</option><option value="pf">Locador pessoa física</option><option value="pj">Locador pessoa jurídica</option></select>
            </label>
          </fieldset>

          <fieldset className="painel formulario" id="c-locatarios">
            <legend>Locatários</legend>
            <ListaDePartes pessoas={locatarios} aoTirar={(id) => setLocatarios((l) => l.filter((x) => x.id !== id))} ir={ir} bloqueado={fechado} />
            {!fechado && <button type="button" className="botao secundario" onClick={() => setEscolhendo("locatario")} style={{ alignSelf: "flex-start" }}>+ Informar locatário</button>}
            <div className="grade-3">
              <label className="campo">Preferência de pagamento
                <select value={campos.preferencia_pagamento} onChange={mudar("preferencia_pagamento")} disabled={fechado}><option value="indiferente">Indiferente</option><option value="boleto">Boleto</option><option value="boleto_email">Boleto por e-mail</option><option value="recibo">Recibo</option><option value="pix">PIX</option><option value="deposito">Depósito ou transferência</option></select>
              </label>
              {caixa("desconto_pontualidade", "Desconto de pontualidade (%)", { type: "number", min: 0, max: 100, step: "0.01" })}
            </div>
            <p className="mudo pequeno" style={{ margin: 0 }}>O desconto vale para pagamentos até o vencimento.</p>
          </fieldset>

          <fieldset className="painel formulario" id="c-dados">
            <legend>Dados do contrato</legend>
            <div className="grade-3">
              <label className="campo">Finalidade
                <select value={campos.finalidade} onChange={mudar("finalidade")} disabled={fechado}><option value="residencial">Residencial</option><option value="comercial">Comercial</option><option value="industrial">Industrial</option><option value="temporada">Temporada</option><option value="rural">Rural</option></select>
              </label>
              {caixa("valor_inicial", "Valor inicial do aluguel (R$)", { type: "number", min: 0, step: "0.01", travaAtivo: true, placeholder: i?.valor_locacao ? String(i.valor_locacao) : "" })}
              <label className="campo">Índice de reajuste
                <select value={campos.indice} onChange={mudar("indice")} disabled={fechado}>{["IGP-M", "IPCA", "INPC", "IVAR", "IGP-DI"].map((x) => <option key={x} value={x}>{x}</option>)}<option value="FIXO">Percentual fixo</option></select>
              </label>
              {campos.indice === "FIXO" && caixa("indice_fixo", "Reajuste fixo (%)", { type: "number", min: 0, step: "0.01" })}
              {caixa("controle", "Controle (referência interna)")}
              {!c?.numero && caixa("titulo_rascunho", "Título do rascunho")}
            </div>
            {marca("garantia_aluguel", "Garantia de aluguel: a imobiliária repassa ao locador mesmo sem o locatário pagar")}
            {campos.garantia_aluguel && <div style={{ maxWidth: 260 }}>{caixa("garantia_aluguel_meses", "Limite de repasses garantidos (meses)", { type: "number", min: 0 })}</div>}
          </fieldset>

          <fieldset className="painel formulario" id="c-periodos">
            <legend>Períodos</legend>
            <div className="grade-3">
              {caixa("inicio", "Início do contrato", { type: "date", travaAtivo: true })}
              {caixa("prazo_meses", "Prazo (meses)", { type: "number", min: 1, max: 600, travaAtivo: true })}
              {caixa("reajuste_meses", "Reajuste a cada (meses)", { type: "number", min: 1, max: 120, travaAtivo: true })}
              {caixa("dia_inicio_periodo", "Dia do início do período", { type: "number", min: 1, max: 31, travaAtivo: true, placeholder: campos.inicio ? String(Number(campos.inicio.slice(8))) : "" })}
              <label className="campo">Dia da cobrança do locatário
                <span className="campo-par">
                  <input type="number" min={1} max={31} value={campos.dia_cobranca} onChange={mudar("dia_cobranca")} disabled={travado} />
                  <select value={campos.cobranca_referencia} onChange={mudar("cobranca_referencia")} disabled={travado}><option value="apos_periodo">Após o período</option><option value="no_periodo">No período</option></select>
                </span>
              </label>
              <label className="campo">Dia do repasse ao locador
                <span className="campo-par">
                  <input type="number" min={1} max={31} value={campos.dia_repasse} onChange={mudar("dia_repasse")} disabled={travado} />
                  <select value={campos.repasse_referencia} onChange={mudar("repasse_referencia")} disabled={travado}><option value="apos_periodo">Após o período</option><option value="no_periodo">No período</option></select>
                </span>
              </label>
            </div>
            <p className="mudo pequeno" style={{ margin: 0 }}>Dia do início do período: ex. 25 = de 25/01 a 24/02. "Após o período" vence no dia escolhido depois que o período termina; "No período", dentro dele.</p>
          </fieldset>

          <fieldset className="painel formulario" id="c-taxa">
            <legend>Taxa administrativa</legend>
            <div className="grade-3">
              {caixa("taxa_administracao", campos.taxa_base === "valor_fixo" ? "Taxa de administração (R$)" : "Taxa de administração (%)", { type: "number", min: 0, step: "0.01" })}
              <label className="campo">Calculada sobre
                <select value={campos.taxa_base} onChange={mudar("taxa_base")} disabled={fechado}><option value="percentual_aluguel">% do aluguel</option><option value="percentual_cobranca">% do total cobrado</option><option value="valor_fixo">Valor fixo</option></select>
              </label>
              {caixa("taxa_intermediacao", "Taxa de intermediação (% do 1º aluguel)", { type: "number", min: 0, step: "0.01" })}
            </div>
            {marca("taxa_proporcional", "Cobrar valor proporcional nos períodos quebrados (primeiro e último)", true)}
          </fieldset>

          <fieldset className="painel formulario" id="c-atraso">
            <legend>Multa e juros de mora</legend>
            <div className="grade-3">
              {caixa("multa_percentual", "Multa por atraso (%)", { type: "number", min: 0, step: "0.01" })}
              <label className="campo">Forma da multa
                <select value={campos.multa_forma} onChange={mudar("multa_forma")} disabled={fechado}><option value="integral">Integral após o vencimento</option><option value="diaria_30">Diária até 30 dias após o vencimento</option></select>
              </label>
              <label className="campo">Multa sobre
                <select value={campos.multa_base} onChange={mudar("multa_base")} disabled={fechado}><option value="total">Valor total da cobrança</option><option value="aluguel">Só o aluguel</option></select>
              </label>
              {caixa("multa_a_partir_dia", "Multa a partir do dia (após o vencimento)", { type: "number", min: 0 })}
              {caixa("juros_percentual", "Juros de mora (%)", { type: "number", min: 0, step: "0.001" })}
              <label className="campo">Juros
                <select value={campos.juros_periodo} onChange={mudar("juros_periodo")} disabled={fechado}><option value="dia">Ao dia</option><option value="mes">Ao mês</option></select>
              </label>
              {caixa("juros_a_partir_dia", "Juros a partir do dia (após o vencimento)", { type: "number", min: 0 })}
            </div>
            {marca("multa_pj_omitir", "Locatário pessoa jurídica: omitir a mensagem de multa no boleto e incluir \"Não receber após o vencimento\"")}
          </fieldset>

          <fieldset className="painel formulario" id="c-irrf">
            <legend>Imposto de renda (IRRF)</legend>
            <p className="mudo pequeno" style={{ margin: 0 }}>Retenção quando o locatário é pessoa jurídica e o locador é pessoa física.</p>
            {[["percentual", "1. Calcular de acordo com o percentual de recebimento de cada locador"], ["dividir", "2. Calcular dividindo pelo número de locadores (só quando todos forem pessoa física)"], ["nao_calcular", "3. Não calcular IRRF"]].map(([v, n]) => (
              <label key={v} className="linha-marcar"><input type="radio" name="irrf" checked={campos.irrf_modo === v} onChange={() => setCampos((x) => ({ ...x, irrf_modo: v }))} disabled={fechado} /> {n}</label>
            ))}
          </fieldset>

          <fieldset className="painel formulario" id="c-garantia">
            <legend>Garantia do contrato</legend>
            <div className="participantes-opcoes">
              {GARANTIAS_DO_CONTRATO.map(([v, n]) => (
                <label key={v} className={`participante-opcao${campos.garantia_tipo === v ? " marcado" : ""}`}>
                  <input type="radio" name="garantia" checked={campos.garantia_tipo === v} onChange={() => setCampos((x) => ({ ...x, garantia_tipo: v }))} disabled={fechado} /> {n}
                </label>
              ))}
            </div>
            {["caucao", "carta_fianca", "titulo_capitalizacao", "deposito"].includes(campos.garantia_tipo) && (
              <div className="grade-3">
                <label className="campo">Valor (R$)<input type="number" min={0} step="0.01" value={campos.garantia_dados.valor ?? ""} onChange={(e) => setCampos((x) => ({ ...x, garantia_dados: { ...x.garantia_dados, valor: e.target.value } }))} disabled={fechado} /></label>
                <label className="campo">Bem<input value={campos.garantia_dados.bem ?? ""} onChange={(e) => setCampos((x) => ({ ...x, garantia_dados: { ...x.garantia_dados, bem: e.target.value } }))} disabled={fechado} /></label>
                <label className="campo">Descrição<input value={campos.garantia_dados.descricao ?? ""} onChange={(e) => setCampos((x) => ({ ...x, garantia_dados: { ...x.garantia_dados, descricao: e.target.value } }))} disabled={fechado} /></label>
              </div>
            )}
            {campos.garantia_tipo.startsWith("seguro_fianca") && (
              <div className="grade-3">
                {[["seguradora", "Seguradora"], ["apolice", "Apólice"], ["vigencia_ate", "Vigência até"], ...(campos.garantia_tipo === "seguro_fianca_parcelado" ? [["parcelas", "Nº de parcelas"], ["valor_parcela", "Valor da parcela (R$)"]] : [["valor", "Valor (R$)"]])].map(([k, n]) => (
                  <label key={k} className="campo">{n}<input type={k === "vigencia_ate" ? "date" : ["parcelas", "valor_parcela", "valor"].includes(k) ? "number" : "text"} value={campos.garantia_dados[k] ?? ""} onChange={(e) => setCampos((x) => ({ ...x, garantia_dados: { ...x.garantia_dados, [k]: e.target.value } }))} disabled={fechado} /></label>
                ))}
              </div>
            )}
            {campos.garantia_tipo === "fiador" && (
              <>
                <ListaDePartes pessoas={fiadores} aoTirar={(id) => setFiadores((l) => l.filter((x) => x.id !== id))} ir={ir} bloqueado={fechado} />
                {!fechado && <button type="button" className="botao secundario" onClick={() => setEscolhendo("fiador")} style={{ alignSelf: "flex-start" }}>+ Informar fiador</button>}
              </>
            )}
          </fieldset>

          <fieldset className="painel formulario" id="c-adicionais">
            <legend>Adicionais</legend>
            <div className="grade-3">
              <label className="campo">Supervisor
                <select value={campos.supervisor_id} onChange={mudar("supervisor_id")} disabled={fechado}><option value="">—</option>{dados.supervisores.map((s) => <option key={s.id} value={s.id}>{s.nome}</option>)}</select>
              </label>
              {caixa("comissao_supervisor", "Comissão do supervisor (%)", { type: "number", min: 0, step: "0.01" })}
              <label className="campo">Captação (unidade)
                <select value={campos.unidade_id} onChange={mudar("unidade_id")} disabled={fechado}><option value="">—</option>{dados.unidades.filter((u) => u.ativa || u.id === campos.unidade_id).map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}</select>
              </label>
              {caixa("multa_rescisoria_alugueis", "Multa rescisória (nº de aluguéis)", { type: "number", min: 0, step: "0.5" })}
            </div>
            {marca("clausula_pintura", "Cláusula pintura: devolver o imóvel pintado")}
            {marca("clausula_meses", "Cláusula meses: permanência mínima com multa proporcional")}
            {marca("liberado_lancamentos", "Liberar o contrato para lançamentos, IPTU e cobranças")}
            {marca("fora_do_lote", "Não colocar na cobrança em lote")}
            {marca("contrato_parcial", "Contrato parcial (só parte do imóvel ou dos locadores)")}
            <label className="campo">Observações<textarea rows={3} value={campos.observacoes} onChange={mudar("observacoes")} disabled={fechado} /></label>
          </fieldset>

          <fieldset className="painel formulario" id="c-movimentacao">
            <legend>Início da movimentação <small className="mudo">(contrato que já está em andamento)</small></legend>
            <p className="mudo pequeno" style={{ margin: 0 }}>Para contratos que vêm do Unilocweb: não gera cobrança nem repasse antes da data informada.</p>
            <div className="grade-3">
              {caixa("movimentacao_desde", "Iniciar a movimentação a partir de", { type: "date", travaAtivo: true })}
              {caixa("ultimo_reajuste_em", "Último reajuste em", { type: "date", travaAtivo: true })}
              {caixa("valor_vigente", "Valor do aluguel vigente (R$)", { type: "number", min: 0, step: "0.01", travaAtivo: true })}
              {caixa("meses_para_reajuste", "Meses até o próximo reajuste", { type: "number", min: 0, travaAtivo: true })}
            </div>
            {marca("movimentacao_proporcional", "Calcular período proporcional no primeiro período", true)}
          </fieldset>

          <div className="painel" id="c-demonstrativo">
            <h3 style={{ marginTop: 0 }}>Demonstrativo dos períodos</h3>
            <Demonstrativo simulacao={simulacao} />
          </div>

          <Erro mensagem={erroSalvar} />
          {!fechado && (
            <div className="barra-salvar">
              <span className="mudo pequeno">{c ? `Atualizado em ${dataHora(c.atualizado_em)}` : "Ainda não salvo"}</span>
              <div className="atalhos">
                <button type="button" className="botao secundario" disabled={ocupado} onClick={() => salvar(false)}>{ativo ? "Salvar alterações" : "Salvar como rascunho"}</button>
                {!ativo && <button type="button" className="botao" disabled={ocupado} onClick={() => salvar(true)}>Salvar e ativar contrato</button>}
              </div>
            </div>
          )}
        </div>
      </form>

      {(escolhendo === "locatario" || escolhendo === "fiador") && (
        <EscolherPessoa titulo={escolhendo === "locatario" ? "Informar locatário" : "Informar fiador"} papel={escolhendo} aoFechar={() => setEscolhendo(null)}
          aoEscolher={(pid) => escolheuPessoa(pid).catch((e) => { setErroSalvar(mensagemDeErro(e)); setEscolhendo(null); })} />
      )}
      {escolhendo === "imovel" && (
        <EscolherImovelAdministrado imoveis={dados.imoveis} aoFechar={() => setEscolhendo(null)} aoEscolher={(codigo) => {
          const escolhido = dados.imoveis.find((x) => x.imovel_codigo === codigo);
          setCampos((x) => ({ ...x, imovel_codigo: codigo, valor_inicial: x.valor_inicial || String(escolhido?.imoveis?.valor_locacao ?? "") }));
          setEscolhendo(null);
        }} ir={ir} />
      )}
    </section>
  );
}

function ListaDePartes({ pessoas, aoTirar, ir, bloqueado }) {
  if (!pessoas.length) return <p className="mudo" style={{ margin: 0 }}>Ninguém informado ainda.</p>;
  return (
    <ul className="lista">
      {pessoas.map((p) => (
        <li key={p.id} className="linha-parte">
          <span>
            <button type="button" className="link-botao" onClick={() => ir("pessoas", p.id)}>{p.nome}</button>
            <span className="mudo pequeno dado"> {formatarDocumento(p.documento)}{p.cadastro_completo ? "" : " · cadastro incompleto"}</span>
          </span>
          {!bloqueado && <button type="button" className="botao secundario pequeno" onClick={() => aoTirar(p.id)}>Tirar</button>}
        </li>
      ))}
    </ul>
  );
}

function EscolherImovelAdministrado({ imoveis, aoFechar, aoEscolher, ir }) {
  const [busca, setBusca] = useState("");
  const termo = semAcento(busca.trim());
  const achados = imoveis.filter((x) => !termo || semAcento(`${x.imoveis?.referencia} ${x.imoveis?.endereco} ${x.imoveis?.bairro}`).includes(termo)).slice(0, 40);
  return (
    <Janela titulo="Informar imóvel" aoFechar={aoFechar}>
      <div className="formulario">
        <p className="mudo pequeno" style={{ margin: 0 }}>Aparecem os imóveis de Imóveis administrados. Um imóvel novo entra lá primeiro, com os locadores.</p>
        <input className="busca" autoFocus type="search" placeholder="Referência, rua ou bairro" value={busca} onChange={(e) => setBusca(e.target.value)} />
        <ul className="lista escolher-pessoa">
          {achados.length === 0 && <li className="mudo pequeno">Nenhum imóvel administrado com essa busca.</li>}
          {achados.map((x) => (
            <li key={x.imovel_codigo}>
              <button type="button" onClick={() => aoEscolher(x.imovel_codigo)}>
                <b>{x.imoveis?.referencia}</b>
                <span className="mudo pequeno">{[nomeTipo(x.imoveis?.tipo), [x.imoveis?.endereco, x.imoveis?.numero].filter(Boolean).join(", "), x.imoveis?.bairro].filter(Boolean).join(" · ")}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="atalhos" style={{ justifyContent: "space-between" }}>
          <button type="button" className="botao secundario" onClick={() => ir("administrados")}>Ir para Imóveis administrados</button>
          <button type="button" className="botao secundario" onClick={aoFechar}>Cancelar</button>
        </div>
      </div>
    </Janela>
  );
}

const NOMES_DOS_CAMPOS = { inicio: "Início do contrato", prazo_meses: "Prazo", reajuste_meses: "Reajuste", dia_inicio_periodo: "Dia do início do período", dia_cobranca: "Dia da cobrança", dia_repasse: "Dia do repasse", valor_inicial: "Valor inicial" };

function Demonstrativo({ simulacao }) {
  if (!simulacao) return <Carregando />;
  if (simulacao.faltam) {
    return <p className="aviso-locacao">Para simular, preencha: {simulacao.faltam.map((k) => NOMES_DOS_CAMPOS[k]).join(", ")}.</p>;
  }
  if (simulacao.erro) return <Erro mensagem={simulacao.erro} />;
  const total = simulacao.periodos.filter((p) => !p.anterior_a_movimentacao).reduce((s, p) => s + Number(p.valor), 0);
  return (
    <div className="tabela-caixa demonstrativo">
      <table>
        <thead><tr><th>Nº</th><th>Período</th><th>Vencimento da cobrança</th><th>Repasse</th><th>Aluguel</th></tr></thead>
        <tbody>
          {simulacao.periodos.map((p) => (
            <tr key={p.numero} className={p.anterior_a_movimentacao ? "anterior" : ""}>
              <td className="dado">{p.numero}</td>
              <td className="dado">{dataCurta(p.inicio)} a {dataCurta(p.fim)}{p.reajuste && <span className="etiqueta alerta" style={{ marginLeft: 6 }}>reajuste</span>}</td>
              <td className="dado">{dataCurta(p.vencimento)}</td>
              <td className="dado">{dataCurta(p.repasse)}</td>
              <td className="dado">{reais(p.valor)}{p.proporcional && <span className="sub">proporcional</span>}{p.anterior_a_movimentacao && <span className="sub">antes da movimentação</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mudo pequeno" style={{ margin: "8px 2px 0" }}>{simulacao.periodos.length} períodos · total previsto sem reajustes: {reais(total)}. Os valores depois de cada reajuste dependem do índice do mês.</p>
    </div>
  );
}
