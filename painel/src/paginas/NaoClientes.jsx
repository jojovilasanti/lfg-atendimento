// Não clientes (gestor e administrativo): contatos que não são clientes da
// imobiliária — empresas e prestadores oferecendo produto ou serviço, e outros
// (vaga de emprego, corretor parceiro, engano, spam). Ficam fora do rodízio e
// do bolsão. Quem marcou fica registrado; o gestor pode reclassificar como cliente.
import { useState } from "react";
import { Carregando, dataHora, Erro, telefone, useCarregar } from "../comum.jsx";
import { useSessao } from "../sessao.jsx";
import { exigir, mensagemDeErro, supabase } from "../supabase.js";

export const CATEGORIAS = { empresa: "Empresa ou prestador", outros: "Outros" };

export default function NaoClientes() {
  const { eu, versao, recarregar } = useSessao();
  const souGestorPleno = eu.papel === "gestor";
  const { dados, erro } = useCarregar(async () => exigir(await supabase.rpc("nao_clientes")), [versao]);
  const [filtro, setFiltro] = useState("todos");
  const [aviso, setAviso] = useState(null);
  const [ocupado, setOcupado] = useState(null);

  async function ehCliente(c) {
    if (!window.confirm(`${c.nome ?? "Este contato"} é cliente? Ele volta para o fluxo normal e vai para o rodízio.`)) return;
    setOcupado(c.id);
    setAviso(null);
    try {
      exigir(await supabase.rpc("reclassificar_como_cliente", { p_lead_id: c.id }));
      setAviso(["ok", `${c.nome ?? "Contato"} voltou como cliente e foi para o rodízio.`]);
      recarregar();
    } catch (e) {
      setAviso(["erro", mensagemDeErro(e)]);
    } finally {
      setOcupado(null);
    }
  }

  if (!dados) return <section className="vista"><Erro mensagem={erro} /><Carregando /></section>;
  const lista = dados.filter((c) => filtro === "todos" || c.categoria === filtro || (filtro === "corretor" && c.marcado_por !== "Thais (triagem)"));
  const porCorretor = dados.reduce((m, c) => (c.marcado_por !== "Thais (triagem)" ? m.set(c.marcado_por, (m.get(c.marcado_por) ?? 0) + 1) : m), new Map());

  return (
    <section className="vista larga" aria-labelledby="t-nao-clientes">
      <div className="cabeca-vista">
        <div>
          <h2 id="t-nao-clientes">Não clientes</h2>
          <p>Empresas, prestadores e outros contatos que não procuram imóvel. Não entram no rodízio nem no bolsão. Quando um corretor marca, a vez dele no rodízio volta.</p>
        </div>
      </div>
      {aviso && <p className={aviso[0] === "ok" ? "aviso-ok" : "aviso-erro"} role="status" style={{ margin: 0 }}>{aviso[1]}</p>}
      <div className="filtros" role="group" aria-label="Filtrar">
        {[["todos", "Todos"], ["empresa", CATEGORIAS.empresa], ["outros", CATEGORIAS.outros], ["corretor", "Marcados por corretor"]].map(([id, nome]) => (
          <button key={id} type="button" className="filtro" aria-pressed={filtro === id} onClick={() => setFiltro(id)}>{nome}</button>
        ))}
      </div>
      {porCorretor.size > 0 && (
        <p className="mudo pequeno" style={{ margin: 0 }}>
          Marcados por corretor: {[...porCorretor.entries()].sort((a, b) => b[1] - a[1]).map(([nome, n]) => `${nome} (${n})`).join(", ")}
        </p>
      )}
      {!lista.length ? (
        <div className="painel"><p className="mudo" style={{ margin: 0 }}>Nenhum contato aqui.</p></div>
      ) : (
        <div className="tabela-caixa">
          <table>
            <thead><tr><th>Contato</th><th>Tipo</th><th>Motivo</th><th>Marcado por</th><th>Quando</th><th /></tr></thead>
            <tbody>
              {lista.map((c) => (
                <tr key={c.id}>
                  <td><b>{c.nome ?? "Sem nome"}</b><div className="mudo pequeno">{telefone(c.whatsapp)}</div></td>
                  <td>{CATEGORIAS[c.categoria] ?? c.categoria}</td>
                  <td className="pequeno">{c.motivo ?? "—"}{c.ultima_mensagem && <div className="mudo">“{c.ultima_mensagem.slice(0, 80)}”</div>}</td>
                  <td>{c.marcado_por}</td>
                  <td className="pequeno">{c.marcado_em ? dataHora(c.marcado_em) : "—"}</td>
                  <td>
                    {souGestorPleno && (
                      <div className="atalhos">
                        <a className="botao secundario pequeno" href={`#leads/${c.id}`}>Conversa</a>
                        <button type="button" className="botao pequeno" disabled={ocupado === c.id} onClick={() => ehCliente(c)}>É cliente</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
