// Site → Banners: carrossel do topo da página inicial. Cada banner tem imagem
// para computador e para celular, título, texto, botão e link. A lista é salva
// inteira, na ordem da tela. Sem banner ligado, o site mostra a abertura normal.
import { useEffect, useState } from "react";
import { Carregando, Erro, Interruptor, useCarregar } from "../comum.jsx";
import { enviarImagemDoSite } from "../imagensDoSite.js";
import { useSessao } from "../sessao.jsx";
import { exigir, mensagemDeErro, supabase } from "../supabase.js";

const NOVO = { ativo: true, imagem_url: "", imagem_celular_url: "", titulo: "", texto: "", botao: "", link: "" };
const chave = () => Math.random().toString(36).slice(2);

export default function BannersDoSite({ whatsapp }) {
  const { versao } = useSessao();
  const { dados, erro } = useCarregar(async () => {
    const [banners, emps] = await Promise.all([
      supabase.from("banners_site").select("*").order("ordem"),
      supabase.from("empreendimentos").select("slug, nome").eq("ativo", true).order("ordem"),
    ]);
    return { banners: exigir(banners), emps: exigir(emps) };
  }, [versao]);
  const [lista, setLista] = useState(null);
  const [salvoComo, setSalvoComo] = useState(null);
  const [ocupado, setOcupado] = useState(false);
  const [aviso, setAviso] = useState(null);

  useEffect(() => {
    if (!dados || lista) return;
    const iniciais = dados.banners.map((b) => ({ ...NOVO, ...Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v ?? ""])), chave: b.id }));
    setLista(iniciais);
    setSalvoComo(JSON.stringify(iniciais));
  }, [dados, lista]);

  if (!lista) return <><Erro mensagem={erro} /><Carregando /></>;
  const mudar = (n, mudanca) => { setAviso(null); setLista(lista.map((b, i) => (i === n ? { ...b, ...mudanca } : b))); };
  const mover = (de, para) => { const nova = [...lista]; const [b] = nova.splice(de, 1); nova.splice(para, 0, b); setLista(nova); };
  const naoSalvo = JSON.stringify(lista) !== salvoComo;
  const conversa = whatsapp ? `https://wa.me/${String(whatsapp).replace(/\D/g, "")}` : "";

  async function salvar() {
    setOcupado(true);
    setAviso(null);
    try {
      const semImagem = lista.findIndex((b) => !b.imagem_url);
      if (semImagem >= 0) throw new Error(`Banner ${semImagem + 1}: envie a imagem para computador.`);
      exigir(await supabase.rpc("salvar_banners", {
        p_banners: lista.map(({ ativo, imagem_url, imagem_celular_url, titulo, texto, botao, link }) => ({ ativo, imagem_url, imagem_celular_url, titulo, texto, botao, link })),
      }));
      setSalvoComo(JSON.stringify(lista));
      setAviso(["ok", "Banners salvos. O site muda em cerca de 1 minuto."]);
    } catch (e) {
      setAviso(["erro", mensagemDeErro(e)]);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="formulario">
      <div className="painel formulario">
        <p className="mudo pequeno" style={{ margin: 0 }}>
          Os banners ligados aparecem em carrossel no topo da página inicial, na ordem abaixo, e passam sozinhos a cada 6 segundos. A busca de imóveis fica logo embaixo. Sem nenhum banner ligado, o site mostra a abertura da aba Abertura.
        </p>
      </div>
      {lista.map((b, n) => (
        <div key={b.chave} className="painel formulario banner-painel">
          <div className="cabeca-banner">
            <b>Banner {n + 1}</b>
            <div className="atalhos">
              <button type="button" className="botao secundario pequeno" aria-label={`Subir o banner ${n + 1}`} disabled={n === 0} onClick={() => mover(n, n - 1)}>↑</button>
              <button type="button" className="botao secundario pequeno" aria-label={`Descer o banner ${n + 1}`} disabled={n === lista.length - 1} onClick={() => mover(n, n + 1)}>↓</button>
              <button type="button" className="botao secundario pequeno" onClick={() => setLista(lista.filter((_, i) => i !== n))}>Tirar</button>
            </div>
          </div>
          <div className="linha-interruptor">
            <Interruptor ligado={!!b.ativo} aoMudar={(v) => mudar(n, { ativo: v })} rotulo={b.ativo ? "Desligar o banner" : "Ligar o banner"} />
            <span className="pequeno">{b.ativo ? "Ligado: aparece no site" : "Desligado: não aparece"}</span>
          </div>
          <div className="grade-prazos">
            <ImagemDoBanner rotulo="Imagem para computador" dica="Horizontal, pelo menos 1920 × 670 pixels." url={b.imagem_url} aoMudar={(url) => mudar(n, { imagem_url: url })} aoFalhar={(m) => setAviso(["erro", m])} />
            <ImagemDoBanner rotulo="Imagem para celular" dica="Vertical, 1080 × 1350 pixels. Sem ela, o celular usa a de computador." url={b.imagem_celular_url} aoMudar={(url) => mudar(n, { imagem_celular_url: url })} aoFalhar={(m) => setAviso(["erro", m])} />
          </div>
          <label className="campo">Título <small className="mudo">(opcional)</small><input maxLength={90} value={b.titulo} onChange={(e) => mudar(n, { titulo: e.target.value })} /></label>
          <label className="campo">Texto curto <small className="mudo">(opcional)</small><input maxLength={200} value={b.texto} onChange={(e) => mudar(n, { texto: e.target.value })} /></label>
          <div className="grade-prazos">
            <label className="campo">Texto do botão <small className="mudo">(sem botão, o banner inteiro vira link)</small><input maxLength={40} value={b.botao} onChange={(e) => mudar(n, { botao: e.target.value })} placeholder="Conhecer" /></label>
            <label className="campo">Link <small className="mudo">(opcional)</small><input value={b.link} onChange={(e) => mudar(n, { link: e.target.value })} placeholder="/empreendimentos/atmosphere/ ou https://" /></label>
          </div>
          <div className="atalhos">
            <span className="mudo pequeno">Atalhos do link:</span>
            {dados.emps.map((m) => (
              <button key={m.slug} type="button" className="link-botao pequeno" onClick={() => mudar(n, { link: `/empreendimentos/${m.slug}/` })}>{m.nome}</button>
            ))}
            <button type="button" className="link-botao pequeno" onClick={() => mudar(n, { link: "/empreendimentos/" })}>Todos os empreendimentos</button>
            {conversa && <button type="button" className="link-botao pequeno" onClick={() => mudar(n, { link: conversa })}>WhatsApp da LFG</button>}
          </div>
        </div>
      ))}
      {lista.length < 12 && (
        <button type="button" className="botao secundario" style={{ alignSelf: "flex-start" }} onClick={() => setLista([...lista, { ...NOVO, chave: chave() }])}>+ Novo banner</button>
      )}
      {aviso && <p className={aviso[0] === "ok" ? "aviso-ok" : "aviso-erro"} role="status" style={{ margin: 0 }}>{aviso[1]}</p>}
      <div className={`barra-salvar-site ${naoSalvo ? "pendente" : ""}`}>
        <span className="pequeno mudo">{naoSalvo ? "Há alterações nos banners que ainda não foram salvas." : "Banners salvos."}</span>
        <div className="atalhos">
          {naoSalvo && <button type="button" className="botao secundario" disabled={ocupado} onClick={() => setLista(JSON.parse(salvoComo))}>Desfazer</button>}
          <button type="button" className="botao" disabled={ocupado || !naoSalvo} onClick={salvar}>{ocupado ? "Salvando…" : "Salvar banners"}</button>
        </div>
      </div>
    </div>
  );
}

function ImagemDoBanner({ rotulo, dica, url, aoMudar, aoFalhar }) {
  const [enviando, setEnviando] = useState(false);
  async function enviar(evento) {
    const arquivo = evento.target.files?.[0];
    evento.target.value = "";
    if (!arquivo) return;
    setEnviando(true);
    try {
      aoMudar(await enviarImagemDoSite(arquivo, "banners"));
    } catch (e) {
      aoFalhar(mensagemDeErro(e));
    } finally {
      setEnviando(false);
    }
  }
  return (
    <div className="campo-imagem">
      <span className="rotulo">{rotulo}</span>
      {url ? <img src={url} alt={rotulo} /> : null}
      <p className="mudo pequeno" style={{ margin: 0 }}>{dica}</p>
      <div className="atalhos">
        <label className="botao secundario pequeno">
          {enviando ? "Enviando…" : url ? "Trocar" : "Enviar imagem"}
          <input type="file" accept="image/jpeg,image/png,image/webp" className="invisivel" disabled={enviando} onChange={enviar} />
        </label>
        {url && <button type="button" className="botao secundario pequeno" onClick={() => aoMudar("")}>Tirar</button>}
      </div>
    </div>
  );
}
