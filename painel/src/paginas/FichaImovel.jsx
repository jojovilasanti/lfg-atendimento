import { Fragment, useState } from "react";
import { BotaoFechar, Carregando, Erro, nomeTipo, OPERACAO, reais, Situacao, telefone, useCarregar } from "../comum.jsx";
import { Janela, NOME_DA_ETAPA } from "../crm.jsx";
import { baixarZip, compartilhar, podeBaixarSemMarca, podeCompartilhar, prepararFotos } from "../fotosDoImovel.js";
import {
  avaliarImovel, cepFormatado, ehMinhaCaptacao, metros, miniDaFoto, NOME_DA_COMODIDADE, NOME_DA_MOBILIA, NOME_DA_OCUPACAO, NOME_DA_SITUACAO, textoParaWhatsapp,
} from "../imoveis.js";
import { useSessao } from "../sessao.jsx";
import { exigir, mensagemDeErro, supabase } from "../supabase.js";
import { NOME_DA_ORIGEM, quandoFoi } from "./CliquesWhatsapp.jsx";
import { NotaDeQualidade } from "./Imoveis.jsx";
import { VisitasDoImovel } from "./Agenda.jsx";
import { AjustesParaPortais } from "./Portais.jsx";
import { BotaoCompartilhar, NumerosDoCompartilhamento } from "../compartilhar.jsx";

function BaixarFotos({ imovel, aoFechar }) {
  const { empresa } = useSessao();
  const semMarcaPossivel = podeBaixarSemMarca(imovel);
  // Com a marca desligada nas Configurações gerais, as fotos próprias saem sempre sem marca.
  const marcaLigada = empresa.marca?.ativa !== false || !semMarcaPossivel;
  const [marcaDagua, setMarcaDagua] = useState(marcaLigada);
  const [progresso, setProgresso] = useState(null);
  const [arquivos, setArquivos] = useState(null);
  const [erro, setErro] = useState(null);
  const total = imovel.fotos?.length ?? 0;

  async function preparar() {
    setErro(null);
    try {
      setArquivos(await prepararFotos(imovel, { marcaDagua, empresa, aoProgredir: (n, de) => setProgresso(`Preparando ${n} de ${de}…`) }));
    } catch (e) {
      setErro(mensagemDeErro(e));
    } finally {
      setProgresso(null);
    }
  }

  async function enviar() {
    try {
      await compartilhar(imovel, arquivos);
    } catch (e) {
      if (e.name !== "AbortError") setErro(mensagemDeErro(e));
    }
  }

  return (
    <Janela titulo={`Baixar fotos · ${imovel.referencia}`} aoFechar={aoFechar} fecharBloqueado={!!progresso}>
      {!arquivos ? (
        <>
          <div className="opcoes-radio" role="radiogroup" aria-label="Marca d'água">
            <label className={marcaDagua ? "marcado" : ""}>
              <input type="radio" name="marca" checked={marcaDagua} disabled={!marcaLigada || !!progresso} onChange={() => setMarcaDagua(true)} />Com a marca d'água da {empresa.nome}
            </label>
            <label className={!marcaDagua ? "marcado" : ""}>
              <input type="radio" name="marca" checked={!marcaDagua} disabled={!semMarcaPossivel || !!progresso} onChange={() => setMarcaDagua(false)} />Sem marca d'água
            </label>
          </div>
          {!marcaLigada && (
            <p className="mudo pequeno" style={{ margin: 0 }}>A marca d'água está desligada em Configurações → Configurações gerais.</p>
          )}
          {!semMarcaPossivel && (
            <p className="mudo pequeno" style={{ margin: 0 }}>Este imóvel vem do Univen e as fotos já chegam com a marca de lá. Sem marca, baixe pelo Univen. Os imóveis cadastrados aqui têm as fotos originais.</p>
          )}
          <Erro mensagem={erro} />
          <div className="acoes-formulario">
            <button type="button" className="botao secundario" disabled={!!progresso} onClick={aoFechar}>Cancelar</button>
            <button type="button" className="botao" disabled={!!progresso || !total} onClick={preparar}>{progresso ?? `Preparar ${total} foto${total === 1 ? "" : "s"}`}</button>
          </div>
        </>
      ) : (
        <>
          <p style={{ margin: 0 }}>{arquivos.length} foto{arquivos.length === 1 ? "" : "s"} {marcaDagua ? "com" : "sem"} marca d'água, prontas.</p>
          <Erro mensagem={erro} />
          <div className="acoes-formulario">
            <button type="button" className="botao secundario" onClick={aoFechar}>Fechar</button>
            {podeCompartilhar(arquivos) && <button type="button" className="botao secundario" onClick={enviar}>Salvar no celular ou enviar</button>}
            <button type="button" className="botao" onClick={() => baixarZip(imovel, arquivos, marcaDagua)}>Baixar .zip</button>
          </div>
        </>
      )}
    </Janela>
  );
}

export default function FichaImovel({ codigo, voltar, abrir }) {
  const { eu, souGestor } = useSessao();
  const [copiado, setCopiado] = useState(false);
  const [baixando, setBaixando] = useState(false);
  const { dados, erro } = useCarregar(async () => {
    const imovel = exigir(await supabase.from("imoveis").select("*").eq("codigo", codigo).maybeSingle());
    if (!imovel) throw new Error("Imóvel não encontrado.");
    const interessados = exigir(await supabase.from("leads").select("id, nome, status, etapa, interesse").eq("imovel_codigo", codigo).not("whatsapp", "like", "sim-%").limit(30));
    // Só volta alguma coisa para o gestor e o captador (regra do banco).
    const vinculos = exigir(await supabase.from("imovel_proprietarios").select("proprietarios(id, nome, telefone, email, observacoes)").eq("imovel_codigo", codigo));
    // Cliques no WhatsApp dos últimos 30 dias (o corretor só vê os dos imóveis dele).
    const desde = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const cliques = exigir(await supabase.from("cliques_whatsapp").select("id, origem, nome, telefone, criado_em").eq("imovel_codigo", codigo).gte("criado_em", desde).order("criado_em", { ascending: false }).limit(100));
    return { imovel, interessados, cliques, proprietarios: vinculos.map((v) => v.proprietarios).filter(Boolean) };
  }, [codigo]);

  if (erro && !dados) return <section className="vista"><button type="button" className="voltar" onClick={voltar}>← Imóveis</button><Erro mensagem={erro} /></section>;
  if (!dados) return <Carregando />;

  const { imovel: i, interessados, cliques, proprietarios } = dados;
  const proprio = i.origem === "proprio";
  const podeEditar = proprio && (souGestor || ehMinhaCaptacao(i, eu));
  const { pendencias } = avaliarImovel(i);
  const comodidades = Object.entries(i.caracteristicas ?? {}).filter(([chave, valor]) => valor === "1" && NOME_DA_COMODIDADE[chave]).map(([chave]) => NOME_DA_COMODIDADE[chave]);
  const liquido = i.locacao && Number(i.valor_locacao) > 0 && Number(i.taxa_administracao) > 0
    ? Number(i.valor_locacao) * (1 - Number(i.taxa_administracao) / 100)
    : null;

  const dadosDoImovel = [
    ["Tipo", nomeTipo(i.tipo)],
    ["Endereço", [i.endereco, i.numero, i.complemento].filter(Boolean).join(", ")],
    ["Bairro", i.bairro],
    ["Cidade", [i.cidade, i.uf].filter(Boolean).join(" - ")],
    ["CEP", cepFormatado(i.cep)],
    ["Quartos", i.dormitorios],
    ["Suítes", i.suites],
    ["Banheiros", i.banheiros],
    ["Vagas", i.vagas],
    ["Área construída", Number(i.area_construida) > 0 ? metros(i.area_construida) : null],
    ["Área útil", Number(i.area_util) > 0 ? metros(i.area_util) : null],
    ["Terreno", Number(i.area_terreno) > 0 ? metros(i.area_terreno) : null],
    ["Medidas", Number(i.medida_frente) > 0 && Number(i.medida_fundo) > 0 ? `${i.medida_frente} × ${i.medida_fundo} m` : null],
    ["Mobília", NOME_DA_MOBILIA[i.mobilia] ?? (i.mobiliado ? "Mobiliado" : null)],
    ["Ocupação", NOME_DA_OCUPACAO[i.ocupacao]],
    ["Aceita pet", i.aceita_pet ? "Sim" : null],
    ["Financiamento", i.aceita_financiamento === 1 ? "Aceita" : null],
    ["Captador", i.captador],
  ].filter(([, v]) => v !== null && v !== undefined && v !== "" && v !== 0);

  const valores = [
    i.venda && ["Venda", Number(i.valor_venda) > 0 ? reais(i.valor_venda) : "Sem valor"],
    i.locacao && ["Aluguel", Number(i.valor_locacao) > 0 ? `${reais(i.valor_locacao)}/mês` : "Sem valor"],
    Number(i.valor_condominio) > 0 && ["Condomínio", reais(i.valor_condominio)],
    Number(i.valor_iptu) > 0 && ["IPTU", reais(i.valor_iptu)],
    liquido !== null && [`Proprietário recebe (taxa de ${Number(i.taxa_administracao)}%)`, reais(liquido)],
  ].filter(Boolean);

  async function copiar() {
    await navigator.clipboard.writeText(textoParaWhatsapp(i));
    setCopiado(true);
    setTimeout(() => setCopiado(false), 2000);
  }

  return (
    <section className="vista" aria-labelledby="t-imovel">
      <div className="linha-voltar">
        <button type="button" className="voltar" onClick={voltar}>← Imóveis</button>
        <BotaoFechar aoFechar={voltar} rotulo="Fechar o imóvel e voltar para Imóveis" />
      </div>
      <div className="cabeca-vista">
        <div>
          <span className="rotulo">{i.referencia} · {proprio ? "cadastro próprio" : "vem do Univen"} · {NOME_DA_SITUACAO[i.situacao]}</span>
          {/* Título longo do Univen vira a linha de baixo, para não tomar a tela. */}
          <h2 id="t-imovel">{i.titulo && i.titulo.length <= 80 ? i.titulo : `${nomeTipo(i.tipo)} em ${i.bairro}`}</h2>
          {i.titulo && i.titulo.length > 80 && <p className="titulo-longo">{i.titulo}</p>}
        </div>
        {/* Quem pode editar tem Editar em destaque; para os outros, a principal é copiar para o WhatsApp. */}
        <div className="acoes-cabeca acoes-ficha">
          {i.ativo && i.situacao === "disponivel" && <BotaoCompartilhar imovel={i} />}
          {podeEditar && <button type="button" className="botao secundario" onClick={() => abrir(`${i.codigo}/editar`)}>Editar</button>}
          <button type="button" className="botao secundario" onClick={copiar}>{copiado ? "Copiado" : "Copiar texto"}</button>
          {i.fotos?.length > 0 && <button type="button" className="botao secundario" onClick={() => setBaixando(true)}>Baixar fotos</button>}
          {i.link_site && i.situacao === "disponivel" && <a className="botao secundario" href={i.link_site} target="_blank" rel="noopener noreferrer">Ver no site</a>}
        </div>
      </div>

      {i.fotos?.length > 0 ? (
        <div className="fotos-ficha" tabIndex={0} role="group" aria-label={`${i.fotos.length} fotos do imóvel`}>
          {i.fotos.map((foto, n) => <img key={foto} src={miniDaFoto(foto)} alt={`Foto ${n + 1} de ${i.fotos.length}`} loading="lazy" decoding="async" />)}
        </div>
      ) : <p className="aviso-erro" style={{ margin: 0 }}>Este imóvel está sem fotos.</p>}

      {!proprio && <p className="mudo pequeno" style={{ margin: 0 }}>Este imóvel vem do Univen e é atualizado por lá. Aqui ele só pode ser consultado até a troca dos portais.</p>}

      <div className="grade-3-1">
        <div className="painel">
          <h3>Dados do imóvel</h3>
          <dl className="pares">{dadosDoImovel.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>)}</dl>
          {comodidades.length > 0 && <div className="atalhos" style={{ marginTop: 14 }}>{comodidades.map((c) => <span key={c} className="etiqueta pendente">{c}</span>)}</div>}
          {i.descricao && <><h3 style={{ marginTop: 18 }}>Descrição</h3><p className="texto-corrido">{i.descricao}</p></>}
        </div>
        <div className="formulario">
          <div className="painel">
            <h3>Valores</h3>
            <dl className="pares">{valores.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd><b>{v}</b></dd></Fragment>)}</dl>
          </div>
          {(i.locacao || i.venda) && i.ativo && <VisitasDoImovel imovel={i} />}
          {souGestor && <NumerosDoCompartilhamento imovel={i} />}
          <div className="painel">
            <h3>Qualidade do anúncio</h3>
            <NotaDeQualidade imovel={i} />
            {pendencias.length > 0 ? (
              <ul className="lista-simples">{pendencias.map((p) => <li key={p}>{p}</li>)}</ul>
            ) : <p className="pequeno mudo" style={{ margin: "8px 0 0" }}>Tudo certo para publicar nos portais.</p>}
          </div>
          {i.ativo && <AjustesParaPortais imovel={i} podeEditar={souGestor || ehMinhaCaptacao(i, eu)} />}
          {proprio && (proprietarios.length > 0 || podeEditar) && (
            <div className="painel">
              <h3>Proprietário{proprietarios.length > 1 ? "s" : ""}</h3>
              {proprietarios.length === 0 ? (
                <p className="texto-alerta pequeno" style={{ margin: 0 }}>Sem proprietário cadastrado. O imóvel só é publicado com o proprietário.</p>
              ) : (
                <ul className="lista">
                  {proprietarios.map((p) => (
                    <li key={p.id} className="dono">
                      <b>{p.nome}</b>
                      <a href={`https://wa.me/${p.telefone}`} target="_blank" rel="noopener noreferrer">{telefone(p.telefone)}</a>
                      {p.email && <a href={`mailto:${p.email}`}>{p.email}</a>}
                      {p.observacoes && <span className="mudo pequeno">{p.observacoes}</span>}
                    </li>
                  ))}
                </ul>
              )}
              <p className="mudo pequeno" style={{ margin: "8px 0 0" }}>Só o gestor e o captador do imóvel veem estes dados. A Thais e o site não recebem.</p>
            </div>
          )}
          {(cliques.length > 0 || souGestor || ehMinhaCaptacao(i, eu)) && (
            <div className="painel">
              <h3>Cliques no WhatsApp <span className="etiqueta pendente">{cliques.length === 100 ? "100+" : cliques.length}</span></h3>
              {cliques.length === 0 ? <p className="pequeno mudo" style={{ margin: 0 }}>Ninguém abriu o WhatsApp por este imóvel nos últimos 30 dias.</p> : (
                <ul className="lista">
                  {cliques.slice(0, 5).map((c) => (
                    <li key={c.id} className="pequeno">
                      {quandoFoi(c.criado_em)} · {NOME_DA_ORIGEM[c.origem] ?? c.origem}
                      {c.nome || c.telefone ? ` · ${[c.nome, c.telefone].filter(Boolean).join(", ")}` : ""}
                    </li>
                  ))}
                </ul>
              )}
              <a className="link-botao pequeno" href="#imoveis/cliques" style={{ marginTop: 4 }}>Ver todos os cliques</a>
            </div>
          )}
          <div className="painel">
            <h3>Clientes interessados <span className="etiqueta pendente">{interessados.length}</span></h3>
            {interessados.length === 0 ? <p className="pequeno mudo" style={{ margin: 0 }}>Nenhum cliente seu com este imóvel na ficha.</p> : (
              <ul className="lista">
                {interessados.map((l) => (
                  <li key={l.id}>
                    <a className="linha-interessado" href={`#leads/${l.id}`}>
                      <span>{l.nome ?? "Cliente sem nome"}<span className="mudo pequeno"> · {OPERACAO[l.interesse] ?? "—"}</span></span>
                      {l.etapa ? <span className="etiqueta pendente">{NOME_DA_ETAPA[l.etapa]}</span> : <Situacao status={l.status} />}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
      {baixando && <BaixarFotos imovel={i} aoFechar={() => setBaixando(false)} />}
    </section>
  );
}
