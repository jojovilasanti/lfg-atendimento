import { useEffect, useState } from "react";
import { BotaoFechar, Carregando, nomeDoPapel, useFecharComEsc } from "./comum.jsx";
import BuscaRapida from "./base/BuscaRapida.jsx";
import Agenda from "./paginas/Agenda.jsx";
import Bolsao from "./paginas/Bolsao.jsx";
import Configuracoes from "./paginas/Configuracoes.jsx";
import Demandas from "./paginas/Demandas.jsx";
import Entrar from "./paginas/Entrar.jsx";
import Imoveis from "./paginas/Imoveis.jsx";
import Inicio from "./paginas/Inicio.jsx";
import Leads from "./paginas/Leads.jsx";
import Locacao from "./paginas/Locacao.jsx";
import Contratos from "./paginas/Contratos.jsx";
import Pessoas from "./paginas/Pessoas.jsx";
import Administrados from "./paginas/Administrados.jsx";
import Perfil, { iniciais } from "./paginas/Perfil.jsx";
import Plantao from "./paginas/Plantao.jsx";
import Disparos from "./paginas/Disparos.jsx";
import Empreendimentos from "./paginas/Empreendimentos.jsx";
import Portais from "./paginas/Portais.jsx";
import NaoClientes from "./paginas/NaoClientes.jsx";
import Site from "./paginas/Site.jsx";
import { AvisoNotificacoes } from "./Notificacoes.jsx";
import { logoDaEmpresa, useSessao } from "./sessao.jsx";
import { supabase } from "./supabase.js";

// [id, título, subtítulo, ícone, nome curto do menu de baixo no celular]
const MENU = [
  ["inicio", "Início", "Resultado do mês", <path key="i" d="M3 11l9-7 9 7M5 10v10h5v-6h4v6h5V10" />, "Início"],
  ["leads", "Leads", "Conversas e fichas", <g key="l"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M9 10v10" /></g>, "Leads"],
  ["bolsao", "Bolsão", "Leads que ninguém assumiu", <g key="b"><path d="M5 8h14l-1.5 12h-11z" /><path d="M9 8V6a3 3 0 0 1 6 0v2" /></g>, "Bolsão"],
  ["plantao", "Plantão", "Rodízio dos corretores", <g key="p"><circle cx="12" cy="13" r="8" /><path d="M12 9v4l3 2M9 2h6" /></g>, "Plantão"],
  ["agenda", "Agenda", "Visitas e compromissos", <g key="a"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4M8 14h3v3H8z" /></g>, "Agenda"],
  ["naoclientes", "Não clientes", "Empresas, prestadores e outros", <g key="n"><circle cx="12" cy="12" r="9" /><path d="M6 6l12 12" /></g>, "Não clientes"],
  ["demandas", "Demandas", "Tarefas da equipe", <g key="t"><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></g>, "Tarefas"],
  ["imoveis", "Imóveis", "Estoque e cadastro", <g key="m"><path d="M4 21V9l8-6 8 6v12" /><path d="M9 21v-6h6v6" /></g>, "Imóveis"],
  ["portais", "Portais", "Feeds para ZAP, Viva Real e OLX", <g key="o"><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4M7 9l3 3-3 3" /></g>, "Portais"],
  ["site", "Site", "Aparência e textos do site", <g key="s"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9s1.3-6.4 3.8-9z" /></g>, "Site"],
  ["empreendimentos", "Empreendimentos", "Lançamentos no site", <g key="e"><path d="M3 21h18M5 21V8l5-3v16M10 21V5l9 4v12" /><path d="M13 12h3M13 16h3" /></g>, "Lançamentos"],
  ["disparos", "Disparos", "Mensagens em massa", <g key="d"><path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1z" /><path d="M15 9a4 4 0 0 1 0 6M18 6a8 8 0 0 1 0 12" /></g>, "Disparos"],
  ["locacao", "Locação", "Contratos, cobrança e repasses", <g key="loc"><path d="M7 3h7l4 4v14H7z" /><path d="M14 3v4h4M10 12h5M10 16h5" /></g>, "Locação"],
  ["contratos", "Contratos", "Contratos de locação", <g key="ctr"><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 8h6M9 12h6M9 16l2 1.5 4-3.5" /></g>, "Contratos"],
  ["pessoas", "Pessoas", "Locadores, locatários e fiadores", <g key="pes"><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5c2 .7 3.5 2.6 3.5 5.5" /></g>, "Pessoas"],
  ["administrados", "Imóveis administrados", "Locadores e dados da administração", <g key="adm"><path d="M3 21V10l7-5 7 5v11" /><path d="M8 21v-5h4v5M19 8h2v13h-4" /></g>, "Administrados"],
  ["perfil", "Meu perfil", "Nome, foto, contato e senha", <g key="u"><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" /></g>, "Perfil"],
  ["configuracoes", "Configurações", "Regras, equipe, integrações", <g key="c"><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /></g>, "Ajustes"],
];

// Menu agrupado no computador. No celular, cada perfil tem até 5 telas na barra
// de baixo e o resto em "Mais".
const GRUPOS = [
  ["Atendimento", ["inicio", "leads", "bolsao", "naoclientes", "plantao", "agenda", "demandas"]],
  ["Estoque", ["imoveis", "portais"]],
  ["Locação", ["locacao", "contratos", "pessoas", "administrados"]],
  ["Marketing", ["site", "empreendimentos", "disparos"]],
  ["Ajustes", ["perfil", "configuracoes"]],
];
const NO_MAIS = new Set(["locacao", "contratos", "pessoas", "administrados", "naoclientes", "portais", "site", "empreendimentos", "disparos", "configuracoes"]);
// No celular: a Agenda fica na barra de todos (no lugar de Tarefas); Demandas
// vai para "Mais", junto com o Perfil do corretor e, no gestor, o Plantão.
const noMais = (id, papel) => NO_MAIS.has(id) || id === "demandas" || (id === "plantao" && papel === "gestor") || (id === "bolsao" && papel === "administrativo") || (id === "perfil" && papel === "corretor");
const ICONE_MAIS = <g><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></g>;

// Telas da gestão (gestor e administrativo) e as só do gestor. Quem chegar numa
// tela que não é do seu perfil, até pelo endereço direto, volta para o Início.
// O banco e as funções recusam o resto (perfil_administrativo_regras).
const SO_GESTAO = new Set(["configuracoes", "empreendimentos", "naoclientes", "locacao", "contratos", "pessoas", "administrados"]);
const SO_GESTOR_PLENO = new Set(["site", "disparos", "portais"]);
// O administrativo não acompanha atendimentos.
const FORA_DO_ADMINISTRATIVO = new Set(["leads"]);
// Gestor e administrativo têm o próprio perfil em Configurações → Minha conta.
const SO_CORRETOR = new Set(["perfil"]);
// O corretor não vê a fila do rodízio (a tela Plantão): só o "Próximo do
// rodízio" e o próprio plantão, no Início. O banco também só devolve o próximo.
const FORA_DO_CORRETOR = new Set(["plantao"]);
const podeVer = (id, papel) => {
  if (SO_GESTOR_PLENO.has(id)) return papel === "gestor";
  if (papel === "corretor" && FORA_DO_CORRETOR.has(id)) return false;
  if (papel === "administrativo" && FORA_DO_ADMINISTRATIVO.has(id)) return false;
  const gestao = papel === "gestor" || papel === "administrativo";
  return gestao ? !SO_CORRETOR.has(id) : !SO_GESTAO.has(id);
};

// Endereço da tela fica no "#" da barra, para dar para voltar e favoritar.
function lerEndereco() {
  const [lida, leadId, acao] = location.hash.slice(1).split("?")[0].split("/");
  // O Funil saiu do menu (as etapas ficam na tela de cada lead): o endereço antigo abre Leads.
  const vista = lida === "funil" ? "leads" : lida;
  return {
    vista: MENU.some(([id]) => id === vista) ? vista : "inicio",
    leadId: vista === "leads" ? leadId ?? null : null,
    imovelAberto: vista === "imoveis" ? leadId ?? null : null,
    // Pessoas e Imóveis administrados (Locação): o que vem depois da barra abre a ficha.
    item: ["pessoas", "administrados", "contratos"].includes(vista) ? (leadId ? decodeURIComponent(leadId) : null) : null,
    acao: acao ?? null,
  };
}

function useTema() {
  const raiz = document.documentElement;
  const doSistema = () => (window.matchMedia?.("(prefers-color-scheme: light)").matches ? "claro" : "escuro");
  const [tema, setTema] = useState(() => raiz.dataset.tema || doSistema());
  const escolher = (novo) => {
    raiz.dataset.tema = novo;
    try {
      localStorage.setItem("lfg-painel-tema", novo);
    } catch {
      // sem armazenamento: vale só nesta visita
    }
    setTema(novo);
  };
  return [tema, escolher];
}

export default function App() {
  const { sessao, eu, sair, versao, empresa } = useSessao();
  const [endereco, setEndereco] = useState(lerEndereco);
  const [tema, escolherTema] = useTema();
  const [aguardando, setAguardando] = useState(0);
  // Bolsão: quantos leads há e quantos ainda não vi (o ponto verde de "novo").
  const [bolsao, setBolsao] = useState({ total: 0, novos: 0 });
  // No celular, nome, tema e Sair ficam num menu que abre pelo botão da conta.
  const [contaAberta, setContaAberta] = useState(false);
  // No celular do gestor: Site, Disparos e Configurações abrem por "Mais".
  const [maisAberto, setMaisAberto] = useState(false);
  const fecharMenus = () => { setContaAberta(false); setMaisAberto(false); };
  // Busca rápida: Ctrl+K (⌘K no Mac) de qualquer tela, ou o campo do topo.
  const [buscaAberta, setBuscaAberta] = useState(false);
  // Menu do computador recolhido (só os ícones). Fica guardado neste aparelho.
  const [recolhido, setRecolhido] = useState(() => {
    try {
      return localStorage.getItem("lfg-menu-recolhido") === "1";
    } catch {
      return false;
    }
  });
  const recolher = (valor) => {
    setRecolhido(valor);
    try {
      localStorage.setItem("lfg-menu-recolhido", valor ? "1" : "0");
    } catch {
      // sem armazenamento: vale só nesta visita
    }
  };
  useEffect(() => {
    const tecla = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setBuscaAberta((aberta) => !aberta);
      }
    };
    window.addEventListener("keydown", tecla);
    return () => window.removeEventListener("keydown", tecla);
  }, []);
  useFecharComEsc(contaAberta || maisAberto, fecharMenus);

  useEffect(() => {
    const aoMudar = () => setEndereco(lerEndereco());
    window.addEventListener("hashchange", aoMudar);
    return () => window.removeEventListener("hashchange", aoMudar);
  }, []);

  useEffect(() => {
    if (!eu) return;
    supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("status", "aguardando_corretor")
      .not("whatsapp", "like", "sim-%")
      .then(({ count }) => setAguardando(count ?? 0));
  }, [eu, versao]);

  // Relê ao trocar de tela: quem acabou de sair do Bolsão já não tem novidade.
  const vistaAtual = endereco.vista;
  useEffect(() => {
    if (!eu) return;
    supabase.rpc("bolsao_resumo").then(({ data }) => data && setBolsao({ total: data.total ?? 0, novos: data.novos ?? 0 }));
  }, [eu, versao, vistaAtual]);

  const ir = (vista, leadId = null) => {
    location.hash = leadId ? `${vista}/${leadId}` : vista;
    setContaAberta(false);
    setMaisAberto(false);
    window.scrollTo({ top: 0 });
  };
  const abrirLead = (id) => ir("leads", id);

  if (sessao === undefined || (sessao && eu === undefined)) return <Carregando texto="Abrindo o painel…" />;
  if (!sessao) return <Entrar />;
  if (!eu || !eu.ativo) {
    return (
      <div className="entrada">
        <div className="cartao-entrada">
          <img src={logoDaEmpresa(empresa)} alt={empresa.nome} />
          <h1>Acesso não liberado</h1>
          <p className="mudo">Seu login existe, mas ainda não está ligado à equipe ou foi desativado. Fale com o gestor da {empresa.nome}.</p>
          <button type="button" className="botao secundario" onClick={sair}>Sair</button>
        </div>
      </div>
    );
  }

  const gestor = eu.papel === "gestor" || eu.papel === "administrativo";
  if (!podeVer(endereco.vista, eu.papel)) {
    // Tela que não é deste perfil: troca o endereço sem deixar no histórico.
    history.replaceState(null, "", "#inicio");
    endereco.vista = "inicio";
  }

  const paginas = {
    inicio: <Inicio abrirLead={abrirLead} ir={ir} />,
    leads: <Leads leadAberto={endereco.leadId} abrirLead={(id) => (id ? abrirLead(id) : ir("leads"))} />,
    // O administrativo vê a fila do rodízio, mas não abre leads.
    plantao: <Plantao abrirLead={eu.papel === "administrativo" ? () => {} : abrirLead} />,
    agenda: <Agenda />,
    bolsao: <Bolsao />,
    demandas: <Demandas />,
    imoveis: <Imoveis imovelAberto={endereco.imovelAberto} acao={endereco.acao} ir={ir} />,
    configuracoes: gestor ? <Configuracoes /> : null,
    site: eu.papel === "gestor" ? <Site /> : null,
    empreendimentos: gestor ? <Empreendimentos /> : null,
    naoclientes: gestor ? <NaoClientes /> : null,
    disparos: eu.papel === "gestor" ? <Disparos /> : null,
    portais: eu.papel === "gestor" ? <Portais /> : null,
    locacao: gestor ? <Locacao /> : null,
    contratos: gestor ? <Contratos aberto={endereco.item} ir={ir} /> : null,
    pessoas: gestor ? <Pessoas aberta={endereco.item} ir={ir} /> : null,
    administrados: gestor ? <Administrados aberto={endereco.item} ir={ir} /> : null,
    perfil: <Perfil />,
  };

  const itensDoMais = MENU.map(([id]) => id).filter((id) => noMais(id, eu.papel) && podeVer(id, eu.papel));
  // Na tela do Bolsão o destaque some (a própria tela marca como visto).
  const bolsaoNovo = bolsao.novos > 0 && endereco.vista !== "bolsao";
  const itemDoMenu = (id) => MENU.find(([i]) => i === id);
  const botaoDoMenu = (id, extra = "") => {
    const [, titulo, subtitulo, icone, curto] = itemDoMenu(id);
    return (
      <button key={id} type="button" className={extra} title={recolhido ? `${titulo} · ${subtitulo}` : subtitulo} aria-current={endereco.vista === id ? "page" : undefined} onClick={() => ir(id)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">{icone}</svg>
        <span className="nome-longo">{titulo}</span>
        <span className="nome-curto">{curto}</span>
        {id === "leads" && aguardando > 0 ? <span className="contador" aria-label={`${aguardando} aguardando corretor`}>{aguardando}</span>
          : id === "bolsao" && bolsao.total > 0 ? <SeloBolsao total={bolsao.total} novo={bolsaoNovo} />
          : <span />}
      </button>
    );
  };

  return (
    <>
      <header className={`topo ${contaAberta ? "conta-aberta" : ""}${recolhido ? " menu-recolhido" : ""}`}>
        <div className="marca">
          {/* Só a logo: um toque nela volta para o Início. */}
          <a className="marca-link" href="#inicio" onClick={(e) => { e.preventDefault(); ir("inicio"); }} aria-label={`${empresa.nome}: ir para o Início`}>
            <img className={empresa.logo_url ? "logo-propria" : ""} src={logoDaEmpresa(empresa, tema === "escuro")} alt="" />
          </a>
          <h1 className="invisivel">Central de Atendimento da {empresa.nome}</h1>
        </div>
        <button type="button" className="abrir-busca" onClick={() => setBuscaAberta(true)} aria-label="Busca rápida (Ctrl+K)">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>
          <span className="abrir-busca-texto">Buscar lead, imóvel ou tela</span>
          <kbd className="abrir-busca-atalho">Ctrl K</kbd>
        </button>
        <button type="button" className="botao-conta" aria-expanded={contaAberta} aria-controls="menu-conta" aria-label="Minha conta" onClick={() => setContaAberta(!contaAberta)}>
          {eu.foto_url ? <img src={eu.foto_url} alt="" /> : iniciais(eu.nome)}
        </button>
        <div className="topo-direita" id="menu-conta">
          {contaAberta && <BotaoFechar className="fechar-conta" aoFechar={() => setContaAberta(false)} rotulo="Fechar minha conta" />}
          <span className="pilula ok"><i />IA atendendo</span>
          <div className="tema" role="group" aria-label="Tema da tela">
            <button type="button" aria-pressed={tema === "claro"} onClick={() => escolherTema("claro")}>Claro</button>
            <button type="button" aria-pressed={tema === "escuro"} onClick={() => escolherTema("escuro")}>Escuro</button>
          </div>
          <div className="usuario">
            <div><b>{eu.nome}</b><span className="mudo">{nomeDoPapel(eu.papel)}{eu.no_rodizio ? ` · ${eu.de_plantao ? "de plantão" : "fora do plantão"}` : ""}</span></div>
            <button type="button" className="botao secundario pequeno" onClick={sair}>Sair</button>
          </div>
        </div>
      </header>
      {(contaAberta || maisAberto) && <div className="veu" onClick={() => { setContaAberta(false); setMaisAberto(false); }} aria-hidden="true" />}
      <BuscaRapida
        aberto={buscaAberta}
        aoFechar={() => setBuscaAberta(false)}
        telas={MENU.filter(([id]) => podeVer(id, eu.papel))}
        ir={ir}
        buscaLeads={podeVer("leads", eu.papel)}
      />
      <div className={`estrutura${recolhido ? " menu-recolhido" : ""}`}>
        <nav className="trilho" aria-label="Menu">
          {GRUPOS.map(([grupo, ids]) => {
            const itens = ids.filter((id) => podeVer(id, eu.papel));
            if (!itens.length) return null;
            return (
              <div key={grupo} className="grupo-menu" role="group" aria-label={grupo}>
                <span className="titulo-grupo" aria-hidden="true">{grupo}</span>
                {itens.map((id) => botaoDoMenu(id, noMais(id, eu.papel) ? "so-computador" : ""))}
              </div>
            );
          })}
          <button type="button" className="recolher-menu so-computador" aria-pressed={recolhido} title={recolhido ? "Mostrar os nomes do menu" : "Recolher o menu"} onClick={() => recolher(!recolhido)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" />{recolhido ? <path d="m13 10 2 2-2 2" /> : <path d="m16 10-2 2 2 2" />}</svg>
            <span className="nome-longo">{recolhido ? "Mostrar nomes" : "Recolher menu"}</span>
            <span />
          </button>
          {itensDoMais.length > 0 && (
            <button type="button" className="so-celular" aria-expanded={maisAberto} aria-current={noMais(endereco.vista, eu.papel) ? "page" : undefined} onClick={() => { setMaisAberto(!maisAberto); setContaAberta(false); }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">{ICONE_MAIS}</svg>
              <span className="nome-curto">Mais</span>
              {itensDoMais.includes("bolsao") && bolsao.total > 0 ? <SeloBolsao total={bolsao.total} novo={bolsaoNovo} /> : <span />}
            </button>
          )}
        </nav>
        {maisAberto && (
          <div className="folha-mais" role="dialog" aria-label="Mais telas">
            <div className="cabeca-folha"><b>Mais telas</b><BotaoFechar aoFechar={() => setMaisAberto(false)} rotulo="Fechar o menu Mais" /></div>
            {itensDoMais.map((id) => {
              const [, titulo, subtitulo, icone] = itemDoMenu(id);
              return (
                <button key={id} type="button" aria-current={endereco.vista === id ? "page" : undefined} onClick={() => ir(id)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">{icone}</svg>
                  <span><b>{titulo}</b><small>{subtitulo}</small></span>
                  {id === "bolsao" && bolsao.total > 0 && <SeloBolsao total={bolsao.total} novo={bolsaoNovo} />}
                </button>
              );
            })}
          </div>
        )}
        <main>
          <AvisoNotificacoes />
          {paginas[endereco.vista]}
        </main>
      </div>
    </>
  );
}

// Número de leads no Bolsão; com lead que a pessoa ainda não viu, ganha o ponto verde pulsando.
function SeloBolsao({ total, novo }) {
  return (
    <span className={`contador contador-bolsao${novo ? " novo" : ""}`} aria-label={`${total} no Bolsão${novo ? ", com lead novo" : ""}`}>
      {novo && <i aria-hidden="true" />}{total}
    </span>
  );
}
