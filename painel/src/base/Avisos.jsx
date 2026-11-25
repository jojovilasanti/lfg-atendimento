// Avisos curtos no rodapé da tela ("Lead passado para Julio"), com opção de
// desfazer. Uma barra fina mostra quanto tempo falta para o aviso sumir
// (ideia do SwipeToast / FuseButton do React Bits, sem dependências).
//   const avisar = useAviso();
//   avisar("Lead finalizado", { desfazer: () => ..., tipo: "ok" | "erro" });
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

const Contexto = createContext(() => {});
const DURACAO_MS = 5000;

export function AvisosProvider({ children }) {
  const [aviso, setAviso] = useState(null);
  const tempo = useRef(null);

  const fechar = useCallback(() => {
    clearTimeout(tempo.current);
    setAviso(null);
  }, []);

  const avisar = useCallback((texto, opcoes = {}) => {
    clearTimeout(tempo.current);
    const duracao = opcoes.duracao ?? (opcoes.desfazer ? DURACAO_MS + 2000 : DURACAO_MS);
    setAviso({ id: Date.now(), texto, tipo: opcoes.tipo ?? "ok", desfazer: opcoes.desfazer, duracao });
    tempo.current = setTimeout(() => setAviso(null), duracao);
  }, []);

  useEffect(() => () => clearTimeout(tempo.current), []);

  return (
    <Contexto.Provider value={avisar}>
      {children}
      <div className="avisos" aria-live="polite">
        {aviso && (
          <div key={aviso.id} className={`aviso-flutuante ${aviso.tipo}`} role={aviso.tipo === "erro" ? "alert" : "status"} style={{ "--duracao": `${aviso.duracao}ms` }}>
            <span>{aviso.texto}</span>
            {aviso.desfazer && (
              <button type="button" onClick={() => { aviso.desfazer(); fechar(); }}>Desfazer</button>
            )}
            <button type="button" className="fechar-aviso" aria-label="Fechar aviso" onClick={fechar}>×</button>
            <i className="pavio" aria-hidden="true" />
          </div>
        )}
      </div>
    </Contexto.Provider>
  );
}

export const useAviso = () => useContext(Contexto);
