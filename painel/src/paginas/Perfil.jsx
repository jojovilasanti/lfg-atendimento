import { useEffect, useState } from "react";
import { Erro, nomeDoPapel, telefone } from "../comum.jsx";
import { reduzirFoto } from "../imoveis.js";
import { PainelNotificacoes } from "../Notificacoes.jsx";
import { useSessao } from "../sessao.jsx";
import { chamarGoogle, exigir, mensagemDeErro, supabase } from "../supabase.js";

export const iniciais = (nome) => String(nome ?? "").trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();

// Meu perfil: o que cada pessoa muda sozinha. Papel, situação e rodízio são do gestor.
export default function Perfil({ embutido = false }) {
  const { eu, sessao, recarregar } = useSessao();
  const [campos, setCampos] = useState({ nome: eu.nome, whatsapp: telefone(eu.whatsapp), foto_url: eu.foto_url ?? "" });
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState(null);
  const [aviso, setAviso] = useState(null);
  const mudar = (campo) => (e) => setCampos({ ...campos, [campo]: e.target.value });

  async function salvar(valores = campos) {
    setOcupado(true);
    setErro(null);
    setAviso(null);
    try {
      exigir(await supabase.rpc("atualizar_meu_perfil", { p_nome: valores.nome, p_whatsapp: valores.whatsapp, p_foto_url: valores.foto_url || null }));
      setAviso("Perfil salvo.");
      recarregar();
    } catch (e) {
      setErro(mensagemDeErro(e));
    } finally {
      setOcupado(false);
    }
  }

  async function enviarFoto(evento) {
    const arquivo = evento.target.files?.[0];
    evento.target.value = "";
    if (!arquivo) return;
    setOcupado(true);
    setErro(null);
    try {
      const foto = await reduzirFoto(arquivo, 400, 0.85);
      const caminho = `${eu.id}/foto-${Date.now()}.jpg`;
      exigir(await supabase.storage.from("perfis").upload(caminho, foto, { contentType: "image/jpeg" }));
      const url = supabase.storage.from("perfis").getPublicUrl(caminho).data.publicUrl;
      const anterior = campos.foto_url.split("/object/public/perfis/")[1];
      const novos = { ...campos, foto_url: url };
      setCampos(novos);
      await salvar(novos);
      if (anterior) await supabase.storage.from("perfis").remove([anterior]);
    } catch (e) {
      setErro(mensagemDeErro(e));
      setOcupado(false);
    }
  }

  const conteudo = (
    <div className="formulario" style={{ maxWidth: 560 }}>
      <form className="painel formulario" onSubmit={(e) => { e.preventDefault(); salvar(); }}>
        <h3 style={{ margin: 0 }}>Meus dados</h3>
        <div className="foto-perfil">
          {campos.foto_url ? <img src={campos.foto_url} alt="Sua foto" /> : <span aria-hidden="true">{iniciais(campos.nome)}</span>}
          <label className="botao secundario pequeno">
            {campos.foto_url ? "Trocar foto" : "Enviar foto"}
            <input type="file" accept="image/jpeg,image/png,image/webp" className="invisivel" disabled={ocupado} onChange={enviarFoto} />
          </label>
        </div>
        <label className="campo">Nome<input id="perfil-nome" value={campos.nome} onChange={mudar("nome")} /></label>
        <label className="campo">WhatsApp<input id="perfil-whatsapp" inputMode="tel" value={campos.whatsapp} onChange={mudar("whatsapp")} /></label>
        <dl className="pares">
          <dt>E-mail de acesso</dt><dd>{sessao.user.email}</dd>
          <dt>Perfil</dt><dd>{nomeDoPapel(eu.papel)}</dd>
          {eu.creci && <><dt>CRECI</dt><dd>{eu.creci}</dd></>}
        </dl>
        <p className="mudo pequeno" style={{ margin: 0 }}>Os avisos de lead chegam neste WhatsApp. E-mail, CRECI e perfil, só o gestor muda.</p>
        <Erro mensagem={erro} />
        {aviso && <p className="aviso-ok" role="status" style={{ margin: 0 }}>{aviso}</p>}
        <button className="botao" type="submit" disabled={ocupado} style={{ alignSelf: "flex-start" }}>{ocupado ? "Salvando…" : "Salvar"}</button>
      </form>
      <GoogleAgenda />
      {eu.slug && eu.papel !== "administrativo" && <MinhaPagina slug={eu.slug} />}
      <TrocarSenha />
      <PainelNotificacoes />
    </div>
  );

  if (embutido) return conteudo;
  return (
    <section className="vista" aria-labelledby="t-perfil">
      <div className="cabeca-vista">
        <div>
          <h2 id="t-perfil">Meu perfil</h2>
          <p>Seu nome, foto, contato, senha e notificações.</p>
        </div>
      </div>
      {conteudo}
    </section>
  );
}

// Google Agenda: as demandas e as visitas da pessoa aparecem na agenda do celular.
const RESULTADO_DO_GOOGLE = {
  conectado: ["ok", "Google Agenda conectado. Suas demandas e visitas vão aparecer na sua agenda em alguns segundos."],
  cancelado: ["erro", "A conexão com o Google foi cancelada."],
  expirou: ["erro", "O pedido de conexão expirou. Tente de novo."],
  "sem-permissao": ["erro", "O Google não deu permissão para mexer na agenda. Tente de novo e marque a caixa da agenda."],
  falhou: ["erro", "Não foi possível conectar ao Google. Tente de novo."],
};

function GoogleAgenda() {
  const [conexao, setConexao] = useState(null);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState(null);
  const [aviso, setAviso] = useState(() => {
    const situacao = new URLSearchParams(location.search).get("google");
    if (situacao) history.replaceState(null, "", `${location.pathname}${location.hash}`);
    return RESULTADO_DO_GOOGLE[situacao] ?? null;
  });
  const ler = () => supabase.rpc("minha_conexao_google").then((r) => setConexao(exigir(r))).catch((e) => setErro(mensagemDeErro(e)));
  useEffect(() => { ler(); }, []);

  async function conectar() {
    setOcupado(true);
    setErro(null);
    try {
      const { endereco } = await chamarGoogle("conectar");
      location.href = endereco;
    } catch (e) {
      setErro(mensagemDeErro(e));
      setOcupado(false);
    }
  }
  async function desconectar() {
    setOcupado(true);
    setErro(null);
    setAviso(null);
    try {
      await chamarGoogle("desconectar");
      setAviso(["ok", "Google Agenda desconectado. Os eventos criados pelo painel foram tirados da sua agenda."]);
      await ler();
    } catch (e) {
      setErro(mensagemDeErro(e));
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="painel formulario">
      <h3 style={{ margin: 0 }}>Google Agenda {conexao?.conectado && !conexao.erro && <span className="etiqueta pronto">conectado</span>}</h3>
      <p className="mudo pequeno" style={{ margin: 0 }}>Suas demandas e as visitas em que você é o corretor aparecem na agenda do Google, no celular e no computador. Mudou ou excluiu no painel, muda lá também.</p>
      {aviso && <p className={aviso[0] === "ok" ? "aviso-ok" : "aviso-erro"} role="status" style={{ margin: 0 }}>{aviso[1]}</p>}
      <Erro mensagem={erro} />
      {!conexao ? null : conexao.conectado ? (
        <>
          <p style={{ margin: 0 }}>Conta: <b>{conexao.email ?? "conta Google"}</b></p>
          {conexao.erro && <p className="aviso-erro" style={{ margin: 0 }}>{conexao.erro}</p>}
          <div className="atalhos">
            {conexao.erro && <button type="button" className="botao" disabled={ocupado} onClick={conectar}>Conectar de novo</button>}
            <button type="button" className="botao secundario" disabled={ocupado} onClick={desconectar}>{ocupado ? "Desconectando…" : "Desconectar"}</button>
          </div>
        </>
      ) : (
        <>
          <p className="mudo pequeno" style={{ margin: 0 }}>Ao conectar, o Google pode mostrar "app não verificado": toque em <b>Avançado</b> e depois em <b>Ir para LFG Imóveis</b>.</p>
          <button type="button" className="botao" disabled={ocupado} onClick={conectar} style={{ alignSelf: "flex-start" }}>{ocupado ? "Abrindo o Google…" : "Conectar Google Agenda"}</button>
        </>
      )}
    </div>
  );
}

// Página pública do corretor (gerada com o site; o endereço muda em Configurações → Equipe).
export const enderecoDaPagina = (slug) => `https://lfg.jojodigitals.com/corretor/${slug}`;

function MinhaPagina({ slug }) {
  const [copiado, setCopiado] = useState(false);
  const endereco = enderecoDaPagina(slug);
  async function copiar() {
    try {
      await navigator.clipboard.writeText(endereco);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2000);
    } catch {
      window.prompt("Copie o link:", endereco);
    }
  }
  return (
    <div className="painel formulario">
      <h3 style={{ margin: 0 }}>Minha página</h3>
      <p className="mudo pequeno" style={{ margin: 0 }}>Sua página pública, com sua foto, o botão do seu WhatsApp e os imóveis que você captou. Divulgue nas redes e no WhatsApp: o link aparece com prévia.</p>
      <a className="link-pagina dado" href={endereco} target="_blank" rel="noopener noreferrer">{endereco.replace("https://", "")}</a>
      <div className="atalhos">
        <button type="button" className="botao" onClick={copiar}>{copiado ? "Link copiado" : "Copiar link"}</button>
        <a className="botao secundario" href={endereco} target="_blank" rel="noopener noreferrer">Abrir a página</a>
      </div>
      <p className="mudo pequeno" style={{ margin: 0 }}>Mudou a foto ou um imóvel? A página se atualiza sozinha em alguns minutos.</p>
    </div>
  );
}

function TrocarSenha() {
  const [senha, setSenha] = useState("");
  const [confirmacao, setConfirmacao] = useState("");
  const [mensagem, setMensagem] = useState(null);
  const [erro, setErro] = useState(null);

  async function trocar(evento) {
    evento.preventDefault();
    setMensagem(null);
    setErro(null);
    if (senha.length < 8) return setErro("A senha precisa ter pelo menos 8 caracteres.");
    if (senha !== confirmacao) return setErro("As duas senhas não são iguais.");
    const { error } = await supabase.auth.updateUser({ password: senha });
    if (error) return setErro(error.message);
    setSenha("");
    setConfirmacao("");
    setMensagem("Senha trocada.");
  }

  return (
    <form className="painel formulario" onSubmit={trocar}>
      <h3 style={{ margin: 0 }}>Senha</h3>
      <label className="campo">Nova senha<input id="conta-senha" type="password" autoComplete="new-password" value={senha} onChange={(e) => setSenha(e.target.value)} /></label>
      <label className="campo">Repita a nova senha<input id="conta-confirmacao" type="password" autoComplete="new-password" value={confirmacao} onChange={(e) => setConfirmacao(e.target.value)} /></label>
      <Erro mensagem={erro} />
      {mensagem && <p className="aviso-ok" role="status" style={{ margin: 0 }}>{mensagem}</p>}
      <button className="botao" type="submit" style={{ alignSelf: "flex-start" }}>Trocar senha</button>
    </form>
  );
}
