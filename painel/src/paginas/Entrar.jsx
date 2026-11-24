import { useState } from "react";
import { Erro } from "../comum.jsx";
import { logoDaEmpresa, useSessao } from "../sessao.jsx";
import { supabase } from "../supabase.js";

// Tela de entrada: o logo da LFG em destaque e, embaixo, e-mail e senha.
// O acesso de cada pessoa é criado pelo gestor em Configurações → Equipe e acessos.
export default function Entrar() {
  const { empresa } = useSessao();
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState(null);

  async function entrar(evento) {
    evento.preventDefault();
    setEnviando(true);
    setErro(null);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password: senha });
    setEnviando(false);
    if (error) setErro(/invalid/i.test(error.message) ? "E-mail ou senha incorretos." : error.message);
  }

  return (
    <div className="entrada">
      <div className="cartao-entrada">
        <h1 className="invisivel">Entrar no painel da {empresa.nome}</h1>
        <img src={logoDaEmpresa(empresa)} alt={empresa.nome} />
        <form onSubmit={entrar}>
          <label className="campo">
            E-mail
            <input id="entrar-email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="voce@lfgimoveis.com.br" />
          </label>
          <label className="campo">
            Senha
            <input id="entrar-senha" type="password" autoComplete="current-password" required value={senha} onChange={(e) => setSenha(e.target.value)} />
          </label>
          <Erro mensagem={erro} />
          <button className="botao" type="submit" disabled={enviando}>{enviando ? "Entrando…" : "Entrar"}</button>
        </form>
      </div>
    </div>
  );
}
