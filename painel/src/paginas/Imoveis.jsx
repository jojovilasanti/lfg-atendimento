import { useState } from "react";
import { BotaoFechar, Carregando, Erro, haQuanto, nomeTipo, useCarregar, useEhCelular } from "../comum.jsx";
import {
  areaDoImovel, avaliarImovel, baixarPlanilha, ehMinhaCaptacao, metros, miniDaFoto, NOME_DA_SITUACAO, precoDoImovel, resumoDoImovel, semAcento, SITUACOES, textoParaWhatsapp,
} from "../imoveis.js";
import { useSessao } from "../sessao.jsx";
import { exigir, mensagemDeErro, supabase } from "../supabase.js";
import CadastroImovel from "./CadastroImovel.jsx";
import CliquesWhatsapp from "./CliquesWhatsapp.jsx";
import FichaImovel from "./FichaImovel.jsx";
import { BotaoCompartilhar } from "../compartilhar.jsx";

const COLUNAS =
  "codigo, referencia, tipo, origem, situacao, venda, locacao, valor_venda, valor_locacao, valor_condominio, valor_iptu, dormitorios, suites, banheiros, vagas, area_construida, area_util, area_terreno, endereco, numero, bairro, cidade, cep, titulo, descricao, link_site, foto_principal, foto_mini, fotos, captador, atualizado_univen";
const POR_PAGINA = 50;
const FILTROS_VAZIOS = { operacao: "", tipo: "", valor: "", local: "", quartos: "", vagas: "", captador: "" };

// Gestor e corretor cadastram; o corretor edita só o que captou (regra do banco).
export default function Imoveis({ imovelAberto, acao, ir }) {
  const voltar = () => ir("imoveis");
  const abrir = (caminho) => ir("imoveis", caminho);
  if (imovelAberto === "cliques") return <CliquesWhatsapp voltar={voltar} />;
  if (imovelAberto === "novo") return <CadastroImovel key="novo" voltar={voltar} aoApagar={voltar} abrir={abrir} />;
  if (imovelAberto && acao === "editar") return <CadastroImovel key={imovelAberto} codigoInicial={imovelAberto} voltar={() => abrir(imovelAberto)} aoApagar={voltar} abrir={abrir} />;
  if (imovelAberto) return <FichaImovel codigo={imovelAberto} voltar={voltar} abrir={abrir} />;
  return <ListaDeImoveis abrir={abrir} />;
}

export function NotaDeQualidade({ imovel }) {
  const { nota, rotulo, cor, pendencias } = avaliarImovel(imovel);
  return (
    <span className={`qualidade ${cor}`} title={pendencias.join(". ") || "Anúncio completo"}>
      <b>{rotulo}</b>
      <span className="faixa-qualidade"><i style={{ width: `${nota}%` }} /></span>
    </span>
  );
}

function valorParaFiltro(imovel, operacao) {
  if (operacao === "locacao") return Number(imovel.valor_locacao) || 0;
  if (operacao === "venda") return Number(imovel.valor_venda) || 0;
  return Number(imovel.valor_venda) || Number(imovel.valor_locacao) || 0;
}

function ListaDeImoveis({ abrir }) {
  const { eu } = useSessao();
  const celular = useEhCelular();
  const [filtros, setFiltros] = useState(FILTROS_VAZIOS);
  const [maisFiltros, setMaisFiltros] = useState(false);
  const [escopo, setEscopo] = useState("tudo");
  const [situacao, setSituacao] = useState("disponivel");
  const [ordem, setOrdem] = useState("recentes");
  const [visao, setVisao] = useState("tabela");
  const [limite, setLimite] = useState(POR_PAGINA);
  const [selecionados, setSelecionados] = useState(() => new Set());
  const [aviso, setAviso] = useState(null);
  // No celular os filtros ficam recolhidos: à vista só a busca por local ou referência.
  const [filtrosAbertos, setFiltrosAbertos] = useState(false);
  const mudar = (campo) => (e) => {
    setFiltros({ ...filtros, [campo]: e.target.value });
    setLimite(POR_PAGINA);
  };

  const { dados, erro } = useCarregar(async () => {
    const imoveis = exigir(await supabase.from("imoveis").select(COLUNAS).limit(5000));
    const leitura = exigir(await supabase.from("sincronizacoes").select("iniciada_em").eq("sucesso", true).order("iniciada_em", { ascending: false }).limit(1));
    return { imoveis, leitura: leitura[0] };
  }, []);

  const todos = dados?.imoveis ?? [];
  const termo = semAcento(filtros.local);
  const valorMaximo = Number(filtros.valor.replace(/\D/g, "")) || 0;
  const passaNosFiltros = (i) =>
    (!filtros.operacao || i[filtros.operacao]) &&
    (!filtros.tipo || i.tipo === filtros.tipo) &&
    (!termo || semAcento(`${i.referencia} ${i.bairro} ${i.cidade} ${i.endereco} ${i.titulo}`).includes(termo)) &&
    (!valorMaximo || (valorParaFiltro(i, filtros.operacao) > 0 && valorParaFiltro(i, filtros.operacao) <= valorMaximo)) &&
    (!filtros.quartos || (i.dormitorios ?? 0) >= Number(filtros.quartos)) &&
    (!filtros.vagas || (i.vagas ?? 0) >= Number(filtros.vagas)) &&
    (!filtros.captador || i.captador === filtros.captador);
  const naSituacao = todos.filter((i) => situacao === "todas" || i.situacao === situacao).filter(passaNosFiltros);
  const minhas = naSituacao.filter((i) => ehMinhaCaptacao(i, eu));
  const encontrados = [...(escopo === "minhas" ? minhas : naSituacao)].sort((a, b) => {
    if (ordem === "menor") return valorParaFiltro(a, filtros.operacao) - valorParaFiltro(b, filtros.operacao);
    if (ordem === "maior") return valorParaFiltro(b, filtros.operacao) - valorParaFiltro(a, filtros.operacao);
    if (ordem === "qualidade") return avaliarImovel(a).nota - avaliarImovel(b).nota;
    return String(b.atualizado_univen ?? "").localeCompare(String(a.atualizado_univen ?? "")) || String(b.codigo).localeCompare(String(a.codigo));
  });
  const visiveis = encontrados.slice(0, limite);
  const tipos = [...new Set(todos.map((i) => i.tipo).filter(Boolean))].sort();
  const captadores = [...new Set(todos.map((i) => i.captador).filter(Boolean))].sort();

  const escolhidos = todos.filter((i) => selecionados.has(i.codigo));
  const todosMarcados = visiveis.length > 0 && visiveis.every((i) => selecionados.has(i.codigo));
  const marcar = (codigo, marcado) => {
    const novos = new Set(selecionados);
    if (marcado) novos.add(codigo);
    else novos.delete(codigo);
    setSelecionados(novos);
  };
  const marcarTodos = (marcado) => {
    const novos = new Set(selecionados);
    for (const i of visiveis) {
      if (marcado) novos.add(i.codigo);
      else novos.delete(i.codigo);
    }
    setSelecionados(novos);
  };
  async function copiarParaWhatsapp() {
    try {
      await navigator.clipboard.writeText(escolhidos.map(textoParaWhatsapp).join("\n\n"));
      setAviso("Texto copiado. É só colar na conversa.");
    } catch (e) {
      setAviso(`Não foi possível copiar: ${mensagemDeErro(e)}`);
    }
  }

  const emTabela = visao === "tabela" && !celular;
  const filtrosAtivos = ["operacao", "tipo", "valor", "quartos", "vagas", "captador"].filter((c) => filtros[c]).length
    + (situacao !== "disponivel" ? 1 : 0) + (ordem !== "recentes" ? 1 : 0);
  const recolhido = celular && !filtrosAbertos;
  const campoLocal = <label className="campo">Localização ou referência<input id="filtro-local" type="search" placeholder="Rita Vieira, CA00742..." value={filtros.local} onChange={mudar("local")} /></label>;
  return (
    <section className="vista larga" aria-labelledby="t-imoveis">
      <div className="cabeca-vista">
        <div>
          <h2 id="t-imoveis">Imóveis</h2>
          <p>
            O estoque da imobiliária. Só o que está Disponível vai para a Thais e para o site.
            {dados?.leitura && <span className="mudo"> Univen lido {haQuanto(dados.leitura.iniciada_em)}.</span>}
          </p>
        </div>
        <div className="acoes-cabeca">
          <button type="button" className="botao acao-principal" onClick={() => abrir("novo")}>Novo imóvel</button>
        </div>
      </div>

      <div className="painel filtros-lista-imoveis">
        {recolhido ? (
          <div className="busca-recolhida">
            {campoLocal}
            <button type="button" className="botao secundario" aria-expanded={false} onClick={() => setFiltrosAbertos(true)}>
              Filtros{filtrosAtivos ? ` (${filtrosAtivos})` : ""}
            </button>
          </div>
        ) : (
        <>
        {celular && (
          <div className="cabeca-filtros">
            <b>Filtros</b>
            <BotaoFechar aoFechar={() => setFiltrosAbertos(false)} rotulo="Fechar filtros" />
          </div>
        )}
        <div className="grade-filtros-imoveis">
          <label className="campo">Operação
            <select id="filtro-operacao" value={filtros.operacao} onChange={mudar("operacao")}>
              <option value="">Todas</option>
              <option value="venda">À venda</option>
              <option value="locacao">Para alugar</option>
            </select>
          </label>
          <label className="campo">Tipo
            <select id="filtro-tipo" value={filtros.tipo} onChange={mudar("tipo")}>
              <option value="">Todos</option>
              {tipos.map((t) => <option key={t} value={t}>{nomeTipo(t)}</option>)}
            </select>
          </label>
          <label className="campo">Valor até<input id="filtro-valor" inputMode="numeric" placeholder="500000" value={filtros.valor} onChange={mudar("valor")} /></label>
          {campoLocal}
          <button type="button" className="botao secundario" aria-expanded={maisFiltros} onClick={() => setMaisFiltros(!maisFiltros)}>Mais filtros</button>
        </div>
        {maisFiltros && (
          <div className="grade-filtros-imoveis mais">
            <label className="campo">Quartos
              <select id="filtro-quartos" value={filtros.quartos} onChange={mudar("quartos")}>
                <option value="">Qualquer</option>
                {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n} ou mais</option>)}
              </select>
            </label>
            <label className="campo">Vagas
              <select id="filtro-vagas" value={filtros.vagas} onChange={mudar("vagas")}>
                <option value="">Qualquer</option>
                {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n} ou mais</option>)}
              </select>
            </label>
            <label className="campo">Captador
              <select id="filtro-captador" value={filtros.captador} onChange={mudar("captador")}>
                <option value="">Todos</option>
                {captadores.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
          </div>
        )}
        {celular && (
          <div className="grade-filtros-imoveis mais">
            <label className="campo">Situação
              <select id="filtro-situacao" value={situacao} onChange={(e) => setSituacao(e.target.value)}>
                {SITUACOES.map(([id, nome]) => <option key={id} value={id}>{nome}</option>)}
                <option value="todas">Todas as situações</option>
              </select>
            </label>
            <label className="campo">Ordenar por
              <select id="filtro-ordem" value={ordem} onChange={(e) => setOrdem(e.target.value)}>
                <option value="recentes">Mais recentes</option>
                <option value="menor">Menor valor</option>
                <option value="maior">Maior valor</option>
                <option value="qualidade">Anúncios a melhorar</option>
              </select>
            </label>
            <button type="button" className="botao secundario" onClick={() => setFiltrosAbertos(false)}>Fechar filtros</button>
          </div>
        )}
        </>
        )}
      </div>

      <div className="filtros">
        <div className="chips">
          <button type="button" className="filtro" aria-pressed={escopo === "tudo"} onClick={() => setEscopo("tudo")}>Tudo <b>{naSituacao.length}</b></button>
          <button type="button" className="filtro" aria-pressed={escopo === "minhas"} onClick={() => setEscopo("minhas")}>Minhas captações <b>{minhas.length}</b></button>
        </div>
        {!celular && (
          <>
            <select id="filtro-situacao" className="filtro-select" aria-label="Situação" value={situacao} onChange={(e) => setSituacao(e.target.value)}>
              {SITUACOES.map(([id, nome]) => <option key={id} value={id}>{nome}</option>)}
              <option value="todas">Todas as situações</option>
            </select>
            <select id="filtro-ordem" className="filtro-select" aria-label="Ordenar por" value={ordem} onChange={(e) => setOrdem(e.target.value)}>
              <option value="recentes">Mais recentes</option>
              <option value="menor">Menor valor</option>
              <option value="maior">Maior valor</option>
              <option value="qualidade">Anúncios a melhorar</option>
            </select>
          </>
        )}
        <div className="acoes-lista">
          {!celular && (
            <div className="tema" role="group" aria-label="Forma de ver a lista">
              <button type="button" aria-pressed={visao === "tabela"} onClick={() => setVisao("tabela")}>Tabela</button>
              <button type="button" aria-pressed={visao === "cartoes"} onClick={() => setVisao("cartoes")}>Cartões</button>
            </div>
          )}
          <button type="button" className="botao secundario pequeno" onClick={() => abrir("cliques")}>Cliques no WhatsApp</button>
          <button type="button" className="link-botao pequeno" disabled={!encontrados.length} onClick={() => baixarPlanilha(encontrados)}>Exportar lista ({encontrados.length})</button>
        </div>
      </div>

      <Erro mensagem={erro} />
      {!dados ? <Carregando /> : encontrados.length === 0 ? (
        <div className="vazio"><div><b>Nenhum imóvel com esses filtros</b><p>Mude os filtros ou a situação, ou cadastre um imóvel novo.</p></div></div>
      ) : emTabela ? (
        <div className="tabela-caixa">
          <table className="tabela-imoveis">
            <thead>
              <tr>
                <th><input type="checkbox" aria-label="Marcar todos os imóveis visíveis" checked={todosMarcados} onChange={(e) => marcarTodos(e.target.checked)} /></th>
                <th>Foto</th><th>Referência</th><th>Endereço</th><th>Valor</th><th>Quartos</th><th>Área</th><th>Vagas</th><th>Captador</th><th>Anúncio</th>
              </tr>
            </thead>
            <tbody>
              {visiveis.map((i) => {
                const preco = precoDoImovel(i, filtros.operacao);
                return (
                  <tr key={i.codigo} className="clicavel" tabIndex={0} onClick={() => abrir(i.codigo)} onKeyDown={(e) => e.key === "Enter" && abrir(i.codigo)}>
                    <td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`Marcar ${i.referencia}`} checked={selecionados.has(i.codigo)} onChange={(e) => marcar(i.codigo, e.target.checked)} /></td>
                    <td>{i.foto_principal ? <img className="foto-tabela" src={i.foto_mini ?? miniDaFoto(i.foto_principal)} alt="" loading="lazy" decoding="async" /> : <span className="foto-tabela" />}</td>
                    <td className="dado">
                      {i.referencia}
                      {i.origem === "proprio" && <span className="sub">cadastro próprio</span>}
                      {i.situacao !== "disponivel" && <span className="sub">{NOME_DA_SITUACAO[i.situacao]}</span>}
                    </td>
                    <td className="c-endereco"><span className="forte">{[i.endereco, i.numero].filter(Boolean).join(", ") || i.bairro || "Sem endereço"}</span><span className="sub">{nomeTipo(i.tipo)} em {i.bairro ?? "—"}</span></td>
                    <td className="c-valor"><span className="sub">{preco.operacao}</span><span className="forte">{preco.valor}</span></td>
                    <td>{i.dormitorios ?? "—"}<span className="sub">{i.banheiros ? `${i.banheiros} banh.` : ""}</span></td>
                    <td className="c-numero">{areaDoImovel(i) ? metros(areaDoImovel(i)) : "—"}</td>
                    <td>{i.vagas ?? "—"}</td>
                    <td className="pequeno">{i.captador ?? "—"}</td>
                    <td><NotaDeQualidade imovel={i} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="cartoes-imoveis">
          {visiveis.map((i) => {
            const preco = precoDoImovel(i, filtros.operacao);
            return (
              <div key={i.codigo} className="cartao-com-marca com-acao">
                <label className="marca-cartao"><input type="checkbox" aria-label={`Marcar ${i.referencia}`} checked={selecionados.has(i.codigo)} onChange={(e) => marcar(i.codigo, e.target.checked)} /></label>
                <a className="cartao-imovel" href={`#imoveis/${i.codigo}`}>
                  {i.foto_principal ? <img src={i.foto_mini ?? miniDaFoto(i.foto_principal)} alt={`Foto do imóvel ${i.referencia}`} loading="lazy" decoding="async" /> : <span style={{ aspectRatio: "4 / 3", background: "var(--painel-2)" }} />}
                  <div>
                    <b>{i.referencia}{i.situacao !== "disponivel" ? ` · ${NOME_DA_SITUACAO[i.situacao]}` : ""}</b>
                    <strong>{preco.valor}</strong>
                    <span>{nomeTipo(i.tipo)} · {i.bairro}</span>
                    <span>{resumoDoImovel(i) || "—"}</span>
                    <NotaDeQualidade imovel={i} />
                  </div>
                </a>
                {i.ativo !== false && i.situacao === "disponivel" && <BotaoCompartilhar imovel={i} className="botao secundario" />}
              </div>
            );
          })}
        </div>
      )}
      {encontrados.length > limite && (
        <button type="button" className="botao secundario" style={{ alignSelf: "center" }} onClick={() => setLimite(limite + POR_PAGINA)}>
          Mostrar mais ({encontrados.length - limite})
        </button>
      )}

      {selecionados.size > 0 && (
        <div className="barra-selecao" role="region" aria-label="Imóveis marcados">
          <b>{selecionados.size} marcado{selecionados.size === 1 ? "" : "s"}</b>
          {aviso && <span className="pequeno mudo" role="status">{aviso}</span>}
          <div className="atalhos">
            <button type="button" className="botao pequeno" onClick={copiarParaWhatsapp}>Copiar para WhatsApp</button>
            <button type="button" className="botao secundario pequeno" onClick={() => baixarPlanilha(escolhidos)}>Exportar</button>
            <button type="button" className="botao secundario pequeno" onClick={() => { setSelecionados(new Set()); setAviso(null); }}>Limpar</button>
          </div>
        </div>
      )}
    </section>
  );
}
