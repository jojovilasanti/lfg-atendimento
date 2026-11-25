import { useEffect, useRef, useState } from "react";
import { mensagemDeErro } from "./supabase.js";

// Nome do perfil para mostrar na tela.
export const PAPEIS = { gestor: "Gestor", administrativo: "Administrativo", corretor: "Corretor" };
export const nomeDoPapel = (papel) => PAPEIS[papel] ?? "Corretor";

// Fuso das Configurações gerais; troca quando o painel lê a configuração da empresa.
const FUSO = { timeZone: "America/Campo_Grande" };
export function definirFuso(fuso) {
  try {
    new Intl.DateTimeFormat("pt-BR", { timeZone: fuso });
    FUSO.timeZone = fuso;
  } catch {
    // Fuso desconhecido pelo navegador: fica o anterior.
  }
}

export const hora = (iso) => (iso ? new Date(iso).toLocaleTimeString("pt-BR", { ...FUSO, hour: "2-digit", minute: "2-digit" }) : "—");
export const dataHora = (iso) =>
  iso ? new Date(iso).toLocaleString("pt-BR", { ...FUSO, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
export const reais = (n) => (n == null ? "—" : Number(n).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }));
export const decimal = (n, casas = 1) => (n == null ? "—" : Number(n).toFixed(casas).replace(".", ","));

export function haQuanto(iso) {
  if (!iso) return "—";
  const minutos = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutos < 1) return "agora";
  if (minutos < 60) return `há ${minutos} min`;
  const horas = Math.round(minutos / 60);
  if (horas < 24) return `há ${horas} h`;
  return dataHora(iso);
}

export function telefone(numero) {
  if (!numero || numero.startsWith("sim-")) return numero ?? "—";
  const d = numero.replace(/\D/g, "").replace(/^55/, "");
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return numero;
}

const diaNoFuso = (data) => data.toLocaleDateString("en-CA", FUSO);

// "Hoje 14:00", "Amanhã 09:30" ou "12/11, 10:00".
export function quando(iso) {
  if (!iso) return "—";
  const dias = Math.round((Date.parse(diaNoFuso(new Date(iso))) - Date.parse(diaNoFuso(new Date()))) / 86400000);
  if (dias === 0) return `Hoje ${hora(iso)}`;
  if (dias === 1) return `Amanhã ${hora(iso)}`;
  if (dias === -1) return `Ontem ${hora(iso)}`;
  return dataHora(iso);
}

// Dia no fuso da empresa: "2026-11-20" e "sexta-feira, 20/11".
export const diaIso = (iso) => diaNoFuso(new Date(iso));
export const hojeIso = () => diaNoFuso(new Date());
export const diaPorExtenso = (iso) => new Date(iso).toLocaleDateString("pt-BR", { ...FUSO, weekday: "long", day: "2-digit", month: "2-digit" });

// "2026-11-24" + "10:30" no fuso da empresa → instante ISO (o celular pode estar em outro fuso).
export function instanteNoFuso(dia, hhmm) {
  const [a, m, d] = dia.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const palpite = Date.UTC(a, m - 1, d, h, mi);
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { ...FUSO, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(new Date(palpite)).map((p) => [p.type, p.value]),
  );
  const comoLocal = Date.UTC(+partes.year, +partes.month - 1, +partes.day, +partes.hour, +partes.minute);
  return new Date(palpite - (comoLocal - palpite)).toISOString();
}

export const jaVenceu = (iso) => new Date(iso).getTime() <= Date.now();
// Vence hoje ou já venceu, no horário de Campo Grande.
export const venceAteHoje = (iso) => diaNoFuso(new Date(iso)) <= diaNoFuso(new Date());

export function diasDesde(iso) {
  if (!iso) return "—";
  const dias = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (dias < 1) return "desde hoje";
  return dias === 1 ? "há 1 dia" : `há ${dias} dias`;
}

export const iniciais = (nome) => (nome ? nome.trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase() : "?");

// Texto do WhatsApp: *negrito* e links. Escapa tudo antes de marcar.
export function TextoWhatsApp({ texto }) {
  const partes = [];
  const regex = /(\*[^*\n]+\*)|(https?:\/\/[^\s]+)/g;
  let ultimo = 0;
  let achado;
  while ((achado = regex.exec(texto ?? ""))) {
    if (achado.index > ultimo) partes.push(texto.slice(ultimo, achado.index));
    if (achado[1]) partes.push(<strong key={achado.index}>{achado[1].slice(1, -1)}</strong>);
    else partes.push(<a key={achado.index} href={achado[2]} target="_blank" rel="noopener noreferrer">{achado[2]}</a>);
    ultimo = regex.lastIndex;
  }
  if (ultimo < (texto ?? "").length) partes.push(texto.slice(ultimo));
  return <>{partes}</>;
}

const SITUACAO = {
  novo: ["Novo", "pendente"],
  em_atendimento_ia: ["Com a IA", "azul"],
  aguardando_corretor: ["Aguardando corretor", "alerta"],
  com_corretor: ["Com corretor", "pronto"],
  encerrado: ["Encerrado", "pendente"],
};
export const TIPOS = ["CASA", "APARTAMENTO", "TERRENO", "CHACARA", "COMERCIAL", "BARRACAO", "GALPAO"];
const NOMES_DOS_TIPOS = { CHACARA: "Chácara", BARRACAO: "Barracão", GALPAO: "Galpão", SALAO: "Salão", "TWO STORY HOUSE": "Sobrado", PONTO: "Ponto comercial", AREA: "Área" };
export const nomeTipo = (t) => (t ? NOMES_DOS_TIPOS[t] ?? t.charAt(0) + t.slice(1).toLowerCase() : "");
export const OPERACAO = { compra: "Compra", locacao: "Aluguel", administrativo: "Administrativo", outro: "Outro" };

export function Situacao({ status }) {
  const [texto, cor] = SITUACAO[status] ?? [status, "pendente"];
  return <span className={`etiqueta ${cor}`}>{texto}</span>;
}

export function Temperatura({ valor }) {
  return (
    <span className={`temp ${valor ?? "nenhuma"}`}>
      <i />
      {valor ?? "a definir"}
    </span>
  );
}

// Botão "X" de fechar (44 × 44, no canto de popups, menus e telas abertas).
export function BotaoFechar({ aoFechar, rotulo = "Fechar", desativado = false, className = "" }) {
  return (
    <button type="button" className={`botao-fechar ${className}`} aria-label={rotulo} title={rotulo} disabled={desativado} onClick={aoFechar}>
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
    </button>
  );
}

// Fecha com a tecla Esc enquanto estiver aberto.
export function useFecharComEsc(aberto, aoFechar) {
  const fechar = useRef(aoFechar);
  fechar.current = aoFechar;
  useEffect(() => {
    if (!aberto) return;
    const tecla = (e) => e.key === "Escape" && fechar.current();
    window.addEventListener("keydown", tecla);
    return () => window.removeEventListener("keydown", tecla);
  }, [aberto]);
}

// Fecha ao tocar ou clicar fora do elemento (menus que não são janelas).
export function useFecharAoTocarFora(ref, aberto, aoFechar) {
  const fechar = useRef(aoFechar);
  fechar.current = aoFechar;
  useEffect(() => {
    if (!aberto) return;
    const toque = (e) => ref.current && !ref.current.contains(e.target) && fechar.current();
    document.addEventListener("pointerdown", toque);
    return () => document.removeEventListener("pointerdown", toque);
  }, [aberto, ref]);
}

// Enquanto carrega: o desenho da tela em cinza (esqueleto), e o texto só para o leitor de tela.
export function Carregando({ texto = "Carregando…", linhas = 3 }) {
  return (
    <div className="esqueleto" role="status">
      <span className="invisivel">{texto}</span>
      {Array.from({ length: linhas }, (_, i) => <i key={i} style={{ width: `${[92, 76, 84, 60][i % 4]}%` }} />)}
    </div>
  );
}

export function Erro({ mensagem }) {
  return mensagem ? <p className="aviso-erro" role="alert">{mensagem}</p> : null;
}

export function Interruptor({ ligado, aoMudar, rotulo, desativado }) {
  return (
    <button type="button" role="switch" className="interruptor" aria-checked={ligado} aria-label={rotulo} disabled={desativado} onClick={() => aoMudar(!ligado)} />
  );
}

// Carrega dados e recarrega quando alguma dependência muda (inclusive a
// versão do tempo real). Mantém os dados antigos na tela enquanto atualiza.
export function useCarregar(carregar, dependencias) {
  const [estado, setEstado] = useState({ dados: undefined, erro: null });
  useEffect(() => {
    let vivo = true;
    carregar()
      .then((dados) => vivo && setEstado({ dados, erro: null }))
      .catch((erro) => vivo && setEstado((anterior) => ({ ...anterior, erro: mensagemDeErro(erro) })));
    return () => {
      vivo = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, dependencias);
  return estado;
}

// Tela de celular (mesmo corte do estilo.css), para textos que mudam de tamanho.
const CELULAR = "(max-width: 760px)";
export function useEhCelular() {
  const [celular, setCelular] = useState(() => window.matchMedia?.(CELULAR).matches ?? false);
  useEffect(() => {
    const consulta = window.matchMedia?.(CELULAR);
    if (!consulta) return;
    const aoMudar = () => setCelular(consulta.matches);
    consulta.addEventListener("change", aoMudar);
    return () => consulta.removeEventListener("change", aoMudar);
  }, []);
  return celular;
}

// Relógio que anda a cada segundo, para contagens regressivas.
export function useAgora(intervaloMs = 1000) {
  const [agora, setAgora] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setAgora(Date.now()), intervaloMs);
    return () => clearInterval(id);
  }, [intervaloMs]);
  return agora;
}

// Situação de um prazo, com o mesmo nome e a mesma cor em todas as telas:
// No prazo, Atenção (perto de vencer), Atrasado e Finalizado. A cor nunca vem sozinha.
export const PRAZO_ATENCAO_TAREFA = 24 * 60; // próximos passos e demandas: vence nas próximas 24 h
export const PRAZO_ATENCAO_LEAD = 5; // assumir e responder lead: faltam 5 min ou menos

export function situacaoDoPrazo(prazoIso, { finalizado = false, atencaoMin = PRAZO_ATENCAO_TAREFA, agora = Date.now() } = {}) {
  if (finalizado) return ["Finalizado", "pendente"];
  const faltam = (new Date(prazoIso).getTime() - agora) / 60000;
  if (faltam <= 0) return ["Atrasado", "critico"];
  if (faltam <= atencaoMin) return ["Atenção", "alerta"];
  return ["No prazo", "pronto"];
}

export function EtiquetaPrazo({ prazo, finalizado, atencaoMin, agora, children }) {
  const [rotulo, cor] = situacaoDoPrazo(prazo, { finalizado, atencaoMin, agora });
  return <span className={`etiqueta ${cor} etiqueta-prazo`}>{rotulo}{children ? <span className="dado"> · {children}</span> : null}</span>;
}

export function contagem(prazoIso, agora) {
  const restante = Math.max(0, Math.round((new Date(prazoIso).getTime() - agora) / 1000));
  return `${Math.floor(restante / 60)}:${String(restante % 60).padStart(2, "0")}`;
}
