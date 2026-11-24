// Empreendimentos: lançamentos que aparecem no site, em /empreendimentos/.
// Gestor e administrativo cadastram e editam. O site muda em cerca de 1 minuto.
import { useEffect, useState } from "react";
import { BotaoFechar, Carregando, Erro, Interruptor, reais, useCarregar } from "../comum.jsx";
import { enviarImagemDoSite } from "../imagensDoSite.js";
import { semAcento } from "../imoveis.js";
import { useSessao } from "../sessao.jsx";
import { exigir, mensagemDeErro, supabase } from "../supabase.js";

export const STATUS_DO_EMPREENDIMENTO = {
  lancamento: "Lançamento",
  breve_lancamento: "Breve lançamento",
  em_obras: "Em obras",
  pronto: "Pronto para morar",
  ultimas_unidades: "Últimas unidades",
};
export const TIPOS_DE_EMPREENDIMENTO = {
  loteamento: "Loteamento",
  apartamento: "Apartamentos",
  casa_condominio: "Casas em condomínio",
  comercial: "Comercial",
  outro: "Outro",
};
const SITE_PADRAO = "https://site.lfg.jojodigitals.com";

const VAZIO = {
  id: null, slug: "", nome: "", construtora: "", tipo: "loteamento", status: "lancamento", bairro: "", endereco: "",
  cidade: "Campo Grande", uf: "MS", previsao_entrega: "", metragens: "", preco_a_partir: "", resumo: "", descricao: "",
  lazer: [], diferenciais: [], fotos: [], plantas: [], video_url: "", latitude: "", longitude: "", link_oficial: "",
  campanha_ia_id: "", ativo: true, ordem: 0,
};

export const slugDe = (texto) => semAcento(texto).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
const linhas = (texto) => String(texto ?? "").split("\n").map((l) => l.trim()).filter(Boolean);

export default function Empreendimentos() {
  const { versao, recarregar } = useSessao();
  const { dados, erro } = useCarregar(async () => {
    const [lista, campanhas, site] = await Promise.all([
      supabase.from("empreendimentos").select("*").order("ordem").order("nome"),
      supabase.from("campanhas_ia").select("id, nome").order("nome"),
      supabase.from("configuracoes").select("valor").eq("chave", "site").maybeSingle(),
    ]);
    return {
      lista: exigir(lista),
      campanhas: campanhas.data ?? [],
      endereco: (site.data?.valor?.endereco_site || SITE_PADRAO).replace(/\/$/, ""),
    };
  }, [versao]);
  const [aberto, setAberto] = useState(null); // id, "novo" ou null

  if (!dados) return <section className="vista"><Erro mensagem={erro} /><Carregando /></section>;
  const atual = aberto === "novo" ? VAZIO : dados.lista.find((m) => m.id === aberto);

  if (atual) {
    return (
      <EditarEmpreendimento
        key={atual.id ?? "novo"}
        empreendimento={atual}
        campanhas={dados.campanhas}
        endereco={dados.endereco}
        aoFechar={() => setAberto(null)}
        aoSalvar={(id) => { recarregar(); setAberto(id); }}
        aoApagar={() => { recarregar(); setAberto(null); }}
      />
    );
  }

  return (
    <section className="vista larga" aria-labelledby="t-emp">
      <div className="cabeca-vista">
        <div>
          <h2 id="t-emp">Empreendimentos</h2>
          <p>Lançamentos que aparecem no site, com página própria e formulário de interesse. O site muda em cerca de 1 minuto depois de salvar.</p>
        </div>
        <div className="acoes-cabeca">
          <a className="botao secundario pequeno" href={`${dados.endereco}/empreendimentos/`} target="_blank" rel="noopener noreferrer">Ver no site</a>
          <button type="button" className="botao acao-principal" onClick={() => setAberto("novo")}>Novo empreendimento</button>
        </div>
      </div>
      <Erro mensagem={erro} />
      {!dados.lista.length ? (
        <div className="painel"><p className="mudo" style={{ margin: 0 }}>Nenhum empreendimento cadastrado ainda.</p></div>
      ) : (
        <ul className="cartoes-emp">
          {dados.lista.map((m) => (
            <li key={m.id}>
              <button type="button" className="cartao-emp-painel" onClick={() => setAberto(m.id)}>
                <span className="foto-emp">{m.fotos?.[0] ? <img src={m.fotos[0]} alt="" loading="lazy" /> : <span className="mudo pequeno">Sem foto</span>}</span>
                <span className="corpo-emp">
                  <b>{m.nome}</b>
                  <span className="mudo pequeno">{[TIPOS_DE_EMPREENDIMENTO[m.tipo], m.bairro, m.construtora].filter(Boolean).join(" · ")}</span>
                  <span className="etiquetas-emp">
                    <span className="etiqueta pronto">{STATUS_DO_EMPREENDIMENTO[m.status]}</span>
                    {!m.ativo && <span className="etiqueta pendente">Fora do site</span>}
                    {m.preco_a_partir && <span className="mudo pequeno">A partir de {reais(m.preco_a_partir)}</span>}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function EditarEmpreendimento({ empreendimento, campanhas, endereco, aoFechar, aoSalvar, aoApagar }) {
  const novo = !empreendimento.id;
  const [c, setC] = useState(() => ({
    ...VAZIO,
    ...Object.fromEntries(Object.entries(empreendimento).map(([k, v]) => [k, v ?? VAZIO[k] ?? ""])),
    lazerTexto: (empreendimento.lazer ?? []).join("\n"),
    diferenciaisTexto: (empreendimento.diferenciais ?? []).join("\n"),
  }));
  const [slugManual, setSlugManual] = useState(!novo);
  const [ocupado, setOcupado] = useState(false);
  const [aviso, setAviso] = useState(null);
  const mudar = (campo) => (e) => setC((atual) => ({ ...atual, [campo]: e.target.value }));

  // Endereço da página acompanha o nome enquanto ninguém mexer nele.
  useEffect(() => {
    if (!slugManual) setC((atual) => ({ ...atual, slug: slugDe(atual.nome) }));
  }, [c.nome, slugManual]);

  async function salvar(evento) {
    evento.preventDefault();
    setOcupado(true);
    setAviso(null);
    try {
      const { lazerTexto, diferenciaisTexto, ...resto } = c;
      const id = exigir(await supabase.rpc("salvar_empreendimento", {
        p_id: c.id,
        p_dados: {
          ...resto,
          preco_a_partir: String(c.preco_a_partir ?? "").replace(/\./g, "").replace(",", ".").replace(/[^\d.]/g, ""),
          latitude: String(c.latitude ?? "").replace(",", "."),
          longitude: String(c.longitude ?? "").replace(",", "."),
          lazer: linhas(lazerTexto),
          diferenciais: linhas(diferenciaisTexto),
        },
      }));
      setAviso(["ok", "Salvo. O site muda em cerca de 1 minuto."]);
      aoSalvar(id);
    } catch (e) {
      setAviso(["erro", mensagemDeErro(e)]);
    } finally {
      setOcupado(false);
    }
  }

  async function apagar() {
    if (!window.confirm(`Apagar o empreendimento ${c.nome}? Ele sai do site. Os leads que vieram dele continuam no sistema.`)) return;
    setOcupado(true);
    try {
      exigir(await supabase.rpc("apagar_empreendimento", { p_id: c.id }));
      aoApagar();
    } catch (e) {
      setAviso(["erro", mensagemDeErro(e)]);
      setOcupado(false);
    }
  }

  const pasta = `empreendimentos/${c.slug || "novo"}`;
  return (
    <section className="vista" aria-labelledby="t-editar-emp">
      <div className="linha-voltar">
        <button type="button" className="voltar" onClick={aoFechar}>← Empreendimentos</button>
        <BotaoFechar aoFechar={aoFechar} rotulo="Fechar e voltar para Empreendimentos" />
      </div>
      <div className="cabeca-vista">
        <div>
          <h2 id="t-editar-emp">{novo ? "Novo empreendimento" : c.nome}</h2>
          {!novo && <p><a href={`${endereco}/empreendimentos/${empreendimento.slug}/`} target="_blank" rel="noopener noreferrer">Abrir a página no site</a></p>}
        </div>
      </div>

      <form className="formulario" onSubmit={salvar}>
        <div className="painel formulario">
          <h3 style={{ margin: 0 }}>Dados principais</h3>
          <div className="grade-prazos">
            <label className="campo">Nome<input required minLength={2} maxLength={80} value={c.nome} onChange={mudar("nome")} placeholder="Atmosphere" /></label>
            <label className="campo">Construtora ou incorporadora<input maxLength={80} value={c.construtora} onChange={mudar("construtora")} placeholder="Plaenge" /></label>
          </div>
          <div className="grade-prazos">
            <label className="campo">Tipo
              <select value={c.tipo} onChange={mudar("tipo")}>
                {Object.entries(TIPOS_DE_EMPREENDIMENTO).map(([id, nome]) => <option key={id} value={id}>{nome}</option>)}
              </select>
            </label>
            <label className="campo">Etiqueta (selo)
              <select value={c.status} onChange={mudar("status")}>
                {Object.entries(STATUS_DO_EMPREENDIMENTO).map(([id, nome]) => <option key={id} value={id}>{nome}</option>)}
              </select>
            </label>
          </div>
          <label className="campo">Endereço da página <small className="mudo">({endereco.replace("https://", "")}/empreendimentos/<b>{c.slug || "…"}</b>/)</small>
            <input required maxLength={60} pattern="[a-z0-9]+(-[a-z0-9]+)*" value={c.slug} onChange={(e) => { setSlugManual(true); setC({ ...c, slug: slugDe(e.target.value) }); }} />
          </label>
          <div className="linha-interruptor">
            <Interruptor ligado={!!c.ativo} aoMudar={(v) => setC({ ...c, ativo: v })} rotulo={c.ativo ? "Tirar do site" : "Mostrar no site"} />
            <div><b className="pequeno">{c.ativo ? "Aparece no site" : "Fora do site"}</b></div>
            <label className="campo" style={{ marginLeft: "auto", maxWidth: 140 }}>Ordem<input type="number" min={0} max={999} value={c.ordem} onChange={mudar("ordem")} /></label>
          </div>
        </div>

        <div className="painel formulario">
          <h3 style={{ margin: 0 }}>Valores, tamanhos e entrega</h3>
          <div className="grade-prazos">
            <label className="campo">Tamanhos ou metragens<input maxLength={120} value={c.metragens} onChange={mudar("metragens")} placeholder="Lotes de 250 m² a 450 m²" /></label>
            <label className="campo">Previsão de entrega<input maxLength={80} value={c.previsao_entrega} onChange={mudar("previsao_entrega")} placeholder="Dezembro de 2027" /></label>
          </div>
          <label className="campo">Preço "a partir de" <small className="mudo">(opcional; vazio mostra "Consulte os valores")</small>
            <input inputMode="numeric" value={c.preco_a_partir} onChange={mudar("preco_a_partir")} placeholder="350000" />
          </label>
        </div>

        <div className="painel formulario">
          <h3 style={{ margin: 0 }}>Textos</h3>
          <label className="campo">Frase curta <small className="mudo">(aparece no card e na prévia do link no WhatsApp)</small>
            <input maxLength={220} value={c.resumo} onChange={mudar("resumo")} />
          </label>
          <label className="campo">Descrição<textarea rows={8} maxLength={8000} value={c.descricao} onChange={mudar("descricao")} /></label>
          <div className="grade-prazos">
            <label className="campo">Lazer <small className="mudo">(um item por linha)</small><textarea rows={7} value={c.lazerTexto} onChange={mudar("lazerTexto")} /></label>
            <label className="campo">Diferenciais <small className="mudo">(um item por linha)</small><textarea rows={7} value={c.diferenciaisTexto} onChange={mudar("diferenciaisTexto")} /></label>
          </div>
        </div>

        <div className="painel formulario">
          <h3 style={{ margin: 0 }}>Fotos, plantas e vídeo</h3>
          <ListaDeImagens rotulo="Fotos" dica="A primeira é a capa do card e da prévia do link. Até 40, com até 5 MB cada." urls={c.fotos} maximo={40} pasta={pasta} aoMudar={(fotos) => setC((atual) => ({ ...atual, fotos }))} aoFalhar={(m) => setAviso(["erro", m])} />
          <ListaDeImagens rotulo="Plantas" dica="Imagens das plantas (até 20)." urls={c.plantas} maximo={20} pasta={`${pasta}/plantas`} aoMudar={(plantas) => setC((atual) => ({ ...atual, plantas }))} aoFalhar={(m) => setAviso(["erro", m])} />
          <label className="campo">Vídeo <small className="mudo">(link do YouTube ou do Vimeo)</small><input type="url" value={c.video_url} onChange={mudar("video_url")} placeholder="https://www.youtube.com/watch?v=…" /></label>
          <label className="campo">Link oficial <small className="mudo">(site da construtora)</small><input type="url" value={c.link_oficial} onChange={mudar("link_oficial")} placeholder="https://" /></label>
        </div>

        <div className="painel formulario">
          <h3 style={{ margin: 0 }}>Localização</h3>
          <label className="campo">Endereço<input maxLength={200} value={c.endereco} onChange={mudar("endereco")} placeholder="Rua, número" /></label>
          <div className="grade-prazos">
            <label className="campo">Bairro<input maxLength={80} value={c.bairro} onChange={mudar("bairro")} /></label>
            <label className="campo">Cidade<input maxLength={80} value={c.cidade} onChange={mudar("cidade")} /></label>
          </div>
          <div className="grade-prazos">
            <label className="campo">Latitude <small className="mudo">(opcional)</small><input inputMode="decimal" value={c.latitude} onChange={mudar("latitude")} placeholder="-20.4697" /></label>
            <label className="campo">Longitude <small className="mudo">(opcional)</small><input inputMode="decimal" value={c.longitude} onChange={mudar("longitude")} placeholder="-54.6201" /></label>
          </div>
          <p className="mudo pequeno" style={{ margin: 0 }}>Sem latitude e longitude, o mapa do site usa o endereço. Para o ponto exato: no Google Maps, segure o dedo no local e copie os dois números.</p>
        </div>

        <div className="painel formulario">
          <h3 style={{ margin: 0 }}>Thais</h3>
          <label className="campo">Campanha da Thais <small className="mudo">(opcional)</small>
            <select value={c.campanha_ia_id ?? ""} onChange={mudar("campanha_ia_id")}>
              <option value="">Nenhuma</option>
              {campanhas.map((k) => <option key={k.id} value={k.id}>{k.nome}</option>)}
            </select>
          </label>
          <p className="mudo pequeno" style={{ margin: 0 }}>Quem vier deste empreendimento e conversar pelo WhatsApp é atendido pela Thais com as informações da campanha.</p>
        </div>

        {aviso && <p className={aviso[0] === "ok" ? "aviso-ok" : "aviso-erro"} role="status" style={{ margin: 0 }}>{aviso[1]}</p>}
        <div className="acoes-formulario">
          {!novo && <button type="button" className="botao perigo" disabled={ocupado} onClick={apagar}>Apagar</button>}
          <button type="button" className="botao secundario" onClick={aoFechar}>Voltar</button>
          <button type="submit" className="botao" disabled={ocupado}>{ocupado ? "Salvando…" : "Salvar"}</button>
        </div>
      </form>
    </section>
  );
}

// Fotos com envio de vários arquivos, ordem (mover) e remoção.
export function ListaDeImagens({ rotulo, dica, urls, maximo, pasta, aoMudar, aoFalhar }) {
  const [enviando, setEnviando] = useState(null);

  async function enviar(evento) {
    const arquivos = [...(evento.target.files ?? [])].slice(0, Math.max(0, maximo - urls.length));
    evento.target.value = "";
    if (!arquivos.length) return;
    const novas = [];
    try {
      for (const [n, arquivo] of arquivos.entries()) {
        setEnviando(`Enviando ${n + 1} de ${arquivos.length}…`);
        novas.push(await enviarImagemDoSite(arquivo, pasta));
      }
    } catch (e) {
      aoFalhar(mensagemDeErro(e));
    } finally {
      if (novas.length) aoMudar([...urls, ...novas]);
      setEnviando(null);
    }
  }
  const mover = (de, para) => {
    const lista = [...urls];
    const [item] = lista.splice(de, 1);
    lista.splice(para, 0, item);
    aoMudar(lista);
  };

  return (
    <div className="campo-imagens">
      <span className="rotulo">{rotulo} <small className="mudo">({urls.length})</small></span>
      <p className="mudo pequeno" style={{ margin: 0 }}>{dica}</p>
      {urls.length > 0 && (
        <ul className="miniaturas">
          {urls.map((url, n) => (
            <li key={url}>
              <img src={url} alt={`${rotulo} ${n + 1}`} loading="lazy" />
              {n === 0 && rotulo === "Fotos" && <span className="etiqueta pronto capa">Capa</span>}
              <div className="acoes-miniatura">
                <button type="button" aria-label={`Mover ${rotulo.toLowerCase()} ${n + 1} para antes`} disabled={n === 0} onClick={() => mover(n, n - 1)}>←</button>
                <button type="button" aria-label={`Mover ${rotulo.toLowerCase()} ${n + 1} para depois`} disabled={n === urls.length - 1} onClick={() => mover(n, n + 1)}>→</button>
                <button type="button" aria-label={`Tirar ${rotulo.toLowerCase()} ${n + 1}`} onClick={() => aoMudar(urls.filter((u) => u !== url))}>✕</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {urls.length < maximo && (
        <label className="botao secundario pequeno" style={{ alignSelf: "flex-start" }}>
          {enviando ?? `Enviar ${rotulo.toLowerCase()}`}
          <input type="file" accept="image/jpeg,image/png,image/webp" multiple className="invisivel" disabled={!!enviando} onChange={enviar} />
        </label>
      )}
    </div>
  );
}
