// Locação → Imóveis administrados: os imóveis da Locação, com IPTU, matrícula,
// garantias aceitas e os locadores (percentual de cada um, somando 100%).
// O imóvel em si (endereço, fotos, valores) continua vindo do cadastro de
// imóveis do CRM; aqui ficam só os dados da administração.
import { useEffect, useMemo, useState } from "react";
import { useAviso } from "../base/Avisos.jsx";
import { Carregando, dataHora, Erro, nomeTipo, reais, useCarregar } from "../comum.jsx";
import { Janela } from "../crm.jsx";
import { useSessao } from "../sessao.jsx";
import { exigir, mensagemDeErro, supabase } from "../supabase.js";
import { formatarDocumento, GARANTIAS, percentual } from "../locacao.js";
import { EscolherPessoa } from "./Pessoas.jsx";

const semAcento = (t) => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const CAMPOS_IMOVEL = "codigo, referencia, tipo, bairro, endereco, numero, complemento, cidade, uf, cep, foto_mini, foto_principal, valor_locacao, valor_iptu, valor_condominio, captador, situacao, ativo, origem";

export default function Administrados({ aberto, ir }) {
  if (aberto) return <FichaAdministrado codigo={aberto} voltar={() => ir("administrados")} ir={ir} />;
  return <ListaAdministrados ir={ir} />;
}

function ListaAdministrados({ ir }) {
  const { versao } = useSessao();
  const [busca, setBusca] = useState("");
  const [adicionar, setAdicionar] = useState(false);
  const { dados, erro } = useCarregar(async () => {
    const lista = exigir(await supabase.from("imoveis_locacao")
      .select(`imovel_codigo, iptu_valor, atualizado_em, imoveis(${CAMPOS_IMOVEL}), imovel_locadores(percentual, pessoas!imovel_locadores_pessoa_id_fkey(nome))`)
      .order("atualizado_em", { ascending: false }));
    return lista;
  }, [versao]);
  const termo = semAcento(busca.trim());
  const visiveis = (dados ?? []).filter((l) => !termo || semAcento(`${l.imoveis?.referencia} ${l.imoveis?.endereco} ${l.imoveis?.bairro} ${l.imovel_locadores.map((x) => x.pessoas?.nome).join(" ")}`).includes(termo));

  return (
    <section className="vista" aria-labelledby="t-administrados">
      <div className="cabeca-vista">
        <div>
          <h2 id="t-administrados">Imóveis administrados</h2>
          <p>Imóveis da Locação com os locadores e a parte de cada um. Endereço, fotos e valores vêm do cadastro de imóveis.</p>
        </div>
        <button type="button" className="botao" onClick={() => setAdicionar(true)}>Adicionar imóvel</button>
      </div>
      <div className="filtros">
        <input className="busca" type="search" placeholder="Buscar por referência, endereço, bairro ou locador" value={busca} onChange={(e) => setBusca(e.target.value)} />
      </div>
      <Erro mensagem={erro} />
      {!dados ? <Carregando /> : (
        <div className="tabela-caixa">
          <table className="tabela-administrados tabela-cartoes">
            <thead><tr><th>Imóvel</th><th>Endereço</th><th>Locadores</th><th>Aluguel anunciado</th><th>Captador</th></tr></thead>
            <tbody>
              {visiveis.length === 0 ? (
                <tr><td colSpan={5} className="mudo">{dados.length ? "Nenhum imóvel com essa busca." : "Nenhum imóvel administrado ainda. Comece em Adicionar imóvel."}</td></tr>
              ) : visiveis.map((l) => {
                const i = l.imoveis ?? {};
                const soma = l.imovel_locadores.reduce((s, x) => s + Number(x.percentual), 0);
                return (
                  <tr key={l.imovel_codigo} className="clicavel" tabIndex={0} onClick={() => ir("administrados", l.imovel_codigo)} onKeyDown={(e) => e.key === "Enter" && ir("administrados", l.imovel_codigo)}>
                    <td className="dado">{i.referencia ?? l.imovel_codigo}<span className="sub">{nomeTipo(i.tipo)}</span></td>
                    <td data-rotulo="Endereço"><span className="forte">{[i.endereco, i.numero].filter(Boolean).join(", ") || "—"}</span><span className="sub">{[i.bairro, i.cidade].filter(Boolean).join(" · ")}</span></td>
                    <td data-rotulo="Locadores">{l.imovel_locadores.length ? l.imovel_locadores.map((x) => <span key={x.pessoas?.nome} className="sub" style={{ display: "block" }}>{x.pessoas?.nome} · {percentual(x.percentual)}</span>)
                      : <span className="etiqueta alerta">sem locador</span>}
                      {l.imovel_locadores.length > 0 && soma !== 100 && <span className="etiqueta alerta">soma {percentual(soma)}</span>}</td>
                    <td data-rotulo="Aluguel anunciado">{i.valor_locacao ? reais(i.valor_locacao) : "—"}</td>
                    <td data-rotulo="Captador" className="pequeno">{i.captador ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mudo pequeno" style={{ margin: "10px 2px 0" }}>{visiveis.length} imóve{visiveis.length === 1 ? "l" : "is"}</p>
        </div>
      )}
      {adicionar && <EscolherImovel jaAdministrados={new Set((dados ?? []).map((l) => l.imovel_codigo))} aoFechar={() => setAdicionar(false)} aoEscolher={(codigo) => { setAdicionar(false); ir("administrados", codigo); }} />}
    </section>
  );
}

// Busca no cadastro de imóveis do CRM (ativos ou não: os já alugados podem estar fora do site).
function EscolherImovel({ jaAdministrados, aoFechar, aoEscolher }) {
  const [busca, setBusca] = useState("");
  const { dados, erro } = useCarregar(async () => exigir(await supabase.from("imoveis").select("codigo, referencia, tipo, bairro, endereco, numero, locacao, ativo").is("rascunho_de", null).order("referencia").limit(3000)), []);
  const termo = semAcento(busca.trim());
  const achados = useMemo(() => (dados ?? []).filter((i) => termo.length >= 2 && semAcento(`${i.referencia} ${i.endereco} ${i.bairro}`).includes(termo)).slice(0, 30), [dados, termo]);
  return (
    <Janela titulo="Adicionar imóvel à Locação" aoFechar={aoFechar}>
      <div className="formulario">
        <input className="busca" autoFocus type="search" placeholder="Referência (ex.: AP00252), rua ou bairro" value={busca} onChange={(e) => setBusca(e.target.value)} />
        <Erro mensagem={erro} />
        {!dados ? <Carregando /> : (
          <ul className="lista escolher-pessoa">
            {termo.length < 2 && <li className="mudo pequeno">Digite ao menos 2 letras.</li>}
            {termo.length >= 2 && achados.length === 0 && <li className="mudo pequeno">Nenhum imóvel com essa busca. Se ele não está no cadastro, cadastre primeiro em Imóveis.</li>}
            {achados.map((i) => (
              <li key={i.codigo}>
                <button type="button" onClick={() => aoEscolher(i.codigo)}>
                  <b>{i.referencia}{jaAdministrados.has(i.codigo) ? " · já administrado" : ""}</b>
                  <span className="mudo pequeno">{[nomeTipo(i.tipo), [i.endereco, i.numero].filter(Boolean).join(", "), i.bairro].filter(Boolean).join(" · ")}{i.ativo ? "" : " · fora do site"}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Janela>
  );
}

function FichaAdministrado({ codigo, voltar, ir }) {
  const avisar = useAviso();
  const { versao, recarregar } = useSessao();
  const { dados, erro } = useCarregar(async () => {
    const [rImovel, rAdm, rLocadores, rDonos] = await Promise.all([
      supabase.from("imoveis").select(CAMPOS_IMOVEL).eq("codigo", codigo).maybeSingle(),
      supabase.from("imoveis_locacao").select("*").eq("imovel_codigo", codigo).maybeSingle(),
      supabase.from("imovel_locadores").select("pessoa_id, percentual, favorecido_id").eq("imovel_codigo", codigo),
      supabase.from("imovel_proprietarios").select("proprietarios(id, nome, telefone)").eq("imovel_codigo", codigo),
    ]);
    const imovel = exigir(rImovel);
    if (!imovel) throw new Error("Imóvel não encontrado.");
    const locadores = exigir(rLocadores);
    const ids = [...new Set(locadores.flatMap((l) => [l.pessoa_id, l.favorecido_id]).filter(Boolean))];
    const pessoas = ids.length ? exigir(await supabase.from("pessoas").select("id, nome, documento, cadastro_completo").in("id", ids)) : [];
    return { imovel, adm: exigir(rAdm), locadores, pessoas: new Map(pessoas.map((p) => [p.id, p])), donos: (exigir(rDonos) ?? []).map((d) => d.proprietarios).filter(Boolean) };
  }, [codigo, versao]);

  const [campos, setCampos] = useState(null);
  const [locadores, setLocadores] = useState([]);
  const [pessoas, setPessoas] = useState(new Map());
  const [escolhendo, setEscolhendo] = useState(null); // { tipo: "locador" } ou { tipo: "favorecido", indice }
  const [ocupado, setOcupado] = useState(false);
  const [erroSalvar, setErroSalvar] = useState(null);

  useEffect(() => {
    if (!dados) return;
    const a = dados.adm ?? {};
    setCampos({
      iptu_inscricao: a.iptu_inscricao ?? "", iptu_valor: a.iptu_valor ?? dados.imovel.valor_iptu ?? "", iptu_forma: a.iptu_forma ?? "", iptu_responsavel: a.iptu_responsavel ?? "",
      matricula: a.matricula ?? "", cartorio: a.cartorio ?? "", condominio_administradora: a.condominio_administradora ?? "",
      condominio_valor: a.condominio_valor ?? dados.imovel.valor_condominio ?? "", garantias_aceitas: a.garantias_aceitas ?? [], observacoes: a.observacoes ?? "",
    });
    setLocadores(dados.locadores.map((l) => ({ pessoa_id: l.pessoa_id, percentual: String(l.percentual), favorecido_id: l.favorecido_id ?? "" })));
    setPessoas(dados.pessoas);
  }, [dados]);

  const soma = locadores.reduce((s, l) => s + (Number(l.percentual) || 0), 0);
  const mudar = (campo) => (e) => setCampos((c) => ({ ...c, [campo]: e.target.value }));

  async function escolheu(id) {
    const p = exigir(await supabase.from("pessoas").select("id, nome, documento, cadastro_completo").eq("id", id).maybeSingle());
    setPessoas((atual) => new Map(atual).set(p.id, p));
    if (escolhendo.tipo === "locador") {
      if (!locadores.some((l) => l.pessoa_id === id)) {
        const resto = Math.max(0, 100 - soma);
        setLocadores((ls) => [...ls, { pessoa_id: id, percentual: String(resto || ""), favorecido_id: "" }]);
      }
    } else {
      setLocadores((ls) => ls.map((l, n) => (n === escolhendo.indice ? { ...l, favorecido_id: id } : l)));
    }
    setEscolhendo(null);
  }

  async function salvar(evento) {
    evento.preventDefault();
    setOcupado(true);
    setErroSalvar(null);
    try {
      exigir(await supabase.rpc("salvar_imovel_locacao", {
        p_codigo: codigo,
        p_dados: Object.fromEntries(Object.entries(campos).map(([k, v]) => [k, Array.isArray(v) ? v : String(v ?? "")])),
        p_locadores: locadores.map((l) => ({ pessoa_id: l.pessoa_id, percentual: Number(String(l.percentual).replace(",", ".")), favorecido_id: l.favorecido_id || null })),
      }));
      avisar(dados.adm ? "Imóvel salvo." : "Imóvel adicionado à Locação.");
      recarregar();
    } catch (e) {
      setErroSalvar(mensagemDeErro(e));
    } finally {
      setOcupado(false);
    }
  }

  if (erro) return <section className="vista"><button type="button" className="voltar" onClick={voltar}>← Imóveis administrados</button><Erro mensagem={erro} /></section>;
  if (!campos) return <section className="vista"><Carregando /></section>;
  const i = dados.imovel;

  return (
    <section className="vista" aria-labelledby="t-administrado">
      <button type="button" className="voltar" onClick={voltar}>← Imóveis administrados</button>
      <div className="resumo-imovel-locacao painel">
        {(i.foto_mini || i.foto_principal) && <img src={i.foto_mini || i.foto_principal} alt="" />}
        <div>
          <h2 id="t-administrado">{i.referencia} · {nomeTipo(i.tipo)}</h2>
          <p className="mudo" style={{ margin: "2px 0 8px" }}>{[[i.endereco, i.numero].filter(Boolean).join(", "), i.complemento, i.bairro, i.cidade && `${i.cidade}/${i.uf ?? ""}`].filter(Boolean).join(" · ")}</p>
          <dl className="pares pares-linha">
            <dt>Aluguel anunciado</dt><dd>{i.valor_locacao ? reais(i.valor_locacao) : "—"}</dd>
            <dt>Captador</dt><dd>{i.captador ?? "—"}</dd>
            <dt>No site</dt><dd>{i.ativo ? "sim" : "não"}</dd>
          </dl>
          {!dados.adm && <p className="aviso-locacao" style={{ marginTop: 10 }}>Este imóvel ainda não está na Locação. Preencha e salve para adicionar.</p>}
        </div>
      </div>

      <form className="formulario" onSubmit={salvar}>
        <fieldset className="painel formulario">
          <legend>Locadores <small className="mudo">(a soma tem que dar 100%)</small></legend>
          {dados.donos.length > 0 && (
            <p className="mudo pequeno" style={{ margin: 0 }}>Proprietário no cadastro do imóvel: {dados.donos.map((d) => d.nome).join(", ")}. Cadastre-o em Pessoas com o CPF para usar aqui.</p>
          )}
          {locadores.length === 0 && <p className="mudo" style={{ margin: 0 }}>Nenhum locador ainda.</p>}
          {locadores.map((l, n) => {
            const p = pessoas.get(l.pessoa_id);
            const f = l.favorecido_id ? pessoas.get(l.favorecido_id) : null;
            return (
              <div key={l.pessoa_id} className="linha-locador">
                <div>
                  <button type="button" className="link-botao" onClick={() => ir("pessoas", l.pessoa_id)}>{p?.nome ?? "—"}</button>
                  <span className="mudo pequeno dado" style={{ display: "block" }}>{formatarDocumento(p?.documento)}{p && !p.cadastro_completo ? " · cadastro incompleto" : ""}</span>
                  <span className="pequeno">
                    Repasse para: {f ? <b>{f.nome}</b> : "o próprio locador"}{" "}
                    <button type="button" className="link-botao pequeno" onClick={() => setEscolhendo({ tipo: "favorecido", indice: n })}>{f ? "trocar" : "outra pessoa"}</button>
                    {f && <> <button type="button" className="link-botao pequeno" onClick={() => setLocadores((ls) => ls.map((x, k) => (k === n ? { ...x, favorecido_id: "" } : x)))}>tirar</button></>}
                  </span>
                </div>
                <label className="campo percentual-locador">%<input inputMode="decimal" required value={l.percentual} onChange={(e) => setLocadores((ls) => ls.map((x, k) => (k === n ? { ...x, percentual: e.target.value } : x)))} /></label>
                <button type="button" className="botao secundario pequeno" onClick={() => setLocadores((ls) => ls.filter((_, k) => k !== n))}>Tirar</button>
              </div>
            );
          })}
          <div className="atalhos" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <button type="button" className="botao secundario" onClick={() => setEscolhendo({ tipo: "locador" })}>+ Adicionar locador</button>
            {locadores.length > 0 && <span className={`etiqueta ${Math.abs(soma - 100) < 0.0001 ? "pronto" : "alerta"}`}>Soma {percentual(soma)}</span>}
          </div>
        </fieldset>

        <fieldset className="painel formulario">
          <legend>IPTU e condomínio</legend>
          <div className="grade-3">
            <label className="campo">Inscrição do IPTU<input value={campos.iptu_inscricao} onChange={mudar("iptu_inscricao")} /></label>
            <label className="campo">Valor do IPTU (R$)<input type="number" min={0} step="0.01" value={campos.iptu_valor} onChange={mudar("iptu_valor")} /></label>
            <label className="campo">Pagamento do IPTU
              <select value={campos.iptu_forma} onChange={mudar("iptu_forma")}><option value="">—</option><option value="a_vista">À vista</option><option value="parcelado">Parcelado</option><option value="isento">Isento</option></select>
            </label>
            <label className="campo">Quem paga o IPTU
              <select value={campos.iptu_responsavel} onChange={mudar("iptu_responsavel")}><option value="">—</option><option value="locatario">Locatário</option><option value="locador">Locador</option><option value="imobiliaria">Imobiliária</option></select>
            </label>
            <label className="campo">Condomínio (R$/mês)<input type="number" min={0} step="0.01" value={campos.condominio_valor} onChange={mudar("condominio_valor")} /></label>
            <label className="campo">Administradora do condomínio<input value={campos.condominio_administradora} onChange={mudar("condominio_administradora")} /></label>
          </div>
        </fieldset>

        <fieldset className="painel formulario">
          <legend>Registro do imóvel</legend>
          <div className="grade-2">
            <label className="campo">Matrícula<input value={campos.matricula} onChange={mudar("matricula")} /></label>
            <label className="campo">Cartório<input value={campos.cartorio} onChange={mudar("cartorio")} /></label>
          </div>
        </fieldset>

        <fieldset className="painel formulario">
          <legend>Garantias que o proprietário aceita</legend>
          <div className="participantes-opcoes">
            {GARANTIAS.map(([v, n]) => (
              <label key={v} className={`participante-opcao${campos.garantias_aceitas.includes(v) ? " marcado" : ""}`}>
                <input type="checkbox" checked={campos.garantias_aceitas.includes(v)} onChange={(e) => setCampos((c) => ({ ...c, garantias_aceitas: e.target.checked ? [...c.garantias_aceitas, v] : c.garantias_aceitas.filter((x) => x !== v) }))} />
                {n}
              </label>
            ))}
          </div>
          <label className="campo">Observações<textarea rows={3} value={campos.observacoes} onChange={mudar("observacoes")} /></label>
        </fieldset>

        <Erro mensagem={erroSalvar} />
        <div className="barra-salvar">
          <span className="mudo pequeno">{dados.adm ? `Atualizado em ${dataHora(dados.adm.atualizado_em)}` : "Ainda não salvo"}</span>
          <button type="submit" className="botao" disabled={ocupado || (locadores.length > 0 && Math.abs(soma - 100) > 0.0001)}>{ocupado ? "Salvando…" : dados.adm ? "Salvar" : "Adicionar à Locação"}</button>
        </div>
      </form>

      {escolhendo && (
        <EscolherPessoa
          titulo={escolhendo.tipo === "locador" ? "Adicionar locador" : "Quem recebe o repasse"}
          papel={escolhendo.tipo === "locador" ? "locador" : undefined}
          aoFechar={() => setEscolhendo(null)}
          aoEscolher={(id) => escolheu(id).catch((e) => { setErroSalvar(mensagemDeErro(e)); setEscolhendo(null); })}
        />
      )}
    </section>
  );
}
