import { useEffect, useRef, useState } from "react";
import { BotaoFechar, Erro, useCarregar } from "./comum.jsx";
import { useSessao } from "./sessao.jsx";
import { exigir, mensagemDeErro, supabase } from "./supabase.js";

export const ETAPAS = [
  ["a_contatar", "A contatar"],
  ["em_contato", "Em contato"],
  ["visita", "Visita"],
  ["proposta", "Proposta"],
  ["fechado", "Fechado"],
  ["perdido", "Perdido"],
];
export const NOME_DA_ETAPA = Object.fromEntries(ETAPAS);
export const etapaFinal = (etapa) => etapa === "fechado" || etapa === "perdido";

// Como chegou o cliente cadastrado à mão.
export const ORIGENS = {
  indicacao: "Indicação",
  telefone: "Ligação",
  placa: "Placa",
  escritorio: "Escritório",
  site: "Site",
  portal: "Portal",
  outro: "Outro",
};
const OUTRAS_ORIGENS = { whatsapp: "WhatsApp", anuncio: "Anúncio", simulador: "Simulador", disparo: "Disparo", compartilhamento: "Compartilhamento" };
export const nomeDaOrigem = (origem) => ORIGENS[origem] ?? OUTRAS_ORIGENS[origem] ?? origem;

// "350.000" e "350000,50" viram número; vazio vira null.
export function valorDigitado(texto) {
  const limpo = String(texto ?? "").replace(/[^\d,.]/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
  return limpo === "" || Number.isNaN(Number(limpo)) ? null : Number(limpo);
}

// Janela (popup) com "X" no canto. Fecha também com Esc e ao tocar fora dela.
// `fecharBloqueado` impede fechar enquanto algo está rodando (ex.: preparando fotos).
export function Janela({ titulo, aoFechar, children, fecharBloqueado = false }) {
  const janela = useRef(null);
  const apertouFora = useRef(false);
  useEffect(() => {
    const atual = janela.current;
    atual.showModal();
    return () => atual.close();
  }, []);
  const fechar = () => { if (!fecharBloqueado) aoFechar(); };
  return (
    <dialog
      ref={janela}
      className="janela"
      aria-label={titulo}
      onCancel={(e) => (e.preventDefault(), fechar())}
      // Só fecha quando o toque começa e termina fora (no fundo escuro):
      // arrastar para selecionar um texto não fecha a janela.
      onPointerDown={(e) => { apertouFora.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && apertouFora.current) fechar(); apertouFora.current = false; }}
    >
      <div className="janela-corpo">
        <div className="janela-cabeca">
          <h3>{titulo}</h3>
          <BotaoFechar aoFechar={fechar} desativado={fecharBloqueado} />
        </div>
        {children}
      </div>
    </dialog>
  );
}

function EncerrarNegociacao({ lead, etapa, aplicar, aoFechar }) {
  const [motivo, setMotivo] = useState("");
  const [detalhe, setDetalhe] = useState("");
  const [valor, setValor] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState(null);
  const perdido = etapa === "perdido";

  const motivos = useCarregar(async () => {
    const linha = exigir(await supabase.from("configuracoes").select("valor").eq("chave", "motivos_perda").maybeSingle());
    return linha?.valor ?? [];
  }, []);

  async function confirmar(evento) {
    evento.preventDefault();
    setOcupado(true);
    setErro(null);
    try {
      const motivoFinal = perdido ? (motivo === "Outro" && detalhe.trim() ? `Outro: ${detalhe.trim()}` : motivo) : null;
      await aplicar(lead.id, etapa, motivoFinal, perdido ? null : valorDigitado(valor));
      aoFechar();
    } catch (e) {
      setErro(mensagemDeErro(e));
      setOcupado(false);
    }
  }

  return (
    <Janela titulo={`${perdido ? "Marcar como perdido" : "Marcar como fechado"}: ${lead.nome ?? "cliente sem nome"}`} aoFechar={aoFechar}>
      <form onSubmit={confirmar} className="formulario">
        {perdido ? (
          <>
            <label className="campo">Motivo
              <select id="motivo-perda" required value={motivo} onChange={(e) => setMotivo(e.target.value)}>
                <option value="">Escolha o motivo</option>
                {(motivos.dados ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
            {motivo === "Outro" && <label className="campo">Qual?<input id="motivo-detalhe" value={detalhe} maxLength={200} onChange={(e) => setDetalhe(e.target.value)} /></label>}
          </>
        ) : (
          <label className="campo">Valor do negócio (opcional)
            <input id="valor-negocio" inputMode="decimal" placeholder="350.000" value={valor} onChange={(e) => setValor(e.target.value)} />
          </label>
        )}
        <p className="mudo pequeno" style={{ margin: 0 }}>Os próximos passos abertos são concluídos. Se o cliente voltar a escrever, a negociação reabre em "A contatar".</p>
        <Erro mensagem={erro ?? motivos.erro} />
        <div className="acoes-formulario">
          <button type="button" className="botao secundario" onClick={aoFechar}>Cancelar</button>
          <button type="submit" className="botao" disabled={ocupado}>{ocupado ? "Salvando…" : "Confirmar"}</button>
        </div>
      </form>
    </Janela>
  );
}

// Fechado e perdido pedem detalhes numa janela; as outras etapas mudam direto.
export function useMudarEtapa() {
  const { recarregar } = useSessao();
  const [pedido, setPedido] = useState(null);
  const [erro, setErro] = useState(null);

  async function aplicar(leadId, etapa, motivo = null, valor = null) {
    exigir(await supabase.rpc("mudar_etapa", { p_lead_id: leadId, p_etapa: etapa, p_motivo: motivo, p_valor: valor }));
    recarregar();
  }

  function pedir(lead, etapa) {
    setErro(null);
    if (etapa === lead.etapa) return;
    if (etapaFinal(etapa)) return setPedido({ lead, etapa });
    aplicar(lead.id, etapa).catch((e) => setErro(mensagemDeErro(e)));
  }

  const janela = pedido && <EncerrarNegociacao {...pedido} aplicar={aplicar} aoFechar={() => setPedido(null)} />;
  return { pedir, janela, erro };
}
