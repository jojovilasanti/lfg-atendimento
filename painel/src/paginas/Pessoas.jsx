// Locação → Pessoas: locadores, locatários, fiadores e procuradores, com
// CPF/CNPJ único. Só gestor e administrativo (o banco recusa o resto).
// Um cadastro novo sempre começa pelo CPF/CNPJ: se a pessoa já existe, abre a
// ficha dela em vez de criar outra.
import { useEffect, useMemo, useState } from "react";
import Segmento from "../base/Segmento.jsx";
import { useAviso } from "../base/Avisos.jsx";
import { Carregando, dataHora, Erro, iniciais, telefone, useCarregar } from "../comum.jsx";
import { Janela } from "../crm.jsx";
import { useSessao } from "../sessao.jsx";
import { exigir, mensagemDeErro, supabase } from "../supabase.js";
import { documentoValido, ESTADOS_CIVIS, formatarDocumento, mascaraDocumento, NOME_DO_PAPEL, PAPEIS, percentual, soDigitos } from "../locacao.js";

const FILTROS = [
  ["ativas", "Ativas", (p) => !p.arquivada],
  ["incompletas", "Cadastro incompleto", (p) => !p.arquivada && !p.cadastro_completo],
  ["arquivadas", "Arquivadas", (p) => p.arquivada],
  ["todas", "Todas", () => true],
];
const semAcento = (t) => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export default function Pessoas({ aberta, ir }) {
  if (aberta) return <FichaPessoa id={aberta} voltar={() => ir("pessoas")} ir={ir} />;
  return <ListaDePessoas ir={ir} />;
}

function ListaDePessoas({ ir }) {
  const { versao } = useSessao();
  const [filtro, setFiltro] = useState("ativas");
  const [papel, setPapel] = useState("");
  const [busca, setBusca] = useState("");
  const [nova, setNova] = useState(false);
  const { dados, erro } = useCarregar(async () =>
    exigir(await supabase.from("pessoas").select("id, tipo, nome, documento, telefones, emails, papeis, arquivada, cadastro_completo, atualizado_em").order("nome").limit(5000)), [versao]);

  const termo = semAcento(busca.trim());
  const digitos = soDigitos(busca);
  const [, , regra] = FILTROS.find(([id]) => id === filtro);
  const visiveis = (dados ?? []).filter(regra).filter((p) => !papel || p.papeis.includes(papel)).filter((p) =>
    !termo || semAcento(p.nome).includes(termo) || (digitos.length >= 3 && (p.documento.includes(digitos) || p.telefones.some((t) => soDigitos(t).includes(digitos))))
    || p.emails.some((e) => e.includes(termo)));

  return (
    <section className="vista" aria-labelledby="t-pessoas">
      <div className="cabeca-vista">
        <div>
          <h2 id="t-pessoas">Pessoas</h2>
          <p>Locadores, locatários, fiadores e procuradores da Locação. Só a gestão vê esta área.</p>
        </div>
        <button type="button" className="botao" onClick={() => setNova(true)}>Nova pessoa</button>
      </div>
      <div className="filtros">
        <Segmento rotulo="Situação do cadastro" valor={filtro} aoMudar={setFiltro} opcoes={FILTROS.map(([id, rotulo, r]) => ({ id, rotulo, conta: (dados ?? []).filter(r).length }))} />
        <label className="campo campo-pessoa">
          <span className="invisivel">Papel</span>
          <select value={papel} onChange={(e) => setPapel(e.target.value)}>
            <option value="">Todos os papéis</option>
            {PAPEIS.map(([id, nome]) => <option key={id} value={id}>{nome}</option>)}
          </select>
        </label>
        <input className="busca" type="search" placeholder="Buscar por nome, CPF/CNPJ, telefone ou e-mail" value={busca} onChange={(e) => setBusca(e.target.value)} />
      </div>
      <Erro mensagem={erro} />
      {!dados ? <Carregando /> : (
        <div className="tabela-caixa">
          <table className="tabela-pessoas tabela-cartoes">
            <thead><tr><th>Pessoa</th><th>Papéis</th><th>Contato</th><th>Cadastro</th><th>Atualizado</th></tr></thead>
            <tbody>
              {visiveis.length === 0 ? (
                <tr><td colSpan={5} className="mudo">{dados.length ? "Ninguém com esse filtro." : "Nenhuma pessoa cadastrada ainda. Comece em Nova pessoa."}</td></tr>
              ) : visiveis.map((p) => (
                <tr key={p.id} className="clicavel" tabIndex={0} onClick={() => ir("pessoas", p.id)} onKeyDown={(e) => e.key === "Enter" && ir("pessoas", p.id)}>
                  <td>
                    <span className="pessoa-linha">
                      <span className="avatar pequeno" aria-hidden="true">{iniciais(p.nome)}</span>
                      <span><span className="forte">{p.nome}</span><span className="sub dado">{p.tipo === "pj" ? "CNPJ" : "CPF"} {formatarDocumento(p.documento)}</span></span>
                    </span>
                  </td>
                  <td data-rotulo="Papéis">{p.papeis.length ? p.papeis.map((x) => <span key={x} className="etiqueta pendente papel-etiqueta">{NOME_DO_PAPEL[x]}</span>) : <span className="mudo">—</span>}</td>
                  <td data-rotulo="Contato" className="pequeno">{p.telefones[0] ? telefone(soDigitos(p.telefones[0]).length <= 11 ? `55${soDigitos(p.telefones[0])}` : soDigitos(p.telefones[0])) : p.emails[0] ?? "—"}</td>
                  <td data-rotulo="Cadastro">{p.arquivada ? <span className="etiqueta pendente">arquivada</span> : p.cadastro_completo ? <span className="etiqueta pronto">completo</span> : <span className="etiqueta alerta">incompleto</span>}</td>
                  <td data-rotulo="Atualizado" className="pequeno mudo">{dataHora(p.atualizado_em)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mudo pequeno" style={{ margin: "10px 2px 0" }}>{visiveis.length} pessoa{visiveis.length === 1 ? "" : "s"} encontrada{visiveis.length === 1 ? "" : "s"}</p>
        </div>
      )}
      {nova && <NovaPessoa aoFechar={() => setNova(false)} aoEscolher={(id) => { setNova(false); ir("pessoas", id); }} />}
    </section>
  );
}

// Primeiro passo de todo cadastro: o CPF/CNPJ. Já existe → abre; senão cria.
export function NovaPessoa({ aoFechar, aoEscolher, papelInicial }) {
  const [documento, setDocumento] = useState("");
  const [nome, setNome] = useState("");
  const [existente, setExistente] = useState(undefined);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState(null);
  const valido = documentoValido(documento);

  async function continuar(evento) {
    evento.preventDefault();
    setErro(null);
    if (!valido) return setErro("CPF ou CNPJ inválido. Confira os números.");
    setOcupado(true);
    try {
      if (existente === undefined) {
        const achada = exigir(await supabase.from("pessoas").select("id, nome").eq("documento", soDigitos(documento)).maybeSingle());
        setExistente(achada);
        if (achada) return;
        return;
      }
      if (existente) return aoEscolher(existente.id);
      const id = exigir(await supabase.rpc("salvar_pessoa", { p_id: null, p_dados: { documento, nome, papeis: papelInicial ? [papelInicial] : [] } }));
      aoEscolher(id);
    } catch (e) {
      setErro(mensagemDeErro(e));
    } finally {
      setOcupado(false);
    }
  }

  const pj = soDigitos(documento).length === 14;
  return (
    <Janela titulo="Nova pessoa" aoFechar={aoFechar}>
      <form className="formulario" onSubmit={continuar}>
        <label className="campo">Qual o CPF ou CNPJ da pessoa?
          <input autoFocus inputMode="numeric" placeholder="000.000.000-00 ou 00.000.000/0000-00" value={documento} disabled={existente !== undefined}
            onChange={(e) => { setDocumento(mascaraDocumento(e.target.value)); setExistente(undefined); }} />
        </label>
        {existente && (
          <p className="aviso-locacao">Essa pessoa já está cadastrada: <b>{existente.nome}</b>. Vou abrir a ficha dela.</p>
        )}
        {existente === null && (
          <label className="campo">{pj ? "Razão social" : "Nome completo"}
            <input autoFocus required minLength={2} maxLength={160} value={nome} onChange={(e) => setNome(e.target.value)} />
          </label>
        )}
        <Erro mensagem={erro} />
        <div className="atalhos" style={{ justifyContent: "flex-end" }}>
          {existente !== undefined && <button type="button" className="botao secundario" onClick={() => setExistente(undefined)}>Trocar o documento</button>}
          <button type="button" className="botao secundario" onClick={aoFechar}>Cancelar</button>
          <button type="submit" className="botao" disabled={ocupado || !valido || (existente === null && nome.trim().length < 2)}>
            {ocupado ? "Aguarde…" : existente ? "Abrir a ficha" : existente === null ? "Criar e abrir" : "Continuar"}
          </button>
        </div>
      </form>
    </Janela>
  );
}

const CAMPOS_VAZIOS = {
  nome: "", nome_fantasia: "", documento: "", rg: "", rg_orgao: "", nascimento: "", estado_civil: "", regime_bens: "", nacionalidade: "", profissao: "", renda: "",
  emails: [""], telefones: [""], cep: "", logradouro: "", numero: "", complemento: "", bairro: "", cidade: "", uf: "",
  conjuge_nome: "", conjuge_documento: "", conjuge_rg: "", banco: "", agencia: "", conta: "", conta_tipo: "", pix_tipo: "", pix_chave: "", papeis: [], observacoes: "",
};

function FichaPessoa({ id, voltar, ir }) {
  const avisar = useAviso();
  const { versao, recarregar } = useSessao();
  const { dados, erro } = useCarregar(async () => {
    const [rPessoa, rImoveis] = await Promise.all([
      supabase.from("pessoas").select("*").eq("id", id).maybeSingle(),
      supabase.from("imovel_locadores").select("percentual, imovel_codigo, imoveis_locacao(imoveis(referencia, tipo, bairro))").eq("pessoa_id", id),
    ]);
    const pessoa = exigir(rPessoa);
    if (!pessoa) throw new Error("Pessoa não encontrada.");
    return { pessoa, imoveis: exigir(rImoveis) };
  }, [id, versao]);
  const [campos, setCampos] = useState(null);
  const [ocupado, setOcupado] = useState(false);
  const [erroSalvar, setErroSalvar] = useState(null);
  const [avisoCep, setAvisoCep] = useState(null);

  useEffect(() => {
    if (!dados) return;
    const p = dados.pessoa;
    setCampos({
      ...CAMPOS_VAZIOS,
      ...Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v ?? ""])),
      documento: formatarDocumento(p.documento),
      emails: p.emails.length ? p.emails : [""],
      telefones: p.telefones.length ? p.telefones : [""],
      renda: p.renda ?? "",
      conjuge_documento: p.conjuge_documento ? formatarDocumento(p.conjuge_documento) : "",
    });
  }, [dados]);

  const mudar = (campo) => (e) => setCampos((c) => ({ ...c, [campo]: e.target.value }));
  const mudarLista = (campo, n) => (e) => setCampos((c) => ({ ...c, [campo]: c[campo].map((v, i) => (i === n ? e.target.value : v)) }));
  const pj = campos && soDigitos(campos.documento).length === 14;
  const casado = campos && ["casado", "uniao_estavel"].includes(campos.estado_civil);

  async function buscarCep() {
    const cep = soDigitos(campos.cep);
    setAvisoCep(null);
    if (cep.length !== 8) return;
    try {
      const achado = await (await fetch(`https://viacep.com.br/ws/${cep}/json/`)).json();
      if (achado.erro) throw new Error();
      setCampos((c) => ({ ...c, logradouro: achado.logradouro || c.logradouro, bairro: achado.bairro || c.bairro, cidade: achado.localidade, uf: achado.uf }));
    } catch {
      setAvisoCep("Não achei esse CEP. Preencha o endereço.");
    }
  }

  async function salvar(evento) {
    evento.preventDefault();
    setOcupado(true);
    setErroSalvar(null);
    try {
      exigir(await supabase.rpc("salvar_pessoa", { p_id: id, p_dados: { ...campos, renda: campos.renda === "" ? "" : String(campos.renda) } }));
      avisar("Cadastro salvo.");
      recarregar();
    } catch (e) {
      setErroSalvar(mensagemDeErro(e));
    } finally {
      setOcupado(false);
    }
  }

  async function arquivar(valor) {
    try {
      exigir(await supabase.rpc("arquivar_pessoa", { p_id: id, p_arquivada: valor }));
      avisar(valor ? "Pessoa arquivada." : "Pessoa reativada.");
      recarregar();
    } catch (e) {
      setErroSalvar(mensagemDeErro(e));
    }
  }

  if (erro) return <section className="vista"><button type="button" className="voltar" onClick={voltar}>← Pessoas</button><Erro mensagem={erro} /></section>;
  if (!campos) return <section className="vista"><Carregando /></section>;
  const p = dados.pessoa;

  return (
    <section className="vista" aria-labelledby="t-pessoa">
      <button type="button" className="voltar" onClick={voltar}>← Pessoas</button>
      <div className="cabeca-vista">
        <div className="pessoa-linha">
          <span className="avatar" aria-hidden="true">{iniciais(p.nome)}</span>
          <div>
            <h2 id="t-pessoa">{p.nome}</h2>
            <p className="dado">{pj ? "CNPJ" : "CPF"} {formatarDocumento(p.documento)} · {p.cadastro_completo ? "cadastro completo" : "cadastro incompleto"}{p.arquivada ? " · arquivada" : ""}</p>
          </div>
        </div>
        <button type="button" className="botao secundario pequeno" onClick={() => arquivar(!p.arquivada)}>{p.arquivada ? "Reativar" : "Arquivar"}</button>
      </div>

      <form className="ficha-locacao" onSubmit={salvar}>
        <nav className="ficha-locacao-menu" aria-label="Partes do cadastro">
          {[["p-identificacao", "Identificação"], ["p-contato", "Contato"], ["p-endereco", "Endereço"], ...(pj ? [] : [["p-conjuge", "Cônjuge"]]), ["p-banco", "Banco e PIX"], ["p-papeis", "Papéis"], ["p-imoveis", "Imóveis"]].map(([alvo, nome]) => (
            <a key={alvo} href={`#${alvo}`} onClick={(e) => { e.preventDefault(); document.getElementById(alvo)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>{nome}</a>
          ))}
        </nav>
        <div className="ficha-locacao-corpo">
          <fieldset className="painel formulario" id="p-identificacao">
            <legend>Identificação</legend>
            <div className="grade-2">
              <label className="campo">{pj ? "Razão social" : "Nome completo"}<input required minLength={2} maxLength={160} value={campos.nome} onChange={mudar("nome")} /></label>
              <label className="campo">{pj ? "CNPJ" : "CPF"}<input inputMode="numeric" value={campos.documento} onChange={(e) => setCampos((c) => ({ ...c, documento: mascaraDocumento(e.target.value) }))} /></label>
            </div>
            {pj ? (
              <label className="campo">Nome fantasia<input maxLength={160} value={campos.nome_fantasia} onChange={mudar("nome_fantasia")} /></label>
            ) : (
              <>
                <div className="grade-3">
                  <label className="campo">RG<input maxLength={30} value={campos.rg} onChange={mudar("rg")} /></label>
                  <label className="campo">Órgão emissor<input maxLength={20} value={campos.rg_orgao} onChange={mudar("rg_orgao")} /></label>
                  <label className="campo">Nascimento<input type="date" value={campos.nascimento} onChange={mudar("nascimento")} /></label>
                </div>
                <div className="grade-3">
                  <label className="campo">Estado civil
                    <select value={campos.estado_civil} onChange={mudar("estado_civil")}><option value="">—</option>{ESTADOS_CIVIS.map(([v, n]) => <option key={v} value={v}>{n}</option>)}</select>
                  </label>
                  <label className="campo">Nacionalidade<input maxLength={40} placeholder="Brasileira" value={campos.nacionalidade} onChange={mudar("nacionalidade")} /></label>
                  <label className="campo">Profissão<input maxLength={80} value={campos.profissao} onChange={mudar("profissao")} /></label>
                </div>
              </>
            )}
            <label className="campo" style={{ maxWidth: 260 }}>{pj ? "Faturamento mensal (R$)" : "Renda mensal (R$)"}<input type="number" min={0} step="0.01" value={campos.renda} onChange={mudar("renda")} /></label>
          </fieldset>

          <fieldset className="painel formulario" id="p-contato">
            <legend>Contato</legend>
            <div className="grade-2">
              <div className="lista-campos">
                {campos.telefones.map((t, n) => (
                  <label key={n} className="campo">Telefone {campos.telefones.length > 1 ? n + 1 : ""}<input inputMode="tel" value={t} onChange={mudarLista("telefones", n)} /></label>
                ))}
                <button type="button" className="link-botao pequeno" onClick={() => setCampos((c) => ({ ...c, telefones: [...c.telefones, ""] }))}>+ outro telefone</button>
              </div>
              <div className="lista-campos">
                {campos.emails.map((t, n) => (
                  <label key={n} className="campo">E-mail {campos.emails.length > 1 ? n + 1 : ""}<input type="email" value={t} onChange={mudarLista("emails", n)} /></label>
                ))}
                <button type="button" className="link-botao pequeno" onClick={() => setCampos((c) => ({ ...c, emails: [...c.emails, ""] }))}>+ outro e-mail</button>
              </div>
            </div>
          </fieldset>

          <fieldset className="painel formulario" id="p-endereco">
            <legend>Endereço</legend>
            <div className="grade-3">
              <label className="campo">CEP<input inputMode="numeric" value={campos.cep} onChange={mudar("cep")} onBlur={buscarCep} /></label>
              <label className="campo" style={{ gridColumn: "span 2" }}>Rua<input value={campos.logradouro} onChange={mudar("logradouro")} /></label>
              <label className="campo">Número<input value={campos.numero} onChange={mudar("numero")} /></label>
              <label className="campo">Complemento<input value={campos.complemento} onChange={mudar("complemento")} /></label>
              <label className="campo">Bairro<input value={campos.bairro} onChange={mudar("bairro")} /></label>
              <label className="campo">Cidade<input value={campos.cidade} onChange={mudar("cidade")} /></label>
              <label className="campo">UF<input maxLength={2} value={campos.uf} onChange={mudar("uf")} /></label>
            </div>
            {avisoCep && <p className="pequeno mudo" style={{ margin: 0 }}>{avisoCep}</p>}
          </fieldset>

          {!pj && (
            <fieldset className="painel formulario" id="p-conjuge">
              <legend>Cônjuge {casado ? "" : <small className="mudo">(se for casado ou em união estável)</small>}</legend>
              <div className="grade-3">
                <label className="campo">Nome<input value={campos.conjuge_nome} onChange={mudar("conjuge_nome")} /></label>
                <label className="campo">CPF<input inputMode="numeric" value={campos.conjuge_documento} onChange={(e) => setCampos((c) => ({ ...c, conjuge_documento: mascaraDocumento(e.target.value) }))} /></label>
                <label className="campo">RG<input value={campos.conjuge_rg} onChange={mudar("conjuge_rg")} /></label>
              </div>
              {casado && <label className="campo" style={{ maxWidth: 320 }}>Regime de bens<input value={campos.regime_bens} onChange={mudar("regime_bens")} /></label>}
            </fieldset>
          )}

          <fieldset className="painel formulario" id="p-banco">
            <legend>Banco e PIX <small className="mudo">(para o repasse ao locador)</small></legend>
            <div className="grade-3">
              <label className="campo">Banco<input placeholder="Ex.: 001 Banco do Brasil" value={campos.banco} onChange={mudar("banco")} /></label>
              <label className="campo">Agência<input value={campos.agencia} onChange={mudar("agencia")} /></label>
              <label className="campo">Conta<input value={campos.conta} onChange={mudar("conta")} /></label>
              <label className="campo">Tipo de conta
                <select value={campos.conta_tipo} onChange={mudar("conta_tipo")}><option value="">—</option><option value="corrente">Corrente</option><option value="poupanca">Poupança</option></select>
              </label>
              <label className="campo">Tipo de chave PIX
                <select value={campos.pix_tipo} onChange={mudar("pix_tipo")}><option value="">—</option><option value="cpf_cnpj">CPF/CNPJ</option><option value="telefone">Telefone</option><option value="email">E-mail</option><option value="aleatoria">Aleatória</option></select>
              </label>
              <label className="campo">Chave PIX<input value={campos.pix_chave} onChange={mudar("pix_chave")} /></label>
            </div>
          </fieldset>

          <fieldset className="painel formulario" id="p-papeis">
            <legend>Papéis</legend>
            <div className="participantes-opcoes">
              {PAPEIS.map(([v, n]) => (
                <label key={v} className={`participante-opcao${campos.papeis.includes(v) ? " marcado" : ""}`}>
                  <input type="checkbox" checked={campos.papeis.includes(v)} onChange={(e) => setCampos((c) => ({ ...c, papeis: e.target.checked ? [...c.papeis, v] : c.papeis.filter((x) => x !== v) }))} />
                  {n}
                </label>
              ))}
            </div>
            <label className="campo">Observações<textarea rows={3} value={campos.observacoes} onChange={mudar("observacoes")} /></label>
          </fieldset>

          <div className="painel" id="p-imoveis">
            <h3 style={{ marginTop: 0 }}>Imóveis em que é locador</h3>
            {dados.imoveis.length === 0 ? <p className="mudo pequeno" style={{ margin: 0 }}>Nenhum. Os locadores são informados na tela Imóveis administrados.</p> : (
              <ul className="lista">
                {dados.imoveis.map((i) => (
                  <li key={i.imovel_codigo}>
                    <button type="button" className="link-botao" onClick={() => ir("administrados", i.imovel_codigo)}>
                      {i.imoveis_locacao?.imoveis?.referencia ?? i.imovel_codigo}
                    </button>{" "}
                    <span className="mudo pequeno">{[i.imoveis_locacao?.imoveis?.tipo, i.imoveis_locacao?.imoveis?.bairro].filter(Boolean).join(" · ")} · {percentual(i.percentual)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <Erro mensagem={erroSalvar} />
          <div className="barra-salvar">
            <span className="mudo pequeno">Atualizado em {dataHora(p.atualizado_em)}</span>
            <button type="submit" className="botao" disabled={ocupado}>{ocupado ? "Salvando…" : "Salvar cadastro"}</button>
          </div>
        </div>
      </form>
    </section>
  );
}

// Escolher uma pessoa já cadastrada (busca por nome ou CPF/CNPJ), ou cadastrar.
export function EscolherPessoa({ titulo = "Escolher pessoa", papel, aoFechar, aoEscolher }) {
  const [busca, setBusca] = useState("");
  const [nova, setNova] = useState(false);
  const { dados } = useCarregar(async () => exigir(await supabase.from("pessoas").select("id, nome, documento, papeis").eq("arquivada", false).order("nome").limit(5000)), []);
  const termo = semAcento(busca.trim());
  const digitos = soDigitos(busca);
  const achadas = useMemo(() => (dados ?? []).filter((p) => !termo || semAcento(p.nome).includes(termo) || (digitos.length >= 3 && p.documento.includes(digitos))).slice(0, 30), [dados, termo, digitos]);
  if (nova) return <NovaPessoa papelInicial={papel} aoFechar={() => setNova(false)} aoEscolher={(id) => aoEscolher(id)} />;
  return (
    <Janela titulo={titulo} aoFechar={aoFechar}>
      <div className="formulario">
        <input className="busca" autoFocus type="search" placeholder="Nome ou CPF/CNPJ" value={busca} onChange={(e) => setBusca(e.target.value)} />
        {!dados ? <Carregando /> : (
          <ul className="lista escolher-pessoa">
            {achadas.length === 0 && <li className="mudo pequeno">Ninguém encontrado.</li>}
            {achadas.map((p) => (
              <li key={p.id}>
                <button type="button" onClick={() => aoEscolher(p.id)}>
                  <b>{p.nome}</b>
                  <span className="mudo pequeno dado">{formatarDocumento(p.documento)}{p.papeis.length ? ` · ${p.papeis.map((x) => NOME_DO_PAPEL[x]).join(", ")}` : ""}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="atalhos" style={{ justifyContent: "space-between" }}>
          <button type="button" className="botao secundario" onClick={() => setNova(true)}>Cadastrar pessoa nova</button>
          <button type="button" className="botao secundario" onClick={aoFechar}>Cancelar</button>
        </div>
      </div>
    </Janela>
  );
}
