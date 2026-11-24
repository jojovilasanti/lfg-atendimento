// Portais (só gestor): feeds XML gerados pelo próprio sistema, um por portal.
// Cada portal mostra situação, última atualização, quantos imóveis foram
// enviados, o link do feed, o botão para ligar e o "Atualizar agora". Embaixo,
// os imóveis que ficaram de fora (com o motivo) e o histórico.
import { useEffect, useState } from "react";
import { Carregando, dataHora, Erro, haQuanto, Interruptor, useCarregar } from "../comum.jsx";
import { useSessao } from "../sessao.jsx";
import { exigir, mensagemDeErro, supabase } from "../supabase.js";

const linkDoFeed = (p) => supabase.storage.from("feeds").getPublicUrl(`${p.token}/${p.arquivo}`).data.publicUrl;
const rodando = (p) => p.atualizando_desde && Date.now() - new Date(p.atualizando_desde).getTime() < 5 * 60000;

function situacao(p) {
  if (!p.formato) return ["Não integrado", "pendente"];
  if (!p.ativo) return ["Desligado", "pendente"];
  if (rodando(p)) return ["Atualizando…", "pendente"];
  if (p.ultimo_resultado === "erro") return ["Com erro", "alerta"];
  if (!p.ultima_atualizacao) return ["Ligado, aguardando a primeira atualização", "pendente"];
  return ["Integrado", "pronto"];
}

export default function Portais() {
  const { versao } = useSessao();
  const [rodada, setRodada] = useState(0);
  const { dados, erro } = useCarregar(async () => {
    const [portais, problemas, historico, equipe] = await Promise.all([
      supabase.from("portais").select("*").order("ordem"),
      supabase.from("portal_problemas").select("portal_id, imovel_codigo, motivos"),
      supabase.from("portal_atualizacoes").select("id, portal_id, iniciada_em, terminada_em, automatica, enviados, com_problema, resultado, mensagem, quem:corretores(nome)").order("iniciada_em", { ascending: false }).limit(20),
      supabase.from("corretores").select("nome, nome_no_univen").eq("ativo", true),
    ]);
    const listaProblemas = exigir(problemas);
    const codigos = [...new Set(listaProblemas.map((p) => p.imovel_codigo))];
    const imoveis = codigos.length ? exigir(await supabase.from("imoveis").select("codigo, referencia, tipo, bairro, captador").in("codigo", codigos)) : [];
    return { portais: exigir(portais), problemas: listaProblemas, historico: exigir(historico), imoveis: new Map(imoveis.map((i) => [i.codigo, i])), equipe: exigir(equipe) };
  }, [versao, rodada]);
  const [aviso, setAviso] = useState(null);
  const [ocupado, setOcupado] = useState(null);

  // Enquanto algum portal estiver atualizando, relê a cada 3 segundos.
  const algumRodando = dados?.portais.some(rodando);
  useEffect(() => {
    if (!algumRodando) return undefined;
    const relogio = setInterval(() => setRodada((n) => n + 1), 3000);
    return () => clearInterval(relogio);
  }, [algumRodando]);

  if (!dados) return <section className="vista"><Erro mensagem={erro} /><Carregando /></section>;

  async function chamar(funcao, parametros, chave, sucesso) {
    setOcupado(chave);
    setAviso(null);
    try {
      exigir(await supabase.rpc(funcao, parametros));
      if (sucesso) setAviso(["ok", sucesso]);
      setRodada((n) => n + 1);
    } catch (e) {
      setAviso(["erro", mensagemDeErro(e)]);
    } finally {
      setOcupado(null);
    }
  }
  async function copiar(texto) {
    try {
      await navigator.clipboard.writeText(texto);
      setAviso(["ok", "Link do feed copiado."]);
    } catch {
      setAviso(["erro", "Não deu para copiar. Selecione o link e copie."]);
    }
  }

  const ligados = dados.portais.filter((p) => p.ativo && p.formato);
  const nomeDoPortal = Object.fromEntries(dados.portais.map((p) => [p.id, p.nome]));

  return (
    <section className="vista larga" aria-labelledby="t-portais">
      <div className="cabeca-vista">
        <div>
          <h2 id="t-portais">Portais</h2>
          <p>Os feeds dos portais, gerados pelo sistema a partir do estoque. Atualizam sozinhos a cada hora; o portal lê o feed no horário dele (o Grupo OLX, a cada 12 horas).</p>
        </div>
        <div className="acoes-cabeca">
          <button type="button" className="botao" disabled={!ligados.length || algumRodando || !!ocupado}
            onClick={() => chamar("atualizar_portais", { p_portal: null }, "todos", "Atualização iniciada. O resultado aparece aqui em instantes.")}>
            {algumRodando ? "Atualizando…" : "Atualizar todos os portais"}
          </button>
        </div>
      </div>
      {aviso && <p className={aviso[0] === "ok" ? "aviso-ok" : "aviso-erro"} role="status" style={{ margin: 0 }}>{aviso[1]}</p>}
      <Erro mensagem={erro} />

      <ul className="cartoes-portais">
        {dados.portais.map((p) => {
          const [rotulo, cor] = situacao(p);
          const link = linkDoFeed(p);
          return (
            <li key={p.id} className="painel formulario">
              <div className="cabeca-portal">
                <div>
                  <h3 style={{ margin: 0 }}>{p.nome}</h3>
                  {p.descricao && <span className="mudo pequeno">{p.descricao}</span>}
                </div>
                <span className={`etiqueta ${cor}`}>{rotulo}</span>
              </div>
              {p.formato ? (
                <>
                  <div className="linha-interruptor">
                    <Interruptor ligado={p.ativo} desativado={!!ocupado} rotulo={p.ativo ? `Desligar ${p.nome}` : `Ligar ${p.nome}`}
                      aoMudar={(v) => chamar("ligar_portal", { p_id: p.id, p_ativo: v }, p.id, v ? `${p.nome} ligado. Clique em Atualizar agora para gerar o feed.` : `${p.nome} desligado: o feed para de ser atualizado.`)} />
                    <span className="pequeno">{p.ativo ? "Ligado: o feed é atualizado" : "Desligado"}</span>
                  </div>
                  <dl className="pares">
                    <dt>Última atualização</dt><dd>{p.ultima_atualizacao ? `${dataHora(p.ultima_atualizacao)} (${haQuanto(p.ultima_atualizacao)})` : "Ainda não gerado"}</dd>
                    <dt>Imóveis enviados</dt><dd><b>{p.enviados ?? "—"}</b></dd>
                    <dt>Ficaram de fora</dt><dd>{p.com_problema ?? "—"}</dd>
                  </dl>
                  {p.ultima_mensagem && <p className={`pequeno ${p.ultimo_resultado === "erro" ? "texto-alerta" : "mudo"}`} style={{ margin: 0 }}>{p.ultima_mensagem}</p>}
                  <label className="campo">Link do feed
                    <div className="linha-copiar">
                      <input readOnly value={link} onFocus={(e) => e.target.select()} />
                      <button type="button" className="botao secundario pequeno" onClick={() => copiar(link)}>Copiar</button>
                    </div>
                  </label>
                  <button type="button" className="botao secundario" style={{ alignSelf: "flex-start" }} disabled={!p.ativo || rodando(p) || !!ocupado}
                    onClick={() => chamar("atualizar_portais", { p_portal: p.id }, p.id, "Atualização iniciada.")}>
                    {rodando(p) ? "Atualizando…" : "Atualizar agora"}
                  </button>
                  <p className="mudo pequeno" style={{ margin: 0 }}>Quantos anúncios estão ativos no portal só aparece no painel dele (no Grupo OLX, o Canal Pro).</p>
                </>
              ) : (
                <p className="mudo pequeno" style={{ margin: 0 }}>Sem integração ainda: o formato do feed deste portal não é público. Peça a especificação ao atendimento do portal e mande para cá.</p>
              )}
            </li>
          );
        })}
      </ul>

      <div className="painel">
        <h3>Imóveis que ficaram de fora {dados.problemas.length > 0 && <span className="etiqueta alerta">{dados.problemas.length}</span>}</h3>
        {!dados.problemas.length ? (
          <p className="mudo pequeno" style={{ margin: 0 }}>Nenhum imóvel com problema na última atualização.</p>
        ) : (
          <ul className="lista-problemas">
            {dados.problemas.map((pr) => {
              const i = dados.imoveis.get(pr.imovel_codigo);
              const chave = `${pr.portal_id}:${pr.imovel_codigo}`;
              return (
                <li key={chave}>
                  <div>
                    <b>{i?.referencia ?? pr.imovel_codigo}</b>{i?.bairro && <span className="mudo"> · {i.bairro}</span>}
                    <span className="mudo pequeno"> · {nomeDoPortal[pr.portal_id]}{i?.captador ? ` · captação de ${i.captador}` : ""}</span>
                    <div className="pequeno texto-alerta">{pr.motivos.join(", ")}</div>
                  </div>
                  <div className="atalhos">
                    <a className="botao secundario pequeno" href={`#imoveis/${pr.imovel_codigo}`}>Corrigir</a>
                    <button type="button" className="botao secundario pequeno" disabled={!!ocupado}
                      onClick={() => chamar("encaminhar_correcao_portal", { p_codigo: pr.imovel_codigo, p_motivos: pr.motivos.join(", ") }, chave, `Demanda criada para o captador corrigir o ${i?.referencia ?? "imóvel"}.`)}>
                      Mandar ao corretor
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <p className="mudo pequeno" style={{ margin: "10px 0 0" }}>CEP e título se corrigem na ficha do imóvel, em "Ajustes para portais". Fotos, área, preço e descrição vêm do Univen e se corrigem lá.</p>
      </div>

      <div className="painel">
        <h3>Histórico</h3>
        {!dados.historico.length ? <p className="mudo pequeno" style={{ margin: 0 }}>Nenhuma atualização ainda.</p> : (
          <div className="tabela-rolagem">
            <table className="tabela">
              <thead><tr><th>Quando</th><th>Portal</th><th>Quem</th><th>Enviados</th><th>De fora</th><th>Resultado</th></tr></thead>
              <tbody>
                {dados.historico.map((h) => (
                  <tr key={h.id}>
                    <td>{dataHora(h.iniciada_em)}</td>
                    <td>{nomeDoPortal[h.portal_id]}</td>
                    <td>{h.automatica ? "Automática" : h.quem?.nome ?? "—"}</td>
                    <td>{h.enviados ?? "—"}</td>
                    <td>{h.com_problema ?? "—"}</td>
                    <td className={h.resultado === "erro" ? "texto-alerta" : ""}>{h.resultado ? h.mensagem : "Rodando…"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

// Na ficha do imóvel: CEP e título só para os portais (a leitura do Univen não apaga).
export function AjustesParaPortais({ imovel, podeEditar }) {
  const { versao } = useSessao();
  const [rodada, setRodada] = useState(0);
  const { dados, erro } = useCarregar(async () => exigir(await supabase.from("imoveis_ajustes_portal").select("cep, titulo, cep_automatico").eq("imovel_codigo", imovel.codigo).maybeSingle()) ?? {}, [imovel.codigo, versao, rodada]);
  const [cep, setCep] = useState(null);
  const [titulo, setTitulo] = useState(null);
  const [ocupado, setOcupado] = useState(false);
  const [aviso, setAviso] = useState(null);
  if (!dados) return null;
  const cepAtual = cep ?? dados.cep ?? (imovel.cep || "");
  const tituloAtual = titulo ?? dados.titulo ?? "";

  async function salvar(evento) {
    evento.preventDefault();
    setOcupado(true);
    setAviso(null);
    try {
      exigir(await supabase.rpc("salvar_ajuste_portal", { p_codigo: imovel.codigo, p_cep: cepAtual, p_titulo: tituloAtual }));
      setAviso(["ok", "Salvo. Vale na próxima atualização dos portais (até 1 hora)."]);
      setCep(null);
      setTitulo(null);
      setRodada((n) => n + 1);
    } catch (e) {
      setAviso(["erro", mensagemDeErro(e)]);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <form className="painel formulario" onSubmit={salvar}>
      <h3 style={{ margin: 0 }}>Ajustes para portais</h3>
      <Erro mensagem={erro} />
      <label className="campo">CEP {dados.cep_automatico && cep === null && <small className="mudo">(encontrado automaticamente; confira)</small>}
        <input inputMode="numeric" maxLength={9} placeholder="79000-000" value={cepAtual} disabled={!podeEditar} onChange={(e) => setCep(e.target.value)} />
      </label>
      <label className="campo">Título nos portais <small className="mudo">(10 a 100 letras; vazio: o sistema usa o do Univen ou monta um)</small>
        <input maxLength={100} value={tituloAtual} disabled={!podeEditar} onChange={(e) => setTitulo(e.target.value)} />
      </label>
      {aviso && <p className={aviso[0] === "ok" ? "aviso-ok" : "aviso-erro"} role="status" style={{ margin: 0 }}>{aviso[1]}</p>}
      {podeEditar && <button type="submit" className="botao secundario" style={{ alignSelf: "flex-start" }} disabled={ocupado}>{ocupado ? "Salvando…" : "Salvar ajustes"}</button>}
    </form>
  );
}
