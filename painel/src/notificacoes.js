// Notificações do sistema (Web Push) neste navegador: o service worker
// (public/sw.js) recebe e mostra; aqui o painel pede permissão e guarda a
// inscrição no banco, ligada a quem está logado.
//
// A escolha é do aparelho: depois que a pessoa permite, o painel não pergunta mais.
// A cada abertura, refaz a inscrição em silêncio e grava no banco para quem entrou.
// Ao sair da conta, o aparelho só se desliga daquela pessoa no banco; no próximo
// login ele volta sozinho. Desligar de vez é pelas configurações do celular ou navegador.
import { chamarPainel, exigir, supabase } from "./supabase.js";

export const suportado = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

// No iPhone, notificação só funciona com o painel instalado na Tela de Início.
export const iphoneSemInstalar = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) && !window.matchMedia("(display-mode: standalone)").matches && !navigator.standalone;

export function registrarServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").catch((erro) => console.warn("Service worker não registrado", erro));
  // Toque numa notificação com o painel já aberto: só troca de tela.
  navigator.serviceWorker.addEventListener("message", (evento) => {
    const destino = evento.data?.abrir;
    if (destino) location.hash = new URL(destino).hash;
  });
}

async function inscricaoAtual() {
  const registro = await navigator.serviceWorker.ready;
  return registro.pushManager.getSubscription();
}

// "ativas", "bloqueadas" (a pessoa negou no aparelho), "nao_decidido" (ainda não
// perguntamos) ou "sem_suporte".
export async function situacao() {
  if (!suportado()) return "sem_suporte";
  if (Notification.permission === "denied") return "bloqueadas";
  if (Notification.permission !== "granted") return "nao_decidido";
  return "ativas";
}

function chaveEmBytes(base64) {
  const limpo = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(limpo), (c) => c.charCodeAt(0));
}

// Inscreve este aparelho (ou reaproveita a inscrição que já existe) e grava no
// banco para quem está logado. Só com a permissão já dada.
async function inscreverEGravar() {
  const registro = await navigator.serviceWorker.ready;
  let inscricao = await registro.pushManager.getSubscription();
  if (!inscricao) {
    const { chave } = await chamarPainel("chave_push");
    inscricao = await registro.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: chaveEmBytes(chave) });
  }
  const { endpoint, keys } = inscricao.toJSON();
  exigir(await supabase.rpc("registrar_notificacoes", { p_endpoint: endpoint, p_p256dh: keys.p256dh, p_auth: keys.auth, p_aparelho: navigator.userAgent }));
}

// Precisa vir de um toque da pessoa (o navegador só pergunta assim).
export async function ativar() {
  const permissao = await Notification.requestPermission();
  if (permissao !== "granted") throw new Error("As notificações ficaram bloqueadas. Libere nas configurações do celular ou do navegador.");
  await inscreverEGravar();
}

// Ao abrir o painel: com a permissão já dada, garante a inscrição sem perguntar nada.
export async function garantirEmSilencio() {
  if ((await situacao()) !== "ativas") return false;
  await inscreverEGravar();
  return true;
}

// Ao sair da conta: este aparelho para de receber os avisos dessa pessoa, mas
// continua inscrito no navegador para o próximo login.
export async function desligarDaConta() {
  if (!suportado()) return;
  const inscricao = await inscricaoAtual();
  if (inscricao) await supabase.rpc("cancelar_notificacoes", { p_endpoint: inscricao.endpoint });
}

export async function testar() {
  const { entregues } = await chamarPainel("testar_push");
  if (!entregues) throw new Error("Nenhum aparelho recebeu. Ative as notificações neste aparelho primeiro.");
  return entregues;
}
