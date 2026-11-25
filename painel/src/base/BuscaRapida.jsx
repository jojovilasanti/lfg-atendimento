import { useEffect, useMemo, useRef, useState } from "react";
import { telefone } from "../comum.jsx";
import { supabase } from "../supabase.js";

// Busca rápida (Ctrl+K ou ⌘K): leva para uma tela, um lead ou um imóvel sem
// passar pelo menu. Só procura o que a pessoa já pode ver (o banco filtra o resto).
const semAcento = (texto) => String(texto ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const ICONE_LEAD = <g><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" /></g>;
const ICONE_IMOVEL = <g><path d="M4 21V9l8-6 8 6v12" /><path d="M9 21v-6h6v6" /></g>;

export default function BuscaRapida({ aberto, aoFechar, telas, ir, buscaLeads }) {
  const [termo, setTermo] = useState("");
  const [leads, setLeads] = useState([]);
  const [imoveis, setImoveis] = useState([]);
  const [marcado, setMarcado] = useState(0);
  const campo = useRef(null);
  const lista = useRef(null);

  useEffect(() => {
    if (!aberto) return;
    setTermo("");
    setLeads([]);
    setImoveis([]);
    setMarcado(0);
    setTimeout(() => campo.current?.focus(), 20);
  }, [aberto]);

  // Leads e imóveis vêm do banco, com uma pequena espera entre as teclas.
  useEffect(() => {
    const t = termo.trim();
    if (!aberto || t.length < 2) {
      setLeads([]);
      setImoveis([]);
      return;
    }
    let vivo = true;
    const espera = setTimeout(async () => {
      const digitos = t.replace(/\D/g, "");
      const filtroTexto = t.replace(/[%,()]/g, " ");
      const pedidos = [
        supabase.from("imoveis").select("codigo, referencia, tipo, bairro").eq("ativo", true).ilike("referencia", `%${filtroTexto}%`).limit(5),
      ];
      if (buscaLeads) {
        const ou = [`nome.ilike.%${filtroTexto}%`, ...(digitos.length >= 4 ? [`whatsapp.like.%${digitos}%`] : [])].join(",");
        pedidos.push(
          supabase.from("leads").select("id, nome, whatsapp, status").or(ou).not("whatsapp", "like", "sim-%").order("ultima_mensagem_em", { ascending: false, nullsFirst: false }).limit(6),
        );
      }
      const [rImoveis, rLeads] = await Promise.all(pedidos);
      if (!vivo) return;
      setImoveis(rImoveis.data ?? []);
      setLeads(rLeads?.data ?? []);
    }, 180);
    return () => {
      vivo = false;
      clearTimeout(espera);
    };
  }, [termo, aberto, buscaLeads]);

  const itens = useMemo(() => {
    const t = semAcento(termo.trim());
    const deTelas = telas
      .filter(([, titulo, subtitulo]) => !t || semAcento(`${titulo} ${subtitulo}`).includes(t))
      .slice(0, t ? 6 : 8)
      .map(([id, titulo, subtitulo, icone]) => ({ chave: `t-${id}`, grupo: "Telas", titulo, sub: subtitulo, icone, ir: () => ir(id) }));
    const deLeads = leads.map((l) => ({
      chave: `l-${l.id}`, grupo: "Leads", titulo: l.nome ?? "Cliente sem nome", sub: telefone(l.whatsapp), icone: ICONE_LEAD, ir: () => ir("leads", l.id),
    }));
    const deImoveis = imoveis.map((i) => ({
      chave: `i-${i.codigo}`, grupo: "Imóveis", titulo: i.referencia, sub: [i.tipo, i.bairro].filter(Boolean).join(" · "), icone: ICONE_IMOVEL, ir: () => ir("imoveis", i.codigo),
    }));
    return [...deTelas, ...deLeads, ...deImoveis];
  }, [termo, telas, leads, imoveis, ir]);

  useEffect(() => setMarcado(0), [itens.length]);
  useEffect(() => {
    lista.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [marcado]);

  if (!aberto) return null;

  const escolher = (item) => {
    aoFechar();
    item.ir();
  };
  const tecla = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setMarcado((m) => Math.min(m + 1, itens.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setMarcado((m) => Math.max(m - 1, 0));
    } else if (e.key === "Enter" && itens[marcado]) {
      e.preventDefault();
      escolher(itens[marcado]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      aoFechar();
    }
  };

  let grupoAnterior = null;
  return (
    <div className="busca-rapida-fundo" onPointerDown={(e) => e.target === e.currentTarget && aoFechar()}>
      <div className="busca-rapida" role="dialog" aria-modal="true" aria-label="Busca rápida">
        <div className="busca-rapida-campo">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>
          <input
            ref={campo}
            autoFocus
            type="search"
            role="combobox"
            aria-expanded="true"
            aria-controls="busca-rapida-lista"
            aria-activedescendant={itens[marcado] ? `br-${itens[marcado].chave}` : undefined}
            placeholder={buscaLeads ? "Buscar tela, lead (nome ou número) ou imóvel (referência)" : "Buscar tela ou imóvel (referência)"}
            value={termo}
            onChange={(e) => setTermo(e.target.value)}
            onKeyDown={tecla}
          />
          <kbd>Esc</kbd>
        </div>
        <ul className="busca-rapida-lista" id="busca-rapida-lista" role="listbox" ref={lista}>
          {itens.length === 0 && <li className="busca-rapida-vazio">{termo.trim().length < 2 ? "Digite para buscar." : "Nada encontrado."}</li>}
          {itens.map((item, n) => {
            const titulo = item.grupo !== grupoAnterior ? item.grupo : null;
            grupoAnterior = item.grupo;
            return (
              <li key={item.chave} role="presentation">
                {titulo && <span className="busca-rapida-grupo">{titulo}</span>}
                <button
                  type="button"
                  id={`br-${item.chave}`}
                  role="option"
                  aria-selected={n === marcado}
                  onMouseMove={() => setMarcado(n)}
                  onClick={() => escolher(item)}
                >
                  <span className="busca-rapida-icone" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">{item.icone}</svg>
                  </span>
                  <span className="busca-rapida-texto"><b>{item.titulo}</b>{item.sub && <small>{item.sub}</small>}</span>
                  {n === marcado && <kbd aria-hidden="true">↵</kbd>}
                </button>
              </li>
            );
          })}
        </ul>
        <p className="busca-rapida-dica"><kbd>↑</kbd><kbd>↓</kbd> para escolher · <kbd>Enter</kbd> para abrir · <kbd>Ctrl</kbd>+<kbd>K</kbd> abre de qualquer tela</p>
      </div>
    </div>
  );
}
