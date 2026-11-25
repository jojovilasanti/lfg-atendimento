// Escolha entre poucas opções (filtros, formas de ver a lista). A marcação
// desliza até a opção escolhida com um leve "elástico" (ideia do RubberSegment
// do React Bits, feito com CSS, sem dependências).
// opcoes: [{ id, rotulo, conta? }]
import { useLayoutEffect, useRef, useState } from "react";

export default function Segmento({ opcoes, valor, aoMudar, rotulo, pequeno = false }) {
  const caixa = useRef(null);
  const [marca, setMarca] = useState(null);

  useLayoutEffect(() => {
    const medir = () => {
      const botao = caixa.current?.querySelector(`[data-id="${CSS.escape(String(valor))}"]`);
      if (botao) setMarca({ left: botao.offsetLeft, width: botao.offsetWidth });
    };
    medir();
    const observador = new ResizeObserver(medir);
    if (caixa.current) observador.observe(caixa.current);
    return () => observador.disconnect();
  }, [valor, opcoes]);

  return (
    <div ref={caixa} className={`segmento${pequeno ? " pequeno" : ""}`} role="group" aria-label={rotulo}>
      {marca && <span className="segmento-marca" style={{ transform: `translateX(${marca.left}px)`, width: marca.width }} aria-hidden="true" />}
      {opcoes.map((o) => (
        <button key={o.id} data-id={o.id} type="button" aria-pressed={valor === o.id} onClick={() => aoMudar(o.id)}>
          {o.rotulo}
          {o.conta != null && <b>{o.conta}</b>}
        </button>
      ))}
    </div>
  );
}
