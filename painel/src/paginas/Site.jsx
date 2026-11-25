import { useEffect, useMemo, useRef, useState } from "react";
import { Carregando, Erro, Interruptor, useCarregar } from "../comum.jsx";
import { useSessao } from "../sessao.jsx";
import {
  avisosDeCor, BOTOES_PADRAO, cor, CORES_PADRAO, corValida, FONTES, montarPrevia, NOME_DA_SECAO, opcoesDaAbertura, PAPEIS_DAS_CORES,
  secoesDaInicial, TEXTO_CONTATO_PADRAO,
} from "../siteTema.js";
import { exigir, mensagemDeErro, supabase } from "../supabase.js";
import BannersDoSite from "./BannersDoSite.jsx";

const ABAS = [
  ["aparencia", "Aparência"],
  ["abertura", "Abertura"],
  ["banners", "Banners"],
  ["inicial", "Página inicial"],
  ["textos", "Textos e botões"],
  ["contatos", "Dados e contatos"],
  ["publicacao", "Publicação"],
];
const LIMITE_IMAGEM = 5 * 1024 * 1024;
const ENDERECO_DO_SITE_PADRAO = "https://site.lfg.jojodigitals.com";
const DISPOSITIVOS = { computador: [1280, 860], celular: [390, 760] };
const COLUNAS_DAS_AMOSTRAS =
  "codigo, referencia, tipo, bairro, venda, locacao, valor_venda, valor_locacao, dormitorios, vagas, area_construida, area_util, area_terreno, foto_mini, foto_principal, fotos";

const linhas = (texto) => String(texto ?? "").split("\n").map((l) => l.trim()).filter(Boolean);

// O que vem do banco vira o formulário (listas viram texto, opções ganham o padrão).
function camposDoSite(valor) {
  return {
    ...valor,
    cores: { ...CORES_PADRAO, ...(valor.cores ?? {}) },
    fonte: FONTES[valor.fonte] ? valor.fonte : "moderna",
    abertura: { ...opcoesDaAbertura(valor), alinhamento: opcoesDaAbertura(valor).centro ? "centro" : "esquerda", mostrar_busca: opcoesDaAbertura(valor).busca },
    botoes: { ...(valor.botoes ?? {}) },
    textos: { ...(valor.textos ?? {}) },
    secoes: secoesDaInicial(valor),
    quantidade_destaques: Number(valor.quantidade_destaques) || 6,
    servicos: (valor.servicos ?? []).join("\n"),
    telefones: (valor.telefones ?? []).join("\n"),
    destaques: (valor.destaques ?? []).join(", "),
    redes_ligadas: { ...(valor.redes_ligadas ?? {}) },
    flutuantes: { whatsapp: valor.flutuantes?.whatsapp !== false, redes: valor.flutuantes?.redes !== false },
    mostrar_mapa: valor.mostrar_mapa !== false,
  };
}

// Redes do rodapé "Onde estamos" e da coluna flutuante: [campo, nome, exemplo].
const REDES = [
  ["facebook", "Facebook", "https://facebook.com/..."],
  ["instagram", "Instagram", "https://instagram.com/..."],
  ["youtube", "YouTube", "https://youtube.com/@..."],
  ["tiktok", "TikTok", "https://tiktok.com/@..."],
];

// E o formulário volta ao formato que o gerador lê.
function siteDosCampos(campos) {
  const semVazios = (objeto) => Object.fromEntries(Object.entries(objeto).map(([k, v]) => [k, String(v ?? "").trim()]).filter(([, v]) => v));
  const { escurecer, alinhamento, mostrar_busca } = campos.abertura;
  return {
    ...campos,
    whatsapp: String(campos.whatsapp ?? "").replace(/\D/g, ""),
    destaques: String(campos.destaques ?? "").split(/[\s,;]+/).map((r) => r.trim().toUpperCase()).filter(Boolean),
    servicos: linhas(campos.servicos),
    telefones: linhas(campos.telefones),
    cores: Object.fromEntries(Object.keys(CORES_PADRAO).map((c) => [c, cor(campos, c)])),
    abertura: { escurecer, alinhamento, mostrar_busca },
    botoes: semVazios(campos.botoes),
    textos: semVazios(campos.textos),
    secoes: campos.secoes.map(({ id, visivel, titulo }) => ({ id, visivel: visivel !== false, ...(titulo?.trim() ? { titulo: titulo.trim() } : {}) })),
  };
}

function CampoDeImagem({ rotulo, dica, url, aoMudar, aoFalhar }) {
  const [enviando, setEnviando] = useState(false);

  async function enviar(evento) {
    const arquivo = evento.target.files?.[0];
    evento.target.value = "";
    if (!arquivo) return;
    if (arquivo.size > LIMITE_IMAGEM) return aoFalhar("A imagem precisa ter até 5 MB.");
    setEnviando(true);
    try {
      const extensao = arquivo.type.split("/")[1] ?? "jpg";
      const caminho = `${rotulo.toLowerCase()}-${Date.now()}.${extensao}`;
      exigir(await supabase.storage.from("site").upload(caminho, arquivo, { contentType: arquivo.type }));
      aoMudar(supabase.storage.from("site").getPublicUrl(caminho).data.publicUrl);
    } catch (e) {
      aoFalhar(mensagemDeErro(e));
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="campo-imagem">
      <span className="rotulo">{rotulo}</span>
      {url ? <img src={url} alt={`${rotulo} atual do site`} /> : null}
      <p className="mudo pequeno" style={{ margin: 0 }}>{dica}</p>
      <div className="atalhos">
        <label className="botao secundario pequeno">
          {enviando ? "Enviando…" : url ? "Trocar" : "Enviar imagem"}
          <input type="file" accept="image/jpeg,image/png,image/webp" className="invisivel" disabled={enviando} onChange={enviar} />
        </label>
        {url && <button type="button" className="botao secundario pequeno" onClick={() => aoMudar("")}>Usar o padrão</button>}
      </div>
    </div>
  );
}

function CampoDeCor({ chave, rotulo, dica, valor, aoMudar }) {
  const [texto, setTexto] = useState(valor);
  useEffect(() => setTexto(valor), [valor]);
  return (
    <div className="campo-cor">
      <input type="color" aria-label={`Cor ${rotulo.toLowerCase()}`} value={corValida(valor) ? valor : CORES_PADRAO[chave]} onChange={(e) => aoMudar(e.target.value)} />
      <div>
        <b>{rotulo}</b>
        <span className="mudo pequeno">{dica}</span>
      </div>
      <input
        className="codigo-cor"
        aria-label={`Código da cor ${rotulo.toLowerCase()}`}
        value={texto}
        maxLength={7}
        onChange={(e) => {
          const novo = e.target.value.startsWith("#") ? e.target.value : `#${e.target.value}`;
          setTexto(novo);
          if (corValida(novo)) aoMudar(novo.toLowerCase());
        }}
      />
    </div>
  );
}

function Previa({ campos, amostras, equipe }) {
  const [dispositivo, setDispositivo] = useState("computador");
  const [largura, setLargura] = useState(0);
  const [html, setHtml] = useState("");
  const caixa = useRef(null);

  useEffect(() => {
    const observador = new ResizeObserver(([entrada]) => setLargura(entrada.contentRect.width));
    observador.observe(caixa.current);
    return () => observador.disconnect();
  }, []);

  // Espera a pessoa parar de digitar, para a prévia não piscar a cada letra.
  const { empresa } = useSessao();
  // Igual ao gerador do site: nome da empresa, e a logo dela quando a aba Site não tem uma própria.
  const site = useMemo(
    () => ({ ...siteDosCampos(campos), nome: empresa.nome, ...(campos.logo_url ? {} : { logo_url: empresa.logo_url ?? "" }) }),
    [campos, empresa],
  );
  useEffect(() => {
    const espera = setTimeout(() => {
      const endereco = (site.endereco_site || ENDERECO_DO_SITE_PADRAO).replace(/\/$/, "");
      setHtml(montarPrevia(site, amostras, endereco, equipe));
    }, 350);
    return () => clearTimeout(espera);
  }, [site, amostras, equipe]);

  const [w, h] = DISPOSITIVOS[dispositivo];
  const escala = largura ? Math.min(1, largura / w) : 0.4;
  return (
    <div className="previa-site">
      <div className="previa-cabeca">
        <b>Prévia</b>
        <div className="tema" role="group" aria-label="Tamanho da prévia">
          <button type="button" aria-pressed={dispositivo === "computador"} onClick={() => setDispositivo("computador")}>Computador</button>
          <button type="button" aria-pressed={dispositivo === "celular"} onClick={() => setDispositivo("celular")}>Celular</button>
        </div>
      </div>
      <div ref={caixa} className="previa-moldura" style={{ height: h * escala }}>
        <iframe
          title="Prévia da página inicial do site"
          sandbox=""
          srcDoc={html}
          style={{ width: w, height: h, transform: `scale(${escala})`, marginInline: w * escala < largura ? (largura - w * escala) / 2 : 0 }}
        />
      </div>
      <p className="mudo pequeno" style={{ margin: 0 }}>A prévia mostra a página inicial com o que está na tela, antes de salvar.</p>
    </div>
  );
}

export default function Site() {
  const { versao, empresa } = useSessao();
  const { dados, erro: erroAoCarregar } = useCarregar(async () => {
    const linha = exigir(await supabase.from("configuracoes").select("valor").eq("chave", "site").maybeSingle());
    const amostras = exigir(
      await supabase.from("imoveis").select(COLUNAS_DAS_AMOSTRAS).eq("ativo", true).order("atualizado_univen", { ascending: false, nullsFirst: false }).limit(300),
    );
    // Mesma ordem do site: gestores primeiro, depois por nome.
    const equipe = exigir(await supabase.from("corretores").select("nome, papel, creci, foto_url").eq("ativo", true).order("nome"))
      .sort((a, b) => (b.papel === "gestor") - (a.papel === "gestor"));
    return { valor: linha?.valor ?? {}, amostras, equipe };
  }, [versao]);
  const [campos, setCampos] = useState(null);
  const [salvoComo, setSalvoComo] = useState(null);
  const [aba, setAba] = useState("aparencia");
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState(null);
  const [aviso, setAviso] = useState(null);

  // Só preenche ao abrir: uma atualização em tempo real não apaga o que está sendo digitado.
  useEffect(() => {
    if (!dados || campos) return;
    const iniciais = camposDoSite(dados.valor);
    setCampos(iniciais);
    setSalvoComo(JSON.stringify(iniciais));
  }, [dados, campos]);

  const naoSalvo = campos && JSON.stringify(campos) !== salvoComo;
  useEffect(() => {
    if (!naoSalvo) return undefined;
    const avisar = (e) => e.preventDefault();
    window.addEventListener("beforeunload", avisar);
    return () => window.removeEventListener("beforeunload", avisar);
  }, [naoSalvo]);

  if (erroAoCarregar && !campos) return <section className="vista"><Erro mensagem={erroAoCarregar} /></section>;
  if (!campos) return <Carregando />;

  const alterar = (mudanca) => {
    setAviso(null);
    setCampos((atual) => ({ ...atual, ...mudanca(atual) }));
  };
  const mudar = (campo) => (e) => alterar(() => ({ [campo]: e.target.value }));
  const definir = (campo) => (valor) => alterar(() => ({ [campo]: valor }));
  const mudarEm = (grupo, campo) => (valor) => alterar((atual) => ({ [grupo]: { ...atual[grupo], [campo]: valor } }));
  const mudarSecao = (posicao, mudanca) => alterar((atual) => ({ secoes: atual.secoes.map((s, n) => (n === posicao ? { ...s, ...mudanca } : s)) }));
  const moverSecao = (de, para) =>
    alterar((atual) => {
      const secoes = [...atual.secoes];
      const [secao] = secoes.splice(de, 1);
      secoes.splice(para, 0, secao);
      return { secoes };
    });

  async function salvar() {
    setOcupado(true);
    setErro(null);
    setAviso(null);
    try {
      const valor = siteDosCampos(campos);
      if (!valor.nome?.trim()) throw new Error("Preencha o nome da imobiliária (em Dados e contatos).");
      if (!valor.titulo?.trim()) throw new Error("Preencha o título do banner.");
      for (const [nome, endereco] of [...REDES.map(([id, rede]) => [rede, valor[id]]), ["Endereço do site", valor.endereco_site]]) {
        if (endereco && !endereco.startsWith("https://")) throw new Error(`${nome} precisa começar com https://`);
      }
      if (!/^55\d{10,11}$/.test(valor.whatsapp)) throw new Error("Informe o WhatsApp com 55 e DDD, por exemplo 5567998206049 (em Dados e contatos).");
      let semEstoque = [];
      if (valor.destaques.length) {
        const achados = exigir(await supabase.from("imoveis").select("referencia").in("referencia", valor.destaques).eq("ativo", true));
        const ativos = new Set(achados.map((i) => i.referencia));
        semEstoque = valor.destaques.filter((r) => !ativos.has(r));
      }
      exigir(await supabase.from("configuracoes").update({ valor }).eq("chave", "site"));
      setSalvoComo(JSON.stringify(campos));
      setAviso(
        semEstoque.length
          ? `Salvo. O site muda em cerca de 1 minuto. Sem imóvel ativo com a referência: ${semEstoque.join(", ")}.`
          : "Salvo. O site muda em cerca de 1 minuto.",
      );
    } catch (e) {
      setErro(mensagemDeErro(e));
    } finally {
      setOcupado(false);
    }
  }

  const avisosDasCores = avisosDeCor(campos);
  const abertura = campos.abertura;
  const endereco = campos.endereco_site || ENDERECO_DO_SITE_PADRAO;

  return (
    <section className="vista larga" aria-labelledby="t-site">
      <div className="cabeca-vista">
        <div>
          <h2 id="t-site">Site</h2>
          <p>A aparência e os textos do site. Os imóveis entram e saem sozinhos, conforme o estoque.</p>
        </div>
        <div className="acoes-cabeca">
          <a className="botao secundario pequeno" href={endereco} target="_blank" rel="noopener noreferrer">Ver o site</a>
        </div>
      </div>

      <div className="editor-site">
        <div className="editor-site-campos">
          <div className="abas" role="tablist" aria-label="Partes do site">
            {ABAS.map(([id, nome]) => (
              <button key={id} type="button" role="tab" className="aba" aria-selected={aba === id} onClick={() => setAba(id)}>{nome}</button>
            ))}
          </div>

          {aba === "aparencia" && (
            <div className="painel formulario">
              <CampoDeImagem rotulo="Logo" dica="Só se o site precisar de uma logo diferente. Sem imagem aqui, o site usa a logo das Configurações gerais." url={campos.logo_url} aoMudar={definir("logo_url")} aoFalhar={setErro} />
              <h3>Cores</h3>
              <div className="lista-cores">
                {PAPEIS_DAS_CORES.map(([chave, rotulo, dica]) => (
                  <CampoDeCor key={chave} chave={chave} rotulo={rotulo} dica={dica} valor={campos.cores[chave]} aoMudar={mudarEm("cores", chave)} />
                ))}
              </div>
              {avisosDasCores.length > 0 && <ul className="lista-simples texto-alerta">{avisosDasCores.map((a) => <li key={a}>{a}</li>)}</ul>}
              <button type="button" className="link-botao pequeno" style={{ alignSelf: "flex-start" }} onClick={() => alterar(() => ({ cores: { ...CORES_PADRAO } }))}>Voltar às cores da LFG</button>
              <h3>Letras</h3>
              <div className="opcoes-radio" role="radiogroup" aria-label="Letras do site">
                {Object.entries(FONTES).map(([id, fonte]) => (
                  <label key={id} className={campos.fonte === id ? "marcado" : ""}>
                    <input type="radio" name="fonte" checked={campos.fonte === id} onChange={() => definir("fonte")(id)} />
                    <span><b>{fonte.nome}</b><br /><span className="mudo pequeno">{fonte.descricao}</span></span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {aba === "abertura" && (
            <div className="painel formulario">
              <CampoDeImagem rotulo="Banner" dica="Foto na horizontal, de pelo menos 1920 × 800 pixels. Sem imagem, usa a foto do primeiro imóvel em destaque." url={campos.banner_url} aoMudar={definir("banner_url")} aoFalhar={setErro} />
              <label className="campo">Escurecer a foto: {abertura.escurecer}%
                <input type="range" min={0} max={95} step={5} value={abertura.escurecer} onChange={(e) => mudarEm("abertura", "escurecer")(Number(e.target.value))} />
                <small className="mudo">Mais escuro deixa o título branco mais fácil de ler.</small>
              </label>
              <label className="campo">Título<input id="site-titulo" maxLength={80} value={campos.titulo ?? ""} onChange={mudar("titulo")} /></label>
              <label className="campo">Subtítulo<textarea id="site-subtitulo" rows={2} maxLength={200} value={campos.subtitulo ?? ""} onChange={mudar("subtitulo")} /></label>
              <h3>Posição do texto</h3>
              <div className="opcoes-radio" role="radiogroup" aria-label="Posição do texto do banner">
                {[["esquerda", "À esquerda"], ["centro", "No centro"]].map(([id, nome]) => (
                  <label key={id} className={abertura.alinhamento === id ? "marcado" : ""}>
                    <input type="radio" name="alinhamento" checked={abertura.alinhamento === id} onChange={() => mudarEm("abertura", "alinhamento")(id)} />{nome}
                  </label>
                ))}
              </div>
              <div className="linha-interruptor">
                <Interruptor ligado={abertura.mostrar_busca} aoMudar={mudarEm("abertura", "mostrar_busca")} rotulo="Mostrar a busca de imóveis no banner" />
                <div>
                  <b className="pequeno">Busca de imóveis no banner</b>
                  <p className="mudo pequeno" style={{ margin: 0 }}>Desligada, aparecem os botões Imóveis para comprar e Imóveis para alugar.</p>
                </div>
              </div>
              {abertura.mostrar_busca && (
                <label className="campo">Texto do botão da busca
                  <input maxLength={30} placeholder={BOTOES_PADRAO.busca} value={campos.botoes.busca ?? ""} onChange={(e) => mudarEm("botoes", "busca")(e.target.value)} />
                </label>
              )}
            </div>
          )}

          {aba === "inicial" && (
            <div className="painel formulario">
              <h3>Seções, na ordem em que aparecem</h3>
              <ol className="lista-secoes">
                {campos.secoes.map((secao, n) => (
                  <li key={secao.id} className={secao.visivel === false ? "escondida" : ""}>
                    <div className="secao-topo">
                      <div>
                        <b>{NOME_DA_SECAO[secao.id][0]}</b>
                        <span className="mudo pequeno">{NOME_DA_SECAO[secao.id][1]}</span>
                      </div>
                      <div className="atalhos">
                        <button type="button" className="botao secundario pequeno" aria-label={`Subir ${NOME_DA_SECAO[secao.id][0]}`} disabled={n === 0} onClick={() => moverSecao(n, n - 1)}>↑ Subir</button>
                        <button type="button" className="botao secundario pequeno" aria-label={`Descer ${NOME_DA_SECAO[secao.id][0]}`} disabled={n === campos.secoes.length - 1} onClick={() => moverSecao(n, n + 1)}>↓ Descer</button>
                        <Interruptor ligado={secao.visivel !== false} aoMudar={(ligado) => mudarSecao(n, { visivel: ligado })} rotulo={`Mostrar ${NOME_DA_SECAO[secao.id][0]}`} />
                      </div>
                    </div>
                    {secao.id !== "numeros" && secao.id !== "chamadas" && secao.visivel !== false && (
                      <label className="campo">Título da seção
                        <input maxLength={60} placeholder={secao.id === "sobre" ? `Sobre a ${campos.nome ?? ""}` : secao.id === "equipe" ? "Nossa equipe" : secao.id === "empreendimentos" ? "Lançamentos e empreendimentos" : secao.id === "bairros" ? "Bairros para começar" : "Imóveis em destaque"} value={secao.titulo ?? ""} onChange={(e) => mudarSecao(n, { titulo: e.target.value })} />
                      </label>
                    )}
                  </li>
                ))}
              </ol>
              <h3>Imóveis em destaque</h3>
              <label className="campo">Quantos mostrar
                <select value={campos.quantidade_destaques} onChange={(e) => definir("quantidade_destaques")(Number(e.target.value))}>
                  {[3, 6, 9, 12].map((n) => <option key={n} value={n}>{n} imóveis</option>)}
                </select>
              </label>
              <label className="campo">Escolher imóveis (referências separadas por vírgula)
                <input id="site-destaques" placeholder="CA00325, AP00054" value={campos.destaques} onChange={mudar("destaques")} />
                <small className="mudo">O que faltar é completado com os imóveis mais recentes que têm boas fotos.</small>
              </label>
            </div>
          )}

          {aba === "textos" && (
            <div className="painel formulario">
              <h3>Botões</h3>
              <div className="grade-2">
                {[["topo", "Botão do topo"], ["interesse", "Botão na página do imóvel"], ["sobre", "Botão da seção Sobre"], ["contato", "Botão da página de contato"]].map(([chave, rotulo]) => (
                  <label key={chave} className="campo">{rotulo}
                    <input maxLength={30} placeholder={BOTOES_PADRAO[chave]} value={campos.botoes[chave] ?? ""} onChange={(e) => mudarEm("botoes", chave)(e.target.value)} />
                  </label>
                ))}
              </div>
              <p className="mudo pequeno" style={{ margin: 0 }}>Todos os botões abrem o WhatsApp do atendimento, onde a Thais responde. Em branco, fica o texto de exemplo.</p>
              <h3>Sobre a imobiliária</h3>
              <label className="campo">Texto (deixe uma linha em branco entre os parágrafos)<textarea id="site-sobre" rows={6} value={campos.sobre ?? ""} onChange={mudar("sobre")} /></label>
              <label className="campo">Serviços (um por linha)<textarea id="site-servicos" rows={4} value={campos.servicos} onChange={mudar("servicos")} /></label>
              <h3>Outros textos</h3>
              <label className="campo">Descrição para o Google
                <textarea rows={2} maxLength={160} placeholder={campos.subtitulo} value={campos.textos.descricao_google ?? ""} onChange={(e) => mudarEm("textos", "descricao_google")(e.target.value)} />
                <small className="mudo">{(campos.textos.descricao_google ?? "").length} de 160. É o texto que aparece embaixo do nome do site na busca. Em branco, usa o subtítulo do banner.</small>
              </label>
              <label className="campo">Texto da página de contato
                <textarea rows={2} placeholder={TEXTO_CONTATO_PADRAO} value={campos.textos.contato ?? ""} onChange={(e) => mudarEm("textos", "contato")(e.target.value)} />
              </label>
              <label className="campo">Frase do rodapé (opcional)
                <input maxLength={120} value={campos.textos.rodape ?? ""} onChange={(e) => mudarEm("textos", "rodape")(e.target.value)} />
              </label>
            </div>
          )}

          {aba === "contatos" && (
            <div className="painel formulario">
              <div className="grade-2">
                <label className="campo">Nome da imobiliária<input id="site-nome" value={empresa.nome} readOnly aria-describedby="site-nome-dica" /><span id="site-nome-dica" className="mudo pequeno">Muda em Configurações → Configurações gerais.</span></label>
                <label className="campo">CRECI<input id="site-creci" value={campos.creci ?? ""} onChange={mudar("creci")} /></label>
                <label className="campo">WhatsApp do atendimento<input id="site-whatsapp" inputMode="tel" value={campos.whatsapp ?? ""} onChange={mudar("whatsapp")} /></label>
                <label className="campo">E-mail<input id="site-email" type="email" value={campos.email ?? ""} onChange={mudar("email")} /></label>
                <label className="campo">CNPJ<input id="site-cnpj" inputMode="numeric" placeholder="00.000.000/0000-00" value={campos.cnpj ?? ""} onChange={mudar("cnpj")} /></label>
              </div>
              <label className="campo">Telefones (um por linha)<textarea id="site-telefones" rows={2} value={campos.telefones} onChange={mudar("telefones")} /><span className="mudo pequeno">Celular (com 9 depois do DDD) abre o WhatsApp no site; fixo abre a ligação.</span></label>
              <label className="campo">Endereço do escritório<input id="site-escritorio" value={campos.endereco ?? ""} onChange={mudar("endereco")} /><span className="mudo pequeno">O mapa e o botão "Como chegar" do rodapé saem deste endereço. Coloque rua, número, bairro, cidade e CEP.</span></label>
              <label className="campo">Horário<input id="site-horario" value={campos.horario ?? ""} onChange={mudar("horario")} /></label>
              <div className="linha-interruptor">
                <Interruptor ligado={campos.mostrar_mapa} aoMudar={definir("mostrar_mapa")} rotulo="Mostrar o mapa no rodapé" />
                <div>
                  <b className="pequeno">Mapa no rodapé "Onde estamos"</b>
                  <p className="mudo pequeno" style={{ margin: 0 }}>Mapa do Google com o pino no endereço do escritório.</p>
                </div>
              </div>
              <p className="mudo pequeno" style={{ margin: 0 }}>Os botões do site abrem uma conversa neste WhatsApp com a referência do imóvel, e a Thais atende.</p>
            </div>
          )}

          {aba === "contatos" && (
            <div className="painel formulario">
              <h3 style={{ margin: 0 }}>Redes sociais</h3>
              <p className="mudo pequeno" style={{ margin: 0 }}>Aparecem no rodapé e na coluna da lateral do site. Rede sem link ou desligada não aparece.</p>
              {REDES.map(([id, nome, exemplo]) => (
                <div key={id} className="linha-rede">
                  <Interruptor ligado={campos.redes_ligadas[id] !== false} aoMudar={(ligado) => mudarEm("redes_ligadas", id)(ligado)} rotulo={`Mostrar ${nome} no site`} />
                  <label className="campo">{nome} (link)<input id={`site-${id}`} type="url" placeholder={exemplo} value={campos[id] ?? ""} onChange={mudar(id)} /></label>
                </div>
              ))}
              <h3 style={{ margin: "8px 0 0" }}>Botões flutuantes</h3>
              <div className="linha-interruptor">
                <Interruptor ligado={campos.flutuantes.whatsapp} aoMudar={(ligado) => mudarEm("flutuantes", "whatsapp")(ligado)} rotulo="Mostrar o WhatsApp flutuante" />
                <div>
                  <b className="pequeno">WhatsApp no canto da tela</b>
                  <p className="mudo pequeno" style={{ margin: 0 }}>Botão verde redondo. Na página do imóvel a mensagem já leva o código; na página de cada corretor, abre o WhatsApp dele.</p>
                </div>
              </div>
              <div className="linha-interruptor">
                <Interruptor ligado={campos.flutuantes.redes} aoMudar={(ligado) => mudarEm("flutuantes", "redes")(ligado)} rotulo="Mostrar as redes na lateral" />
                <div>
                  <b className="pequeno">Redes na lateral direita</b>
                  <p className="mudo pequeno" style={{ margin: 0 }}>Só no computador. No celular fica escondida para não cobrir o conteúdo.</p>
                </div>
              </div>
              <label className="campo">Mensagem pronta do WhatsApp
                <input id="site-mensagem-whatsapp" maxLength={200} placeholder={`Olá! Vim pelo site da ${empresa.nome} e gostaria de mais informações.`} value={campos.mensagem_whatsapp ?? ""} onChange={mudar("mensagem_whatsapp")} />
              </label>
            </div>
          )}

          {aba === "publicacao" && (
            <div className="painel formulario">
              <label className="campo">Endereço do site
                <input id="site-endereco" type="url" placeholder="https://site.lfgimoveis.com.br" value={campos.endereco_site ?? ""} onChange={mudar("endereco_site")} />
              </label>
              <div className="linha-interruptor">
                <Interruptor ligado={!!campos.indexar} aoMudar={definir("indexar")} rotulo="Aparecer no Google" />
                <div>
                  <b className="pequeno">Aparecer no Google</b>
                  <p className="mudo pequeno" style={{ margin: 0 }}>Deixe desligado durante os testes. Ligue só quando este for o site oficial, para não competir com o site atual.</p>
                </div>
              </div>
              <p className="mudo pequeno" style={{ margin: 0 }}>Depois de salvar, o site muda em cerca de 1 minuto. Os imóveis vêm sozinhos do estoque: entram e saem conforme a situação Disponível.</p>
            </div>
          )}

          {aba === "banners" && <BannersDoSite whatsapp={campos.whatsapp} />}

          {aba !== "banners" && <>
          <Erro mensagem={erro} />
          {aviso && <p className="aviso-ok" role="status" style={{ margin: 0 }}>{aviso}</p>}
          <div className={`barra-salvar-site ${naoSalvo ? "pendente" : ""}`}>
            <span className="pequeno mudo">{naoSalvo ? "Há alterações que ainda não foram salvas." : "Tudo salvo."}</span>
            <div className="atalhos">
              {naoSalvo && <button type="button" className="botao secundario" disabled={ocupado} onClick={() => setCampos(JSON.parse(salvoComo))}>Desfazer</button>}
              <button type="button" className="botao" disabled={ocupado || !naoSalvo} onClick={salvar}>{ocupado ? "Salvando…" : "Salvar e publicar"}</button>
            </div>
          </div>
          </>}
        </div>

        <aside className="editor-site-previa">
          <Previa campos={campos} amostras={dados.amostras} equipe={dados.equipe} />
        </aside>
      </div>
    </section>
  );
}
