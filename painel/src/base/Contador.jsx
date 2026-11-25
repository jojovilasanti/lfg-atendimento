// Número que rola até o valor novo (ideia do Counter do React Bits, sem
// dependências). Para quem pede menos movimento, troca direto.
import { useEffect, useRef, useState } from "react";

const menosMovimento = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const formato = new Intl.NumberFormat("pt-BR");

export default function Contador({ valor, duracao = 900, formatar = (n) => formato.format(n) }) {
  const alvo = Number(valor) || 0;
  const [mostrado, setMostrado] = useState(menosMovimento() ? alvo : 0);
  const atual = useRef(mostrado);

  useEffect(() => {
    if (menosMovimento()) {
      atual.current = alvo;
      setMostrado(alvo);
      return undefined;
    }
    const de = atual.current;
    const inicio = performance.now();
    let quadro;
    const passo = (agora) => {
      const p = Math.min((agora - inicio) / duracao, 1);
      const v = Math.round(de + (alvo - de) * (1 - (1 - p) ** 3));
      atual.current = v;
      setMostrado(v);
      if (p < 1) quadro = requestAnimationFrame(passo);
    };
    quadro = requestAnimationFrame(passo);
    return () => cancelAnimationFrame(quadro);
  }, [alvo, duracao]);

  // O leitor de tela lê o valor final, não os números intermediários.
  return (
    <>
      <span aria-hidden="true">{formatar(mostrado)}</span>
      <span className="invisivel">{formatar(alvo)}</span>
    </>
  );
}
