import { Fragment, useEffect, useRef, useState } from "react";
import {
  BotaoFechar, Carregando, contagem, dataHora, Erro, EtiquetaPrazo, haQuanto, hora, iniciais, Interruptor, PRAZO_ATENCAO_LEAD, OPERACAO, reais, Situacao, telefone, Temperatura, TextoWhatsApp, useAgora, useCarregar, useEhCelular, useFecharAoTocarFora, useFecharComEsc,
} from "../comum.jsx";
import { Janela, NOME_DA_ETAPA, nomeDaOrigem } from "../crm.jsx";
import { EditarCliente, ImoveisCompativeis, Negociacao } from "./Negociacao.jsx";
import { useSessao } from "../sessao.jsx";
import { chamarPainel, exigir, mensagemDeErro, supabase } from "../supabase.js";
import { reduzirFoto } from "../imoveis.js";

const FILTROS = [
  ["todos", "Todos", () => true],
  ["em_atendimento_ia", "Com a IA", (l) => l.status === "em_atendimento_ia"],
  ["aguardando_corretor", "Aguardando corretor", (l) => l.status === "aguardando_corretor"],
  ["com_corretor", "Com corretor", (l) => l.status === "com_corretor"],
  ["encerrado", "Encerrados", (l) => l.status === "encerrado"],
];

const nomeLead = (l) => l.nome ?? "Cliente sem nome";
const ehTeste = (l) => l.whatsapp.startsWith("sim-");

export default function Leads({ leadAberto, abrirLead }) {
  if (leadAberto) return <Lead id={leadAberto} voltar={() => abrirLead(null)} />;
  return <ListaDeLeads abrirLead={abrirLead} />;
}

function ListaDeLeads({ abrirLead }) {
  const { versao } = useSessao();
  const [filtro, setFiltro] = useState("todos");
  const [busca, setBusca] = useState("");
  const [mostrarTestes, setMostrarTestes] = useState(false);
  // Origem: "c:<campanha>" para campanhas da Thais, "o:<origem>" para as demais.
  const [origem, setOrigem] = useState("todas");

  const { dados, erro } = useCarregar(async () => {
    const leads = exigir(
      await supabase
        .from("leads")
        .select("id, nome, whatsapp, origem, campanha, campanha_ia_id, status, temperatura, interesse, ficha, imovel_codigo, corretor_id, etapa, criado_em, ultima_mensagem, ultima_mensagem_autor, ultima_mensagem_em")
        .order("ultima_mensagem_em", { ascending: false, nullsFirst: false })
        .limit(300),
    );
    const equipe = exigir(await supabase.from("corretores").select("id, nome"));
    const campanhas = exigir(await supabase.from("campanhas_ia").select("id, origem").order("origem"));
    return { leads, nomes: new Map(equipe.map((c) => [c.id, c.nome])), campanhas };
  }, [versao]);

  const termo = busca.trim().toLowerCase();
  const base = (dados?.leads ?? []).filter((l) => mostrarTestes || !ehTeste(l));
  const [, , regra] = FILTROS.find(([id]) => id === filtro);
  // Pedido do formulário do site: "Site – Empreendimento X" tem filtro próprio.
  const chaveDaOrigem = (l) => (l.origem === "site" && l.campanha ? `s:${l.campanha}` : l.campanha_ia_id ? `c:${l.campanha_ia_id}` : `o:${l.origem ?? ""}`);
  const origens = [
    ...(dados?.campanhas ?? []).map((c) => [`c:${c.id}`, c.origem]),
    ...[...new Set(base.filter((l) => l.origem === "site" && l.campanha).map((l) => l.campanha))].map((c) => [`s:${c}`, c]),
    ...[...new Set(base.filter((l) => !l.campanha_ia_id && !(l.origem === "site" && l.campanha)).map((l) => l.origem ?? ""))].map((o) => [`o:${o}`, o ? nomeDaOrigem(o) : "Sem origem"]),
  ];
  const visiveis = base.filter(regra).filter((l) => origem === "todas" || chaveDaOrigem(l) === origem).filter((l) => !termo || `${l.nome ?? ""} ${l.whatsapp} ${l.ficha?.regiao ?? ""}`.toLowerCase().includes(termo));
  const testes = (dados?.leads ?? []).filter(ehTeste).length;

  return (
    <section className="vista" aria-labelledby="t-leads">
      <div className="cabeca-vista">
        <div>
          <h2 id="t-leads">Leads</h2>
          <p>Todo cliente que chegou, o que ele procura e com quem está agora. Abra um lead para ver a conversa e responder.</p>
        </div>
      </div>
      <div className="filtros">
        <div className="chips">
          {FILTROS.map(([id, texto, r]) => (
            <button key={id} type="button" className="filtro" aria-pressed={filtro === id} onClick={() => setFiltro(id)}>
              {texto} <b>{base.filter(r).length}</b>
            </button>
          ))}
          {testes > 0 && (
            <button type="button" className="filtro" aria-pressed={mostrarTestes} onClick={() => setMostrarTestes(!mostrarTestes)}>
              Testes do simulador <b>{testes}</b>
            </button>
          )}
        </div>
        <label className="campo campo-pessoa">
          <span className="invisivel">Origem</span>
          <select value={origem} onChange={(e) => setOrigem(e.target.value)}>
            <option value="todas">Todas as origens</option>
            {origens.map(([id, nome]) => <option key={id} value={id}>{nome}</option>)}
          </select>
        </label>
        <input className="busca" id="busca-leads" type="search" placeholder="Buscar por nome, número ou região" value={busca} onChange={(e) => setBusca(e.target.value)} />
      </div>
      <Erro mensagem={erro} />
      {dados === undefined ? <Carregando /> : (
        <div className="tabela-caixa">
          <table className="tabela-leads">
            <thead><tr><th>Lead</th><th>Operação</th><th>Última mensagem</th><th>Temperatura</th><th>Situação</th><th>Corretor</th></tr></thead>
            <tbody>
              {visiveis.length === 0 ? (
                <tr><td colSpan={6} className="mudo">Nenhum lead aqui ainda.</td></tr>
              ) : visiveis.map((l) => (
                <tr key={l.id} className="clicavel" tabIndex={0} onClick={() => abrirLead(l.id)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), abrirLead(l.id))}>
                  <td className="c-lead"><span className="forte">{nomeLead(l)}</span><span className="sub dado">{telefone(l.whatsapp)}{ehTeste(l) ? " · teste" : ""}</span></td>
                  <td className="c-operacao">{l.interesse ? OPERACAO[l.interesse] : "—"}<span className="sub">{l.imovel_codigo ? `#${l.imovel_codigo}` : l.ficha?.regiao ?? ""}</span></td>
                  <td className="c-mensagem"><span className="trecho">{l.ultima_mensagem ?? "—"}</span><span className="sub">{haQuanto(l.ultima_mensagem_em)}</span></td>
                  <td className="c-temperatura"><Temperatura valor={l.temperatura} /></td>
                  <td className="c-situacao"><Situacao status={l.status} />{l.etapa && <span className="sub">{NOME_DA_ETAPA[l.etapa]}</span>}</td>
                  <td className="c-corretor">{dados.nomes.get(l.corretor_id) ?? <span className="mudo">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const MOTIVO = {
  duvida_especifica: "dúvida que só o corretor resolve", quer_visitar: "quer visitar", pediu_atendente: "pediu um corretor", quer_negociar: "quer negociar",
  lead_quente: "lead quente", ficha_completa: "ficha completa", seguro_fianca: "quer dar entrada no seguro fiança", sem_opcoes: "sem imóvel compatível", quer_anunciar: "dono quer anunciar o imóvel", administrativo: "assunto administrativo", reclamacao: "reclamação", nao_verificado: "disponibilidade não verificada", outro: "outro motivo",
};
const RESULTADO = { sem_corretor_disponivel: "ninguém de plantão", oferecido: "oferecido ao corretor da vez", ja_oferecido: "já estava com um corretor", com_corretor: "já está com um corretor" };

// Situação do aviso que o corretor recebeu no WhatsApp ao ser oferecido o lead.
const AVISO = { enviado: "aviso enviado", sent: "aviso enviado", delivered: "aviso entregue", read: "aviso lido", sem_whatsapp: "sem WhatsApp no cadastro", simulado: "teste, sem aviso" };
const textoDoAviso = (status) => AVISO[status] ?? (status.startsWith("falhou") ? "aviso não saiu" : status);

const TIPOS_DE_MIDIA = new Set(["image", "audio", "video", "document"]);

// Documentos que o WhatsApp aceita (o tipo vem do nome quando o celular não informa).
const DOCUMENTOS = {
  pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain", csv: "text/csv",
};
const ACEITA_DOCUMENTOS = Object.keys(DOCUMENTOS).map((e) => `.${e}`).join(",");
const LIMITE_DOCUMENTO_MB = 15;

// Foto vira JPG de até 1600 px (fica leve e o WhatsApp aceita, inclusive as do
// iPhone); documento vai como está, se o tipo for aceito.
async function prepararAnexo(arquivo) {
  if (arquivo.type.startsWith("image/")) {
    const foto = await reduzirFoto(arquivo, 1600, 0.85).catch(() => {
      throw new Error("Não consegui abrir essa foto. Tente outra ou mande como documento.");
    });
    const nome = `${(arquivo.name || "foto").replace(/\.[^.]+$/, "")}.jpg`;
    return { arquivo: foto, nome, tipo: "image/jpeg", previa: URL.createObjectURL(foto) };
  }
  const extensao = (arquivo.name.split(".").pop() ?? "").toLowerCase();
  const tipo = DOCUMENTOS[extensao] ?? (Object.values(DOCUMENTOS).includes(arquivo.type) ? arquivo.type : null);
  if (!tipo) throw new Error("O WhatsApp não aceita esse tipo de arquivo. Envie PDF, Word, Excel, PowerPoint ou texto.");
  if (arquivo.size > LIMITE_DOCUMENTO_MB * 1024 * 1024) throw new Error(`Arquivo muito grande. O limite é de ${LIMITE_DOCUMENTO_MB} MB.`);
  return { arquivo, nome: arquivo.name, tipo, previa: null };
}

// Como a mensagem citada aparece: o texto, ou o tipo do arquivo.
function resumoDaCitacao(m) {
  const texto = m.conteudo?.replace(/\s+/g, " ").trim();
  const rotulo = { image: "📷 Foto", audio: "🎤 Áudio", video: "🎬 Vídeo", document: "📄 Documento" }[m.tipo];
  if (rotulo) return texto && m.tipo !== "audio" ? `${rotulo} · ${texto}` : rotulo;
  return texto || "Mensagem";
}

// Bolha que dá para responder citando: no celular, arrastar para a direita ou
// segurar o dedo e escolher "Responder"; no computador, a setinha ao passar o mouse.
function BolhaCitavel({ id, className, podeCitar, aoResponder, texto, children }) {
  const toque = useRef(null);
  const segurar = useRef(null);
  const [deslocamento, setDeslocamento] = useState(0);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef(null);
  useFecharComEsc(menu, () => setMenu(false));
  useFecharAoTocarFora(menuRef, menu, () => setMenu(false));
  const LIMITE = 56;

  const comecar = (e) => {
    if (!podeCitar) return;
    const t = e.touches[0];
    toque.current = { x: t.clientX, y: t.clientY, horizontal: null };
    segurar.current = setTimeout(() => {
      toque.current = null;
      setMenu(true);
      navigator.vibrate?.(15);
    }, 500);
  };
  const mover = (e) => {
    const inicio = toque.current;
    if (!inicio) return;
    const t = e.touches[0];
    const dx = t.clientX - inicio.x;
    const dy = t.clientY - inicio.y;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) clearTimeout(segurar.current);
    if (inicio.horizontal === null && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) inicio.horizontal = Math.abs(dx) > Math.abs(dy);
    if (inicio.horizontal && dx > 0) setDeslocamento(Math.min(dx, 84));
  };
  const terminar = () => {
    clearTimeout(segurar.current);
    if (deslocamento >= LIMITE) {
      navigator.vibrate?.(10);
      aoResponder();
    }
    setDeslocamento(0);
    toque.current = null;
  };

  return (
    <div
      id={id}
      className={`${className}${podeCitar ? " citavel" : ""}`}
      style={deslocamento ? { transform: `translateX(${deslocamento}px)`, transition: "none" } : undefined}
      onTouchStart={comecar}
      onTouchMove={mover}
      onTouchEnd={terminar}
      onTouchCancel={terminar}
      onContextMenu={(e) => {
        if (!podeCitar) return;
        e.preventDefault();
        setMenu(true);
      }}
    >
      {deslocamento > 0 && <span className={`seta-responder ${deslocamento >= LIMITE ? "pronta" : ""}`} aria-hidden="true">↩</span>}
      {children}
      {podeCitar && <button type="button" className="responder-bolha" aria-label="Responder a esta mensagem" onClick={aoResponder}>↩ Responder</button>}
      {menu && (
        <div className="menu-bolha" role="menu" ref={menuRef}>
          <button type="button" role="menuitem" onClick={() => { setMenu(false); aoResponder(); }}>Responder</button>
          {texto && <button type="button" role="menuitem" onClick={() => { navigator.clipboard?.writeText(texto).catch(() => {}); setMenu(false); }}>Copiar texto</button>}
          <button type="button" role="menuitem" onClick={() => setMenu(false)}>Fechar</button>
        </div>
      )}
    </div>
  );
}

// Áudio do corretor: o navegador grava no formato que souber e o servidor
// converte para mensagem de voz do WhatsApp.
const TIPOS_DE_GRAVACAO = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus", "audio/mp4", "audio/webm"];
const LIMITE_GRAVACAO_S = 5 * 60;
const relogioDaGravacao = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

const paraBase64 = (arquivo) =>
  new Promise((resolver, rejeitar) => {
    const leitor = new FileReader();
    leitor.onload = () => resolver(String(leitor.result).split(",")[1]);
    leitor.onerror = () => rejeitar(new Error("Não foi possível ler o áudio gravado."));
    leitor.readAsDataURL(arquivo);
  });

function useGravador() {
  const [gravando, setGravando] = useState(false);
  const [segundos, setSegundos] = useState(0);
  const gravador = useRef(null);
  const pedacos = useRef([]);
  const relogio = useRef(null);
  // Chamado quando a gravação chega ao limite (a tela manda o áudio sozinha).
  const aoAtingirLimite = useRef(null);

  const soltar = () => {
    clearInterval(relogio.current);
    gravador.current?.stream.getTracks().forEach((faixa) => faixa.stop());
    gravador.current = null;
    setGravando(false);
    setSegundos(0);
  };

  async function iniciar() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") throw new Error("Este navegador não grava áudio.");
    let microfone;
    try {
      microfone = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      throw new Error("Libere o microfone para o painel nas permissões do navegador.");
    }
    const tipo = TIPOS_DE_GRAVACAO.find((t) => MediaRecorder.isTypeSupported(t));
    const novo = new MediaRecorder(microfone, tipo ? { mimeType: tipo } : undefined);
    pedacos.current = [];
    novo.ondataavailable = (evento) => evento.data.size && pedacos.current.push(evento.data);
    novo.start(250);
    gravador.current = novo;
    setGravando(true);
    const inicio = Date.now();
    relogio.current = setInterval(() => {
      const passados = Math.floor((Date.now() - inicio) / 1000);
      setSegundos(passados);
      if (passados >= LIMITE_GRAVACAO_S) {
        clearInterval(relogio.current);
        aoAtingirLimite.current?.();
      }
    }, 250);
  }

  // Para e devolve o arquivo gravado.
  function terminar() {
    const atual = gravador.current;
    if (!atual) return Promise.resolve(null);
    return new Promise((resolver) => {
      atual.onstop = () => {
        const arquivo = new Blob(pedacos.current, { type: atual.mimeType || "audio/webm" });
        soltar();
        resolver(arquivo);
      };
      atual.stop();
    });
  }

  function cancelar() {
    const atual = gravador.current;
    if (atual) {
      atual.onstop = null;
      atual.stop();
    }
    soltar();
  }

  // Saiu da tela gravando: desliga o microfone.
  useEffect(() => () => {
    gravador.current?.stream.getTracks().forEach((faixa) => faixa.stop());
    clearInterval(relogio.current);
  }, []);

  return { gravando, segundos, iniciar, terminar, cancelar, aoAtingirLimite };
}

// Os arquivos ficam num bucket privado: cada um ganha um endereço que vale 1 hora.
// O endereço fica guardado para a foto não piscar a cada recarga da conversa.
const enderecosDeMidia = new Map();
async function enderecosDasMidias(mensagens) {
  const agora = Date.now();
  const caminhos = mensagens.filter((m) => m.midia_url).map((m) => m.midia_url);
  const faltando = caminhos.filter((c) => !(enderecosDeMidia.get(c)?.expira > agora));
  if (faltando.length) {
    const assinados = exigir(await supabase.storage.from("midias").createSignedUrls(faltando, 3600));
    for (const a of assinados) if (a.signedUrl) enderecosDeMidia.set(a.path, { url: a.signedUrl, expira: agora + 50 * 60 * 1000 });
  }
  return new Map(caminhos.map((c) => [c, enderecosDeMidia.get(c)?.url]));
}

function Midia({ m, url }) {
  if (!m.midia_url) return <span className="midia-aviso">{m.midia_tipo ? "Recebendo arquivo…" : "Não foi possível baixar o arquivo."}</span>;
  if (!url) return <span className="midia-aviso">Arquivo indisponível no momento.</span>;
  const tipo = m.midia_tipo ?? "";
  if (tipo.startsWith("image/")) {
    return <a href={url} target="_blank" rel="noopener noreferrer"><img className="midia-foto" src={url} alt={m.autor === "cliente" ? "Foto enviada pelo cliente" : "Foto enviada ao cliente"} loading="lazy" /></a>;
  }
  if (tipo.startsWith("audio/")) return <audio className="midia-audio" controls preload="none" src={url} />;
  if (tipo.startsWith("video/")) return <video className="midia-video" controls preload="metadata" src={url} />;
  const extensao = (m.midia_url ?? "").split(".").pop()?.toUpperCase();
  return <a className="midia-documento" href={url} target="_blank" rel="noopener noreferrer">📄 Abrir {tipo === "application/pdf" ? "PDF" : extensao && extensao.length <= 4 && extensao !== "BIN" ? extensao : "arquivo"}</a>;
}

function textoDoEvento(conteudo) {
  const [, motivo, resultado, nome] = conteudo.match(/\((\w+)\): (\w+)(?: para (.+))?/) ?? [];
  if (!motivo) return conteudo;
  return `↗ IA passou ao plantão · ${MOTIVO[motivo] ?? motivo} · ${RESULTADO[resultado] ?? resultado}${nome ? ` (${nome})` : ""}`;
}

// Celular com o teclado aberto: marca a página para esconder o menu de baixo,
// as abas e o topo, e sobrar espaço para a conversa.
function useTecladoAberto() {
  useEffect(() => {
    const vv = window.visualViewport;
    const raiz = document.documentElement;
    const conferir = () => {
      const campo = document.activeElement;
      const digitando = !!campo && (campo.tagName === "TEXTAREA" || (campo.tagName === "INPUT" && !["checkbox", "radio", "file", "button", "submit"].includes(campo.type)) || campo.isContentEditable);
      const encolheu = !!vv && vv.height < window.innerHeight * 0.8;
      raiz.classList.toggle("teclado-aberto", digitando && encolheu);
    };
    const depois = () => setTimeout(conferir, 60);
    vv?.addEventListener("resize", conferir);
    document.addEventListener("focusin", depois);
    document.addEventListener("focusout", depois);
    conferir();
    return () => {
      vv?.removeEventListener("resize", conferir);
      document.removeEventListener("focusin", depois);
      document.removeEventListener("focusout", depois);
      raiz.classList.remove("teclado-aberto");
    };
  }, []);
}

function Lead({ id, voltar }) {
  const { eu, versao, souGestor, recarregar } = useSessao();
  const agora = useAgora();
  const fim = useRef(null);
  const [texto, setTexto] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [erroAcao, setErroAcao] = useState(null);
  // No celular, conversa e ficha ficam em abas; no computador, lado a lado.
  const [aba, setAba] = useState("conversa");
  // Partes do cliente, ao lado da conversa.
  const [parte, setParte] = useState("negociacao");
  const [editando, setEditando] = useState(false);
  const [finalizando, setFinalizando] = useState(false);
  const celular = useEhCelular();
  // No computador a barra já vem aberta; no celular, fechada para sobrar conversa.
  const [barraAberta, setBarraAberta] = useState(() => !window.matchMedia?.("(max-width: 760px)").matches);
  useTecladoAberto();
  const gravador = useGravador();
  const [enviandoAudio, setEnviandoAudio] = useState(false);
  // Mensagens que o corretor acabou de enviar: aparecem na hora, antes de o
  // servidor confirmar, como no WhatsApp.
  const [pendentes, setPendentes] = useState([]);
  // Mensagem que o corretor escolheu para responder citando.
  const [respondendo, setRespondendo] = useState(null);
  const caixaDeTexto = useRef(null);
  // Foto ou documento escolhido, esperando o Enviar (o texto vira a legenda).
  const [anexo, setAnexo] = useState(null);
  const [menuAnexo, setMenuAnexo] = useState(false);
  const anexarRef = useRef(null);
  useFecharComEsc(menuAnexo, () => setMenuAnexo(false));
  useFecharAoTocarFora(anexarRef, menuAnexo, () => setMenuAnexo(false));
  const escolherGaleria = useRef(null);
  const escolherCamera = useRef(null);
  const escolherDocumento = useRef(null);
  useEffect(() => {
    setPendentes([]);
    setRespondendo(null);
    setAnexo(null);
  }, [id]);

  // As partes da conversa são lidas ao mesmo tempo (antes, uma depois da outra).
  const { dados, erro } = useCarregar(async () => {
    const [rLead, rMensagens, rAtribuicoes, rEquipe] = await Promise.all([
      supabase.from("leads").select("*").eq("id", id).maybeSingle(),
      supabase.from("mensagens").select("*").eq("lead_id", id).order("id"),
      supabase.from("atribuicoes").select("*").eq("lead_id", id).order("oferecida_em", { ascending: false }),
      supabase.from("corretores").select("id, nome, ativo, whatsapp").order("nome"),
    ]);
    const lead = exigir(rLead);
    if (!lead) throw new Error("Lead não encontrado ou sem permissão para ver.");
    const mensagens = exigir(rMensagens);
    const [midias, imovel] = await Promise.all([
      enderecosDasMidias(mensagens),
      lead.imovel_codigo
        ? supabase.from("imoveis").select("codigo, referencia, tipo, bairro, valor_venda, valor_locacao, dormitorios, vagas, area_construida, link_site, foto_principal, ativo, captador").eq("codigo", lead.imovel_codigo).maybeSingle().then(exigir)
        : null,
    ]);
    const atribuicoes = exigir(rAtribuicoes);
    const equipe = exigir(rEquipe);
    return { lead, mensagens, midias, atribuicoes, imovel, equipe, nomes: new Map(equipe.map((c) => [c.id, c.nome])) };
  }, [id, versao]);

  const quantidade = (dados?.mensagens.length ?? 0) + pendentes.length;
  useEffect(() => {
    if (aba !== "conversa") return;
    // De novo depois que fontes e fotos terminam de carregar e mudam a altura.
    const rolar = () => fim.current?.scrollIntoView({ block: "nearest" });
    rolar();
    const depois = setTimeout(rolar, 500);
    return () => clearTimeout(depois);
  }, [quantidade, aba]);

  if (erro && !dados) return <section className="vista"><button type="button" className="voltar" onClick={voltar}>← Leads</button><Erro mensagem={erro} /></section>;
  if (!dados) return <Carregando />;

  const { lead, mensagens, midias, atribuicoes, imovel, equipe, nomes } = dados;
  const minhaOferta = atribuicoes.find((a) => a.status === "pendente" && a.corretor_id === eu.id);
  const ofertaAberta = atribuicoes.find((a) => a.status === "pendente");
  const souDono = lead.corretor_id === eu.id;
  const podeResponder = souGestor || souDono;
  const janelaAberta = lead.ultima_mensagem_cliente_em && Date.now() - new Date(lead.ultima_mensagem_cliente_em).getTime() < 24 * 3600 * 1000;
  // Assumiu e ainda não mandou mensagem: o relógio do prazo para responder.
  const assumida = atribuicoes.find((a) => a.status === "aceita" && a.corretor_id === lead.corretor_id && a.prazo_resposta_em);
  const jaRespondeu = assumida && [...mensagens, ...pendentes].some((m) => m.autor === "corretor" && new Date(m.criado_em) >= new Date(assumida.respondida_em));
  const prazoParaResponder = assumida && !jaRespondeu && lead.status === "com_corretor" ? assumida.prazo_resposta_em : null;
  const conversa = [...mensagens, ...pendentes.filter((p) => !p.idReal || !mensagens.some((m) => m.id === p.idReal))];
  const porWhatsappId = new Map(mensagens.filter((m) => m.whatsapp_id).map((m) => [m.whatsapp_id, m]));
  const autorDe = (m) => (m.autor === "cliente" ? lead.nome ?? "Cliente" : m.autor === "ia" ? "Assistente LFG" : nomes.get(m.corretor_id) ?? "Corretor");
  const responderA = (m) => {
    setRespondendo(m);
    setAba("conversa");
    setTimeout(() => caixaDeTexto.current?.focus(), 50);
  };
  const irParaMensagem = (m) => {
    const alvo = m && document.getElementById(`msg-${m.id}`);
    if (!alvo) return;
    alvo.scrollIntoView({ block: "center", behavior: "smooth" });
    alvo.classList.add("piscando");
    setTimeout(() => alvo.classList.remove("piscando"), 1400);
  };

  async function agir(acao) {
    setOcupado(true);
    setErroAcao(null);
    try {
      await acao();
    } catch (e) {
      setErroAcao(mensagemDeErro(e));
    } finally {
      setOcupado(false);
    }
  }

  const assumir = () => agir(async () => exigir(await supabase.rpc("assumir_lead", { p_atribuicao_id: minhaOferta.id })));
  const mudarIa = (ativa) => agir(async () => exigir(await supabase.rpc("definir_ia_do_lead", { p_lead_id: lead.id, p_ativa: ativa })));
  // A mensagem entra na conversa na hora; se o WhatsApp recusar, ela sai e o
  // texto volta para a caixa, com o motivo.
  const escolheuArquivo = async (evento) => {
    const arquivo = evento.target.files?.[0];
    evento.target.value = "";
    setMenuAnexo(false);
    if (!arquivo) return;
    setErroAcao(null);
    try {
      setAnexo(await prepararAnexo(arquivo));
      setTimeout(() => caixaDeTexto.current?.focus(), 50);
    } catch (e) {
      setErroAcao(mensagemDeErro(e));
    }
  };

  // Foto ou documento: sobe para o armazenamento e o WhatsApp entrega ao cliente.
  const enviarAnexo = () => {
    const escolhido = anexo;
    const legenda = texto.trim();
    const citada = respondendo;
    const ehFoto = escolhido.tipo.startsWith("image/");
    const provisoria = {
      id: `envio-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, provisoria: true, autor: "corretor", corretor_id: eu.id,
      tipo: ehFoto ? "image" : "document", conteudo: legenda || (ehFoto ? null : escolhido.nome), midia_url: `enviando.${escolhido.nome.split(".").pop()}`,
      midia_tipo: escolhido.tipo, urlLocal: escolhido.previa ?? URL.createObjectURL(escolhido.arquivo),
      criado_em: new Date().toISOString(), status_entrega: "enviando", cita_whatsapp_id: citada?.whatsapp_id ?? null,
    };
    setAnexo(null);
    setTexto("");
    setRespondendo(null);
    setErroAcao(null);
    setPendentes((atuais) => [...atuais, provisoria]);
    (async () => {
      const preparo = await chamarPainel("preparar_arquivo", { lead_id: lead.id, nome: escolhido.nome, tipo: escolhido.tipo });
      exigir(await supabase.storage.from("midias").uploadToSignedUrl(preparo.caminho, preparo.token, escolhido.arquivo, { contentType: escolhido.tipo }));
      return chamarPainel("enviar_arquivo", {
        lead_id: lead.id, caminho: preparo.caminho, nome: escolhido.nome, tipo: escolhido.tipo, legenda,
        ...(citada ? { responde_a: citada.id } : {}),
      });
    })()
      .then((resposta) => setPendentes((atuais) => atuais.map((m) => (m.id === provisoria.id ? { ...m, ...resposta.mensagem, urlLocal: provisoria.urlLocal, idReal: resposta.mensagem.id, id: provisoria.id } : m))))
      .catch((e) => {
        setPendentes((atuais) => atuais.filter((m) => m.id !== provisoria.id));
        setAnexo(escolhido);
        setTexto((atual) => atual || legenda);
        setRespondendo((atual) => atual ?? citada);
        setErroAcao(mensagemDeErro(e));
      });
  };

  const enviar = (evento) => {
    evento.preventDefault();
    if (anexo) return enviarAnexo();
    const conteudo = texto.trim();
    if (!conteudo) return;
    const citada = respondendo;
    const provisoria = {
      id: `envio-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, provisoria: true, autor: "corretor", corretor_id: eu.id,
      tipo: "texto", conteudo, criado_em: new Date().toISOString(), status_entrega: "enviando", cita_whatsapp_id: citada?.whatsapp_id ?? null,
    };
    setTexto("");
    setRespondendo(null);
    setErroAcao(null);
    setPendentes((atuais) => [...atuais, provisoria]);
    chamarPainel("enviar_mensagem", { lead_id: lead.id, texto: conteudo, ...(citada ? { responde_a: citada.id } : {}) })
      .then((resposta) => setPendentes((atuais) => atuais.map((m) => (m.id === provisoria.id ? { ...m, ...resposta.mensagem, idReal: resposta.mensagem.id, id: provisoria.id } : m))))
      .catch((e) => {
        setPendentes((atuais) => atuais.filter((m) => m.id !== provisoria.id));
        setTexto((atual) => atual || conteudo);
        setRespondendo((atual) => atual ?? citada);
        setErroAcao(mensagemDeErro(e));
      });
  };
  const gravarAudio = () => agir(gravador.iniciar);
  const enviarAudio = () => agir(async () => {
    setEnviandoAudio(true);
    try {
      const arquivo = await gravador.terminar();
      if (!arquivo || arquivo.size < 1000) throw new Error("O áudio ficou curto demais. Grave de novo.");
      await chamarPainel("enviar_audio", { lead_id: lead.id, audio: await paraBase64(arquivo), tipo: arquivo.type });
    } finally {
      setEnviandoAudio(false);
    }
  });
  gravador.aoAtingirLimite.current = enviarAudio;

  const f = lead.ficha ?? {};
  const linhas = [
    ["Operação", OPERACAO[lead.interesse]],
    ["Tipo", f.tipo_imovel && f.tipo_imovel.charAt(0) + f.tipo_imovel.slice(1).toLowerCase()],
    ["Região", f.regiao],
    ["Orçamento", f.orcamento_max != null ? `até ${reais(f.orcamento_max)}${lead.interesse === "locacao" ? "/mês" : ""}` : null],
    ["Quartos", f.quartos],
    ["Pagamento", f.forma_pagamento],
    ["Urgência", f.urgencia],
    ["Pet", f.pet === true ? "Sim" : null],
    ["Imóvel do cliente", f.imovel_do_cliente],
    ["Observações", f.observacoes],
    ["Anúncio que viu", f.anuncio?.texto ? `${f.anuncio.texto.slice(0, 220)}${f.anuncio.texto.length > 220 ? "…" : ""}` : null],
    ["E-mail", lead.email],
    ...Object.entries(f.respostas_campanha ?? {}).map(([k, v]) => [k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, " "), typeof v === "string" ? v : JSON.stringify(v)]),
    ["Origem", (lead.campanha_ia_id || lead.origem === "site") && lead.campanha ? lead.campanha : lead.campanha && !/^api\.whatsapp\.com$/i.test(lead.campanha) ? `Anúncio: ${lead.campanha}` : lead.origem === "anuncio" ? "Anúncio no Facebook/Instagram" : nomeDaOrigem(lead.origem)],
  ].filter(([, v]) => v != null && v !== "");

  return (
    <section className="vista" aria-labelledby="t-lead">
      <button type="button" className="voltar" onClick={voltar}>← Leads</button>
      {/* Barra do cliente: fica presa no alto enquanto a conversa rola. Fechada
          mostra o essencial; aberta, o telefone, a chegada e Finalizar. */}
      <div className="cabeca-fixa">
        <div className={`barra-cliente ${barraAberta ? "aberta" : ""}`}>
          <div className="barra-linha">
            <span className={`avatar ${lead.nome ? "" : "sem-nome"}`} aria-hidden="true">{iniciais(lead.nome)}</span>
            <div className="barra-quem">
              <h2 id="t-lead">{nomeLead(lead)}</h2>
              <div className="barra-etiquetas"><Situacao status={lead.status} /> <Temperatura valor={lead.temperatura} /></div>
            </div>
            <div className="barra-acoes">
              {!ehTeste(lead) && (
                <a className="botao secundario pequeno botao-whatsapp com-rotulo" href={`https://wa.me/${lead.whatsapp}`} target="_blank" rel="noopener noreferrer" title="Abrir no meu WhatsApp" aria-label="Abrir a conversa com este cliente no meu WhatsApp">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2a8.2 8.2 0 0 1-4.2-1.1l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.7.8-.8 1-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.3-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.8 11.9 11.9 0 0 0 4.6 4c1.7.7 2.4.8 3.2.7a2.8 2.8 0 0 0 1.8-1.3 2.3 2.3 0 0 0 .2-1.3c-.1-.1-.2-.2-.5-.3Z" /></svg>
                  <span>WhatsApp</span>
                </a>
              )}
              <label className="barra-ia" title={lead.ia_ativa ? "A IA está respondendo este cliente" : "A IA está pausada neste cliente"}>
                <span>IA</span>
                <Interruptor ligado={lead.ia_ativa} aoMudar={mudarIa} rotulo={lead.ia_ativa ? "Pausar a IA neste lead" : "Ligar a IA neste lead"} desativado={!podeResponder || ocupado} />
              </label>
              <button type="button" className="barra-abrir com-rotulo" aria-expanded={barraAberta} aria-controls="barra-detalhes" aria-label={barraAberta ? "Mostrar menos sobre o cliente" : "Mostrar mais sobre o cliente"} onClick={() => setBarraAberta(!barraAberta)}>
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
                <span>{barraAberta ? "Menos" : "Mais"}</span>
              </button>
              {/* Na barra que fica presa no alto, para estar sempre à vista. */}
              <BotaoFechar className="barra-fechar" aoFechar={voltar} rotulo="Fechar a conversa e voltar para Leads" />
            </div>
          </div>
          {barraAberta && (
            <div className="barra-detalhes" id="barra-detalhes">
              <span className="dado">
                {ehTeste(lead) ? telefone(lead.whatsapp) : <a href={`tel:+${lead.whatsapp}`}>{telefone(lead.whatsapp)}</a>}
              </span>
              <span className="mudo">Chegou em {dataHora(lead.criado_em)}</span>
              <span className={`etiqueta ${lead.ia_ativa ? "pronto" : "pendente"}`}>IA {lead.ia_ativa ? "respondendo" : "pausada"}</span>
              {podeResponder && (
                <a className="botao pequeno" href={`#agenda/novo?lead=${lead.id}${lead.imovel_codigo ? `&imovel=${encodeURIComponent(lead.imovel_codigo)}` : ""}${lead.interesse === "compra" ? "&tipo=venda" : lead.interesse === "locacao" ? "&tipo=aluguel" : ""}`}>
                  Agendar visita
                </a>
              )}
              {podeResponder && lead.status !== "encerrado" && (
                <button type="button" className="botao secundario pequeno barra-finalizar" onClick={() => setFinalizando(true)}>Finalizar cliente</button>
              )}
            </div>
          )}
        </div>
        <div className="abas abas-lead" role="tablist" aria-label="Partes do lead">
          <button type="button" role="tab" className="aba" aria-selected={aba === "conversa"} onClick={() => setAba("conversa")}>Conversa</button>
          <button type="button" role="tab" className="aba" aria-selected={aba === "ficha"} onClick={() => setAba("ficha")}>Cliente</button>
        </div>
      </div>
      {finalizando && <FinalizarCliente lead={lead} aoFechar={() => setFinalizando(false)} aoFinalizar={() => { setFinalizando(false); recarregar(); }} />}
      {lead.status === "encerrado" && lead.motivo_perda && (
        <p className="pequeno mudo" style={{ margin: "0 0 8px" }}>Atendimento finalizado: {lead.motivo_perda}. Se o cliente escrever de novo, o lead reabre sozinho.</p>
      )}

      <div className={`detalhe mostra-${aba}`}>
        <div className="painel chat">
          <div className="mensagens">
            {conversa.map((m) => {
              if (m.autor === "sistema") return <div key={m.id} className="evento">{textoDoEvento(m.conteudo)}</div>;
              const autor = m.autor === "ia" ? "Assistente LFG" : m.autor === "corretor" ? nomes.get(m.corretor_id) ?? "Corretor" : null;
              const citada = m.cita_whatsapp_id ? porWhatsappId.get(m.cita_whatsapp_id) : null;
              return (
                <BolhaCitavel
                  key={m.id}
                  id={`msg-${m.id}`}
                  className={`bolha ${m.autor}`}
                  podeCitar={podeResponder && janelaAberta && !!m.whatsapp_id && !m.provisoria && !minhaOferta}
                  aoResponder={() => responderA(m)}
                  texto={m.conteudo}
                >
                  {autor && <span className="autor">{autor}</span>}
                  {m.cita_whatsapp_id && (
                    <button type="button" className={`citacao ${citada?.autor ?? ""}`} onClick={() => irParaMensagem(citada)} disabled={!citada}>
                      <b>{citada ? autorDe(citada) : "Mensagem citada"}</b>
                      <span>{citada ? resumoDaCitacao(citada) : "Mensagem mais antiga da conversa"}</span>
                    </button>
                  )}
                  {m.tipo === "acompanhamento" && <span className="rotulo-transcricao">Aviso automático de fila</span>}
                  {TIPOS_DE_MIDIA.has(m.tipo) && <Midia m={m} url={m.urlLocal ?? midias.get(m.midia_url)} />}
                  {m.tipo === "audio" && m.conteudo && <span className="rotulo-transcricao">Transcrição automática</span>}
                  <TextoWhatsApp texto={m.conteudo} />
                  <span className="hora">{hora(m.criado_em)}{m.status_entrega && m.autor !== "cliente" ? ` · ${m.status_entrega === "read" ? "lida" : m.status_entrega === "delivered" ? "entregue" : m.status_entrega}` : ""}</span>
                </BolhaCitavel>
              );
            })}
            <div ref={fim} className="fim-conversa" />
          </div>

          {prazoParaResponder && (
            <div className={`prazo-resposta ${new Date(prazoParaResponder) - agora < 60_000 ? "acabando" : ""}`} role="status">
              <EtiquetaPrazo prazo={prazoParaResponder} atencaoMin={PRAZO_ATENCAO_LEAD} agora={agora} />{" "}
              {souDono ? "Mande a primeira mensagem" : "O corretor precisa mandar a primeira mensagem"} em <b className="dado">{contagem(prazoParaResponder, agora)}</b>, ou o lead volta para o rodízio.
            </div>
          )}
          {/* Perto da caixa de resposta, onde a pessoa está olhando. */}
          {erroAcao && <div className="erro-da-conversa"><Erro mensagem={erroAcao} /></div>}

          {minhaOferta ? (
            <div className="faixa-acao">
              <b>Este lead foi oferecido a você.</b>
              <EtiquetaPrazo prazo={minhaOferta.prazo_em} atencaoMin={PRAZO_ATENCAO_LEAD} agora={agora}>assumir em {contagem(minhaOferta.prazo_em, agora)}</EtiquetaPrazo>
              <button type="button" className="botao" onClick={assumir} disabled={ocupado} style={{ marginLeft: "auto" }}>Assumir lead</button>
            </div>
          ) : podeResponder ? (
            janelaAberta ? (
              gravador.gravando || enviandoAudio ? (
                <div className="compositor gravando" role="status">
                  {enviandoAudio ? (
                    <span className="mudo">Enviando o áudio…</span>
                  ) : (
                    <>
                      <span className="ponto-gravando" aria-hidden="true" />
                      <span className="dado">{relogioDaGravacao(gravador.segundos)}</span>
                      <span className="mudo pequeno">Gravando</span>
                      <button type="button" className="botao secundario" onClick={gravador.cancelar} style={{ marginLeft: "auto" }}>Cancelar</button>
                      <button type="button" className="botao" onClick={enviarAudio}>Enviar áudio</button>
                    </>
                  )}
                </div>
              ) : (
                <form className="compositor" onSubmit={enviar} onMouseDown={(e) => { if (e.target.closest("button") && document.activeElement === caixaDeTexto.current) e.preventDefault(); }}>
                  {respondendo && (
                    <div className="respondendo" role="status">
                      <div>
                        <b>Respondendo a {autorDe(respondendo)}</b>
                        <span>{resumoDaCitacao(respondendo)}</span>
                      </div>
                      <button type="button" aria-label="Cancelar a resposta citada" onClick={() => setRespondendo(null)}>✕ Cancelar</button>
                    </div>
                  )}
                  {anexo && (
                    <div className="anexo-escolhido" role="status">
                      {anexo.previa ? <img src={anexo.previa} alt="" /> : <span className="icone-documento" aria-hidden="true">📄</span>}
                      <span>{anexo.nome}</span>
                      <button type="button" aria-label="Tirar o arquivo" onClick={() => setAnexo(null)}>✕ Tirar</button>
                    </div>
                  )}
                  <div className="anexar" ref={anexarRef}>
                    <button type="button" className="botao secundario botao-clipe com-rotulo" aria-label="Enviar foto ou documento" aria-expanded={menuAnexo} title="Foto ou documento" onClick={() => setMenuAnexo(!menuAnexo)} disabled={ocupado}>
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M21 11.5 12.4 20a5 5 0 0 1-7.1-7.1l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9" /></svg>
                      <span>Anexar</span>
                    </button>
                    {menuAnexo && (
                      <div className="menu-anexo" role="menu">
                        <button type="button" role="menuitem" onClick={() => escolherGaleria.current?.click()}>🖼️ Foto da galeria</button>
                        <button type="button" role="menuitem" onClick={() => escolherCamera.current?.click()}>📷 Tirar foto</button>
                        <button type="button" role="menuitem" onClick={() => escolherDocumento.current?.click()}>📄 Documento</button>
                      </div>
                    )}
                    <input ref={escolherGaleria} type="file" accept="image/*" className="invisivel" tabIndex={-1} onChange={escolheuArquivo} />
                    <input ref={escolherCamera} type="file" accept="image/*" capture="environment" className="invisivel" tabIndex={-1} onChange={escolheuArquivo} />
                    <input ref={escolherDocumento} type="file" accept={ACEITA_DOCUMENTOS} className="invisivel" tabIndex={-1} onChange={escolheuArquivo} />
                  </div>
                  <textarea ref={caixaDeTexto} id="resposta" rows={celular ? 1 : 2} placeholder={anexo ? "Legenda (opcional)" : celular ? "Mensagem" : "Escreva para o cliente. Ao enviar, a IA pausa neste lead."} value={texto} onChange={(e) => setTexto(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && enviar(e)} />
                  {texto.trim() || anexo ? (
                    <button className="botao" type="submit" disabled={ocupado}>Enviar</button>
                  ) : (
                    <button type="button" className="botao botao-microfone com-rotulo" onClick={gravarAudio} disabled={ocupado} aria-label="Gravar áudio para o cliente" title="Gravar áudio">
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
                      <span>Áudio</span>
                    </button>
                  )}
                </form>
              )
            ) : (
              <div className="faixa-acao">
                {lead.ultima_mensagem_cliente_em
                  ? "O cliente não escreve há mais de 24 horas. O WhatsApp só permite retomar com mensagem-modelo aprovada (em breve no painel)."
                  : "Este cliente ainda não escreveu para o número oficial. Fale com ele por ligação ou pelo seu WhatsApp; a conversa aparece aqui quando ele escrever."}
                {!ehTeste(lead) && <a className="botao secundario pequeno" href={`https://wa.me/${lead.whatsapp}`} target="_blank" rel="noopener noreferrer" style={{ marginLeft: "auto" }}>Abrir no WhatsApp</a>}
              </div>
            )
          ) : (
            <div className="faixa-acao">
              {ofertaAberta ? `Oferecido a ${nomes.get(ofertaAberta.corretor_id) ?? "outro corretor"} · prazo ${contagem(ofertaAberta.prazo_em, agora)}` : lead.corretor_id ? `Com ${nomes.get(lead.corretor_id) ?? "outro corretor"}.` : "A IA está atendendo este lead."}
            </div>
          )}
        </div>

        <aside className="painel ficha" aria-label="Cliente">
          <div className="abas" role="tablist" aria-label="Partes do cliente">
            {[["negociacao", "Negociação"], ["ficha", "Ficha"], ["imoveis", "Imóveis"]].map(([id, nome]) => (
              <button key={id} type="button" role="tab" className="aba" aria-selected={parte === id} onClick={() => setParte(id)}>{nome}</button>
            ))}
          </div>
          {parte === "negociacao" && <Negociacao lead={lead} podeEditar={podeResponder} nomes={nomes} />}
          {parte === "imoveis" && <ImoveisCompativeis lead={lead} podeEditar={podeResponder} janelaAberta={janelaAberta} />}
          {parte === "ficha" && (editando ? <EditarCliente lead={lead} aoFechar={() => setEditando(false)} /> : <>
          {podeResponder && <button type="button" className="botao secundario pequeno" style={{ alignSelf: "flex-start" }} onClick={() => setEditando(true)}>Editar ficha</button>}
          {lead.resumo && <div className="resumo"><span className="rotulo">Resumo para o corretor</span>{lead.resumo}</div>}
          {linhas.length ? (
            <dl className="pares">{linhas.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>)}</dl>
          ) : <p className="mudo pequeno" style={{ margin: 0 }}>A IA ainda não descobriu o que o cliente procura.</p>}
          {imovel && (
            <>
              <span className="rotulo">Imóvel de interesse</span>
              <a className="imovel-mini" href={imovel.link_site} target="_blank" rel="noopener noreferrer">
                {imovel.foto_principal && <img src={imovel.foto_principal} alt={`Foto do imóvel ${imovel.referencia}`} loading="lazy" />}
                <div>
                  <b>{imovel.referencia} · {imovel.ativo ? "ativo no Univen" : "inativo"}</b>
                  <strong>{imovel.valor_locacao && lead.interesse === "locacao" ? `${reais(imovel.valor_locacao)}/mês` : reais(imovel.valor_venda ?? imovel.valor_locacao)}</strong>
                  <span>{imovel.tipo} · {imovel.bairro}</span>
                  <span>{imovel.dormitorios ?? "—"} quartos · {imovel.vagas ?? "—"} vagas</span>
                  {imovel.captador && <span>Captador: {imovel.captador}</span>}
                </div>
              </a>
            </>
          )}
          {atribuicoes.length > 0 && (
            <>
              <span className="rotulo">Distribuição</span>
              <ul className="lista">
                {atribuicoes.map((a) => (
                  <li key={a.id} className="pequeno" style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <span>
                      {nomes.get(a.corretor_id) ?? "Corretor"}
                      <span className="mudo"> · {a.motivo === "captador" ? "captador do imóvel" : a.motivo === "gestor" ? "passado pelo gestor" : "rodízio"}</span>
                      {a.aviso_status && <span className="mudo" title={a.aviso_status}> · {textoDoAviso(a.aviso_status)}</span>}
                    </span>
                    <span className={`etiqueta ${a.status === "aceita" ? "pronto" : a.status === "pendente" ? "alerta" : "pendente"}`}>{a.status}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {souGestor && lead.status !== "encerrado" && (
            <PassarLead lead={lead} equipe={equipe} atual={ofertaAberta?.corretor_id ?? lead.corretor_id} aoPassar={recarregar} />
          )}
          </>)}
        </aside>
      </div>
    </section>
  );
}

// Motivos para finalizar: os dois mais comuns primeiro, depois os de perda da
// negociação (Configurações), com "Outro" no fim.
const MOTIVOS_DE_FINALIZAR = ["Sem interesse", "Não é cliente (engano, robô ou spam)"];

function FinalizarCliente({ lead, aoFechar, aoFinalizar }) {
  const [motivo, setMotivo] = useState("");
  const [detalhe, setDetalhe] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState(null);
  const motivos = useCarregar(async () => {
    const linha = exigir(await supabase.from("configuracoes").select("valor").eq("chave", "motivos_perda").maybeSingle());
    const daConfig = (linha?.valor ?? []).filter((m) => m !== "Outro");
    return [...new Set([...MOTIVOS_DE_FINALIZAR, ...daConfig]), "Outro"];
  }, []);

  async function confirmar(evento) {
    evento.preventDefault();
    setOcupado(true);
    setErro(null);
    try {
      const final = motivo === "Outro" ? `Outro: ${detalhe.trim()}` : motivo;
      exigir(await supabase.rpc("finalizar_lead", { p_lead_id: lead.id, p_motivo: final }));
      aoFinalizar();
    } catch (e) {
      setErro(mensagemDeErro(e));
      setOcupado(false);
    }
  }

  return (
    <Janela titulo={`Finalizar atendimento: ${lead.nome ?? "cliente sem nome"}`} aoFechar={aoFechar}>
      <form onSubmit={confirmar} className="formulario">
        <label className="campo">Por que finalizar?
          <select id="finalizar-motivo" required value={motivo} onChange={(e) => setMotivo(e.target.value)}>
            <option value="">Escolha o motivo</option>
            {(motivos.dados ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        {motivo === "Outro" && (
          <label className="campo">Qual?<input id="finalizar-detalhe" required maxLength={180} value={detalhe} onChange={(e) => setDetalhe(e.target.value)} /></label>
        )}
        <p className="mudo pequeno" style={{ margin: 0 }}>
          A IA para de responder, a negociação vai para Perdido e os próximos passos são concluídos. O cliente não recebe nenhuma mensagem.
          Se ele escrever de novo, o atendimento reabre sozinho.
        </p>
        <Erro mensagem={erro ?? motivos.erro} />
        <div className="acoes-formulario">
          <button type="button" className="botao secundario" onClick={aoFechar}>Cancelar</button>
          <button type="submit" className="botao" disabled={ocupado}>{ocupado ? "Finalizando…" : "Finalizar"}</button>
        </div>
      </form>
    </Janela>
  );
}

// Gestor passa o lead para outro corretor: com aviso no WhatsApp (o corretor
// tem o prazo do rodízio para assumir) ou direto, quando já combinou com ele.
function PassarLead({ lead, equipe, atual, aoPassar }) {
  const [destino, setDestino] = useState("");
  const [direto, setDireto] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState(null);
  const [feito, setFeito] = useState(null);
  const opcoes = equipe.filter((p) => p.ativo && p.id !== atual);
  const escolhido = opcoes.find((p) => p.id === destino);
  const semWhatsapp = !direto && escolhido && !escolhido.whatsapp;

  async function passar(evento) {
    evento.preventDefault();
    setOcupado(true);
    setErro(null);
    setFeito(null);
    try {
      const r = exigir(await supabase.rpc("passar_lead", { p_lead_id: lead.id, p_corretor_id: destino, p_direto: direto }));
      setFeito(direto ? `Lead atribuído a ${r.corretor_nome}.` : `${r.corretor_nome} recebeu o aviso no WhatsApp para assumir.`);
      setDestino("");
      setDireto(false);
      aoPassar();
    } catch (e) {
      setErro(mensagemDeErro(e));
    } finally {
      setOcupado(false);
    }
  }

  return (
    <form onSubmit={passar} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <span className="rotulo">Passar para outro corretor</span>
      <label className="campo">
        Corretor
        <select id="passar-corretor" required value={destino} disabled={ocupado} onChange={(e) => setDestino(e.target.value)}>
          <option value="">Escolha quem vai atender</option>
          {opcoes.map((p) => <option key={p.id} value={p.id}>{p.nome}{p.whatsapp ? "" : " (sem WhatsApp)"}</option>)}
        </select>
      </label>
      <label className="pequeno" style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <input id="passar-direto" type="checkbox" checked={direto} disabled={ocupado} onChange={(e) => setDireto(e.target.checked)} />
        <span>Já combinei com o corretor: atribuir direto, sem aviso e sem prazo</span>
      </label>
      <p className="mudo pequeno" style={{ margin: 0 }}>
        {direto
          ? "O lead fica com ele na hora e a IA pausa neste lead."
          : "Ele recebe o aviso no WhatsApp e tem o prazo do rodízio para assumir. Se não assumir, o lead segue para o rodízio de plantão."}
      </p>
      {semWhatsapp && <p className="pequeno" style={{ margin: 0 }}>Sem WhatsApp no cadastro, só dá para atribuir direto.</p>}
      <Erro mensagem={erro} />
      {feito && <p className="aviso-ok" role="status" style={{ margin: 0 }}>{feito}</p>}
      <button className="botao secundario" type="submit" disabled={ocupado || !destino || semWhatsapp} style={{ alignSelf: "flex-start" }}>
        {ocupado ? "Passando…" : "Passar lead"}
      </button>
    </form>
  );
}
