import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./estilo.css";
import { registrarServiceWorker } from "./notificacoes.js";
import { SessaoProvider } from "./sessao.jsx";

registrarServiceWorker();

createRoot(document.getElementById("raiz")).render(
  <StrictMode>
    <SessaoProvider>
      <App />
    </SessaoProvider>
  </StrictMode>,
);
