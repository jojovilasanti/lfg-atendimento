import { useState } from "react";
import { Carregando, Erro, nomeTipo, useCarregar } from "../comum.jsx";
import { useSessao } from "../sessao.jsx";
import { exigir, supabase } from "../supabase.js";

// Cliques no WhatsApp dos imóveis (hoje só os do site). O corretor vê os dos
// imóveis dele; o gestor vê tudo, por imóvel e por corretor (regra do banco).
export const NOME_DA_ORIGEM = { site: "Site", grupo_olx: "Portal (ZAP, Viva Real ou OLX)", zap: "ZAP Imóveis", vivareal: "Viva Real", olx: "OLX", chavesnamao: "Chaves na Mão", imovelweb: "Imovelweb" };
const PERIODOS = [[7, "7 dias"], [30, "30 dias"], [90, "90 dias"]];

export const quandoFoi = (data) =>
  new Date(data).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).replace(",", " às");
export const descricaoDoImovel = (i) => (i?.titulo?.trim() && i.titulo.length <= 70 ? i.titulo : `${nomeTipo(i?.tipo)} em ${i?.bairro ?? "—"}`);

function agrupar(lista, chave) {
  const grupos = new Map();
  for (const item of lista) {
    const id = chave(item);
    const grupo = grupos.get(id) ?? { id, itens: [] };
    grupo.itens.push(item);
    grupos.set(id, grupo);
  }
  return [...grupos.values()].sort((a, b) => b.itens.length - a.itens.length);
}

export default function CliquesWhatsapp({ voltar }) {
  const { souGestor } = useSessao();
  const [dias, setDias] = useState(30);
  const [visao, setVisao] = useState(souGestor ? "imovel" : "recentes");
  const { dados, erro } = useCarregar(async () => {
    const desde = new Date(Date.now() - dias * 86_400_000).toISOString();
    return exigir(
      await supabase
        .from("cliques_whatsapp")
        .select("id, imovel_codigo, origem, nome, telefone, lead_id, criado_em, corretor_id, imoveis(referencia, titulo, tipo, bairro), corretores(nome)")
        .gte("criado_em", desde)
        .order("criado_em", { ascending: false })
        .limit(5000),
    );
  }, [dias]);

  const cliques = dados ?? [];
  const porImovel = agrupar(cliques, (c) => c.imovel_codigo);
  const porCorretor = agrupar(cliques, (c) => c.corretor_id ?? "sem");
  const visoes = souGestor ? [["imovel", "Por imóvel"], ["corretor", "Por corretor"], ["recentes", "Todos"]] : [["recentes", "Todos"], ["imovel", "Por imóvel"]];

  return (
    <section className="vista" aria-labelledby="t-cliques">
      <button type="button" className="voltar" onClick={voltar}>← Imóveis</button>
      <div className="cabeca-vista">
        <div>
          <h2 id="t-cliques">Cliques no WhatsApp</h2>
          <p>{souGestor
            ? "Quantas vezes clientes abriram o WhatsApp a partir de cada imóvel. O corretor responsável é avisado na hora; sem corretor, os gestores."
            : "Clientes que abriram o WhatsApp a partir dos seus imóveis. Você recebe um aviso a cada um."}</p>
        </div>
      </div>

      <div className="filtros">
        <div className="chips">
          {visoes.map(([id, nome]) => <button key={id} type="button" className="filtro" aria-pressed={visao === id} onClick={() => setVisao(id)}>{nome}</button>)}
        </div>
        <select className="filtro-select" aria-label="Período" value={dias} onChange={(e) => setDias(Number(e.target.value))}>
          {PERIODOS.map(([n, nome]) => <option key={n} value={n}>Últimos {nome}</option>)}
        </select>
      </div>

      <Erro mensagem={erro} />
      {!dados ? <Carregando /> : cliques.length === 0 ? (
        <div className="vazio"><div><b>Nenhum clique nesse período</b><p>Quando um cliente tocar em "Quero saber mais" na página de um imóvel do site, ele aparece aqui.</p></div></div>
      ) : (
        <div className="painel">
          <p className="mudo pequeno" style={{ margin: "0 0 10px" }}>
            <b>{cliques.length}</b> clique{cliques.length === 1 ? "" : "s"} em {porImovel.length} imóve{porImovel.length === 1 ? "l" : "is"}
          </p>
          {visao === "imovel" && (
            <ul className="lista lista-cliques">
              {porImovel.map(({ id, itens }) => (
                <li key={id}>
                  <a className="linha-interessado" href={`#imoveis/${id}`}>
                    <span className="linha-clique">
                      <b>{itens[0].imoveis?.referencia ?? id}</b>
                      <span className="mudo pequeno">{descricaoDoImovel(itens[0].imoveis)} · {itens[0].corretores?.nome ?? "sem corretor"} · último em {quandoFoi(itens[0].criado_em)}</span>
                    </span>
                    <span className="etiqueta pendente">{itens.length}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
          {visao === "corretor" && (
            <ul className="lista lista-cliques">
              {porCorretor.map(({ id, itens }) => (
                <li key={id} className="linha-interessado">
                  <span className="linha-clique">
                    <b>{itens[0].corretores?.nome ?? "Sem corretor (avisa os gestores)"}</b>
                    <span className="mudo pequeno">{new Set(itens.map((c) => c.imovel_codigo)).size} imóve{new Set(itens.map((c) => c.imovel_codigo)).size === 1 ? "l" : "is"} · último em {quandoFoi(itens[0].criado_em)}</span>
                  </span>
                  <span className="etiqueta pendente">{itens.length}</span>
                </li>
              ))}
            </ul>
          )}
          {visao === "recentes" && (
            <ul className="lista lista-cliques">
              {cliques.slice(0, 300).map((c) => (
                <li key={c.id}>
                  <a className="linha-interessado" href={c.lead_id ? `#leads/${c.lead_id}` : `#imoveis/${c.imovel_codigo}`}>
                    <span className="linha-clique">
                      <b>{c.imoveis?.referencia} · {descricaoDoImovel(c.imoveis)}</b>
                      <span className="mudo pequeno">
                        {quandoFoi(c.criado_em)} · {NOME_DA_ORIGEM[c.origem] ?? c.origem}
                        {souGestor ? ` · ${c.corretores?.nome ?? "sem corretor"}` : ""}
                        {c.nome || c.telefone ? ` · ${[c.nome, c.telefone].filter(Boolean).join(", ")}` : ""}
                      </span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
