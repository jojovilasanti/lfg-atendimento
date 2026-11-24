import { useEffect, useState } from "react";
import { Erro } from "./comum.jsx";
import { ativar, garantirEmSilencio, iphoneSemInstalar, situacao, testar } from "./notificacoes.js";
import { useSessao } from "./sessao.jsx";
import { mensagemDeErro } from "./supabase.js";

const DISPENSADO = "lfg-aviso-notificacoes-dispensado";

const TEXTO_IPHONE =
  "No iPhone, primeiro instale o painel: toque em Compartilhar e depois em \"Adicionar à Tela de Início\". Abra pelo ícone LFG Central e ative aqui.";

function useSituacao() {
  const [estado, setEstado] = useState(null);
  const atualizar = () => situacao().then(setEstado).catch(() => setEstado("sem_suporte"));
  useEffect(() => {
    atualizar();
  }, []);
  return [estado, atualizar];
}

// Faixa no topo do painel só enquanto este aparelho ainda não decidiu.
// Com a permissão já dada, não mostra nada e refaz a inscrição em silêncio.
export function AvisoNotificacoes() {
  const [estado, atualizar] = useSituacao();
  const { eu } = useSessao();
  useEffect(() => {
    if (!eu?.id) return;
    garantirEmSilencio().catch((erro) => console.warn("Inscrição das notificações não renovada", erro));
  }, [eu?.id]);
  const [dispensado, setDispensado] = useState(() => {
    try {
      return localStorage.getItem(DISPENSADO) === "sim";
    } catch {
      return false;
    }
  });
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState(null);
  const iphone = iphoneSemInstalar();

  if (dispensado || (estado !== "nao_decidido" && !(iphone && estado === "sem_suporte"))) return null;

  const dispensar = () => {
    try {
      localStorage.setItem(DISPENSADO, "sim");
    } catch {
      // sem armazenamento: some só nesta visita
    }
    setDispensado(true);
  };
  const ligar = async () => {
    setOcupado(true);
    setErro(null);
    try {
      await ativar();
      await atualizar();
    } catch (e) {
      setErro(mensagemDeErro(e));
    } finally {
      setOcupado(false);
    }
  };

  return (
    <div className="aviso-notificacoes" role="region" aria-label="Notificações">
      <div>
        <b>Receba um aviso quando o cliente responder</b>
        <p>{iphone ? TEXTO_IPHONE : "Como no WhatsApp: a notificação aparece mesmo com o painel fechado ou minimizado."}</p>
        <Erro mensagem={erro} />
      </div>
      <div className="acoes">
        {!iphone && <button type="button" className="botao" onClick={ligar} disabled={ocupado}>{ocupado ? "Ativando…" : "Ativar notificações"}</button>}
        <button type="button" className="botao secundario" onClick={dispensar}>Agora não</button>
      </div>
    </div>
  );
}

// Em Meu perfil: mostra a situação, ativa e testa neste aparelho. Não há botão de
// desligar: quem quiser desliga pelas configurações do celular ou do navegador.
export function PainelNotificacoes() {
  const [estado, atualizar] = useSituacao();
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState(null);
  const [mensagem, setMensagem] = useState(null);
  const iphone = iphoneSemInstalar();

  async function agir(acao, sucesso) {
    setOcupado(true);
    setErro(null);
    setMensagem(null);
    try {
      await acao();
      setMensagem(sucesso);
      await atualizar();
    } catch (e) {
      setErro(mensagemDeErro(e));
    } finally {
      setOcupado(false);
    }
  }

  const descricao = {
    ativas: "Ligadas neste aparelho. Você recebe um aviso quando o cliente de um lead seu responder e quando um lead for oferecido a você. Para desligar, use as configurações do celular ou do navegador.",
    nao_decidido: "Ainda não ativadas neste aparelho.",
    bloqueadas: "Bloqueadas neste aparelho. Para liberar, abra as configurações do app no celular, ou toque no cadeado ao lado do endereço do painel no navegador, e permita as notificações.",
    sem_suporte: iphone ? TEXTO_IPHONE : "Este navegador não recebe notificações. No celular, use o Chrome (Android) ou instale o painel na Tela de Início (iPhone).",
  }[estado];

  return (
    <div className="painel" style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 520 }}>
      <h3 style={{ margin: 0 }}>Notificações</h3>
      <p className="mudo pequeno" style={{ margin: 0 }}>{estado ? descricao : "Conferindo…"}</p>
      <Erro mensagem={erro} />
      {mensagem && <p className="aviso-ok" role="status" style={{ margin: 0 }}>{mensagem}</p>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {estado === "nao_decidido" && (
          <button type="button" className="botao" disabled={ocupado} onClick={() => agir(ativar, "Notificações ligadas neste aparelho.")}>Ativar notificações</button>
        )}
        {estado === "ativas" && (
          <button type="button" className="botao" disabled={ocupado} onClick={() => agir(async () => { await garantirEmSilencio(); await testar(); }, "Notificação de teste enviada. Ela aparece em alguns segundos.")}>Enviar um teste</button>
        )}
      </div>
    </div>
  );
}
