import { useMemo, useState } from "react";
import { Carregando, dataHora, Erro, useCarregar } from "../comum.jsx";
import { useSessao } from "../sessao.jsx";
import { chamarDisparos, exigir, mensagemDeErro, supabase } from "../supabase.js";

// Disparo em massa, só o gestor. Segue as regras da Meta (modelo aprovado,
// limite diário, saída da lista) e da LGPD (só contatos que autorizaram).

const SITUACAO = {
  rascunho: ["pronto para enviar", "pendente"],
  enviando: ["enviando", "alerta"],
  pausada: ["pausado", "pendente"],
  concluida: ["concluído", "pronto"],
  cancelada: ["cancelado", "pendente"],
};
const NOME_DO_RESULTADO = {
  na_fila: "Na fila", enviado: "Enviadas", entregue: "Entregues", lido: "Lidas", respondeu: "Responderam",
  falhou: "Falharam", descadastrado: "Saíram da lista", ignorado: "Não enviadas",
};
const SITUACAO_DO_MODELO = { APPROVED: ["aprovada", "pronto"], PENDING: ["em análise na Meta", "alerta"], REJECTED: ["recusada", "pendente"], PAUSED: ["pausada pela Meta", "pendente"], DISABLED: ["desativada", "pendente"] };
const QUALIDADE = { GREEN: ["alta", "pronto"], YELLOW: ["média", "alerta"], RED: ["baixa", "pendente"] };

// Aceita CSV, TXT ou colunas coladas do Excel/Google Planilhas: em cada linha,
// o trecho com 10 ou mais dígitos é o telefone; o resto é o nome.
function lerContatos(texto) {
  const contatos = [];
  for (const linha of String(texto).split(/\r?\n/)) {
    if (!linha.trim()) continue;
    const partes = linha.split(/[;,\t|]/).map((p) => p.trim().replace(/^"|"$/g, ""));
    const indiceTelefone = partes.findIndex((p) => p.replace(/\D/g, "").length >= 10);
    if (indiceTelefone < 0) continue;
    const nome = partes.filter((_, i) => i !== indiceTelefone).find((p) => /[a-zà-ú]/i.test(p) && !/@/.test(p)) ?? "";
    contatos.push({ telefone: partes[indiceTelefone], nome });
  }
  return contatos;
}

function NovaMensagem({ aoCriar }) {
  const [nome, setNome] = useState("");
  const [texto, setTexto] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState(null);
  const [feito, setFeito] = useState(null);
  const previa = texto.replace(/\{\{\s*nome\s*\}\}/gi, "Maria");

  async function enviar(evento) {
    evento.preventDefault();
    setOcupado(true);
    setErro(null);
    setFeito(null);
    try {
      await chamarDisparos("criar_modelo", { nome, texto });
      setFeito("Mensagem enviada para a aprovação da Meta. Costuma levar de alguns minutos a 24 horas; ela aparece como aprovada na lista quando liberar.");
      setNome("");
      setTexto("");
      aoCriar();
    } catch (e) {
      setErro(mensagemDeErro(e));
    } finally {
      setOcupado(false);
    }
  }

  return (
    <form className="painel formulario" onSubmit={enviar}>
      <h3 style={{ margin: 0 }}>Nova mensagem para a Meta aprovar</h3>
      <p className="mudo pequeno" style={{ margin: 0 }}>
        Divulgação precisa de mensagem aprovada pela Meta. Seja específico (imóvel, bairro, condição) e evite promessas exageradas, TUDO EM MAIÚSCULAS ou excesso de emojis: isso leva à recusa. Use <code>{"{{nome}}"}</code> para o primeiro nome do contato.
      </p>
      <div className="grade-2">
        <div className="formulario">
          <label className="campo">Nome interno (sem espaços)<input id="modelo-nome" required maxLength={60} placeholder="lancamentos_novembro" value={nome} onChange={(e) => setNome(e.target.value)} /></label>
          <label className="campo">Texto da mensagem
            <textarea id="modelo-texto" required rows={7} maxLength={900} value={texto} onChange={(e) => setTexto(e.target.value)}
              placeholder={"Olá, {{nome}}! Aqui é da LFG Imóveis. Chegaram casas novas de 2 e 3 quartos no Rita Vieira, a partir de R$ 280 mil. Quer que eu te mande as opções?"} />
          </label>
        </div>
        <div className="previa-whatsapp" aria-label="Como a mensagem aparece no WhatsApp">
          <div className="balao">
            <p>{previa || "A prévia aparece aqui."}</p>
            <small>Para não receber mais, toque em Não quero receber.</small>
          </div>
          <div className="botao-balao">Não quero receber</div>
        </div>
      </div>
      <p className="mudo pequeno" style={{ margin: 0 }}>O botão "Não quero receber" vai em toda mensagem de divulgação. Quem tocar nele (ou escrever SAIR) nunca mais recebe disparo.</p>
      <Erro mensagem={erro} />
      {feito && <p className="aviso-ok" role="status" style={{ margin: 0 }}>{feito}</p>}
      <button className="botao" type="submit" disabled={ocupado} style={{ alignSelf: "flex-start" }}>{ocupado ? "Enviando…" : "Enviar para aprovação"}</button>
    </form>
  );
}

function NovoDisparo({ modelos, custo, aoCriar }) {
  const aprovados = modelos.filter((m) => m.situacao === "APPROVED" && m.categoria === "MARKETING" && m.tem_saida);
  const [nome, setNome] = useState("");
  const [modelo, setModelo] = useState("");
  const [lista, setLista] = useState("");
  const [consentimento, setConsentimento] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState(null);
  const [resultado, setResultado] = useState(null);
  const contatos = useMemo(() => lerContatos(lista), [lista]);
  const escolhido = aprovados.find((m) => m.nome === modelo);

  async function lerArquivo(evento) {
    const arquivo = evento.target.files?.[0];
    evento.target.value = "";
    if (!arquivo) return;
    if (arquivo.size > 2 * 1024 * 1024) return setErro("O arquivo precisa ter até 2 MB.");
    setLista(await arquivo.text());
  }

  async function criar(evento) {
    evento.preventDefault();
    setOcupado(true);
    setErro(null);
    try {
      const r = exigir(await supabase.rpc("criar_campanha", {
        p_nome: nome, p_modelo: modelo, p_idioma: escolhido?.idioma ?? "pt_BR", p_texto: escolhido?.texto ?? null,
        p_usa_nome: !!escolhido?.usa_nome, p_contatos: contatos, p_consentimento: consentimento,
      }));
      setResultado(r);
      setNome("");
      setLista("");
      setConsentimento(false);
      aoCriar();
    } catch (e) {
      setErro(mensagemDeErro(e));
    } finally {
      setOcupado(false);
    }
  }

  return (
    <form className="painel formulario" onSubmit={criar}>
      <h3 style={{ margin: 0 }}>Novo disparo</h3>
      <>
          <label className="campo">Nome do disparo<input id="disparo-nome" required maxLength={80} placeholder="Lançamentos de novembro" value={nome} onChange={(e) => setNome(e.target.value)} /></label>
          <label className="campo">Mensagem aprovada
            <select id="disparo-modelo" required value={modelo} onChange={(e) => setModelo(e.target.value)} disabled={aprovados.length === 0}>
              <option value="">{aprovados.length === 0 ? "Nenhuma mensagem aprovada ainda" : "Escolha a mensagem"}</option>
              {aprovados.map((m) => <option key={m.nome} value={m.nome}>{m.nome}</option>)}
            </select>
            {aprovados.length === 0 && <span className="mudo pequeno">Você já pode montar a lista. Para enviar, crie uma mensagem em "Nova mensagem para a Meta aprovar" e espere a aprovação.</span>}
          </label>
          {escolhido && <p className="pequeno citacao" style={{ margin: 0 }}>{escolhido.texto.replace("{{1}}", "Maria")}</p>}
          <div className="campo">
            Contatos
            <span className="mudo pequeno">Envie um arquivo .csv/.txt ou cole as colunas do Excel (nome e telefone com DDD). Uma pessoa por linha.</span>
            <label className="botao secundario pequeno" style={{ alignSelf: "flex-start" }}>
              Escolher arquivo
              <input type="file" accept=".csv,.txt,text/csv,text/plain" className="invisivel" onChange={lerArquivo} />
            </label>
            <textarea id="disparo-lista" rows={6} value={lista} onChange={(e) => setLista(e.target.value)} placeholder={"Maria Souza;67999998888\nJoão Lima;(67) 98888-7777"} />
          </div>
          <p className="pequeno" style={{ margin: 0 }}>
            <b>{contatos.length}</b> contato{contatos.length === 1 ? "" : "s"} na lista. Números da equipe, repetidos, inválidos e de quem saiu da lista são tirados ao criar.
            {contatos.length > 0 && <> Custo estimado na Meta: <b>até US$ {(contatos.length * custo).toFixed(2)}</b> (confira o preço atual no WhatsApp Manager).</>}
          </p>
          <label className="linha-marcar consentimento">
            <input type="checkbox" checked={consentimento} onChange={(e) => setConsentimento(e.target.checked)} />
            Confirmo que estes contatos autorizaram receber mensagens da LFG Imóveis pelo WhatsApp (por exemplo, são clientes ou deixaram o contato com essa finalidade), como pedem a Meta e a LGPD.
          </label>
          <Erro mensagem={erro} />
          <button className="botao" type="submit" disabled={ocupado || !consentimento || !contatos.length || !modelo} style={{ alignSelf: "flex-start" }}>{ocupado ? "Criando…" : "Criar disparo"}</button>
      </>
      {resultado && (
        <p className="aviso-ok" role="status" style={{ margin: 0 }}>
          Disparo criado com {resultado.validos} contato{resultado.validos === 1 ? "" : "s"}.
          {resultado.invalidos ? ` ${resultado.invalidos} inválido(s).` : ""}{resultado.repetidos ? ` ${resultado.repetidos} repetido(s).` : ""}
          {resultado.equipe ? ` ${resultado.equipe} da equipe.` : ""}{resultado.descadastrados ? ` ${resultado.descadastrados} já tinham saído da lista.` : ""}
          {" "}Confira abaixo e toque em Iniciar envio.
        </p>
      )}
    </form>
  );
}

export default function Disparos() {
  const { versao, recarregar } = useSessao();
  const [erroAcao, setErroAcao] = useState(null);
  const [verModelos, setVerModelos] = useState(false);

  const dados = useCarregar(async () => {
    const [campanhas, destinatarios, descadastros, config] = await Promise.all([
      supabase.from("campanhas").select("*").order("criado_em", { ascending: false }).limit(30),
      supabase.from("campanha_destinatarios").select("campanha_id, status").limit(50000),
      supabase.from("descadastros").select("telefone", { count: "exact", head: true }),
      supabase.from("configuracoes").select("valor").eq("chave", "disparos").maybeSingle(),
    ]);
    const contagem = new Map();
    for (const d of exigir(destinatarios)) {
      const c = contagem.get(d.campanha_id) ?? {};
      c[d.status] = (c[d.status] ?? 0) + 1;
      contagem.set(d.campanha_id, c);
    }
    return { campanhas: exigir(campanhas), contagem, saiu: descadastros.count ?? 0, config: exigir(config)?.valor ?? {} };
  }, [versao]);
  const meta = useCarregar(async () => {
    const [modelos, numero] = await Promise.all([chamarDisparos("modelos"), chamarDisparos("numero")]);
    return { modelos: modelos.modelos ?? [], numero };
  }, [versao]);

  async function mudar(campanha, acao) {
    if (acao === "cancelar" && !confirm(`Cancelar o disparo "${campanha.nome}"? Quem ainda não recebeu não vai receber.`)) return;
    if (acao === "iniciar" && !confirm(`Iniciar o envio de "${campanha.nome}"? As mensagens saem aos poucos, respeitando o limite diário do número.`)) return;
    setErroAcao(null);
    try {
      exigir(await supabase.rpc("mudar_campanha", { p_id: campanha.id, p_acao: acao }));
      recarregar();
    } catch (e) {
      setErroAcao(mensagemDeErro(e));
    }
  }

  if (!dados.dados) return <section className="vista"><Erro mensagem={dados.erro} /><Carregando /></section>;
  const { campanhas, contagem, saiu, config } = dados.dados;
  const numero = meta.dados?.numero;
  const [qualidade, corQualidade] = QUALIDADE[numero?.qualidade] ?? ["—", "pendente"];
  const limiteDia = Math.min(config.limite_dia ?? 200, numero?.limite_do_nivel ?? Infinity);

  return (
    <section className="vista" aria-labelledby="t-disparos">
      <div className="cabeca-vista">
        <div>
          <h2 id="t-disparos">Disparos</h2>
          <p>Mensagens de divulgação para listas de contatos, só com mensagens aprovadas pela Meta e para quem autorizou receber.</p>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <span className="seletor"><span className="rotulo">Qualidade do número</span><span className={`etiqueta ${corQualidade}`}>{qualidade}</span></span>
          <span className="seletor"><span className="rotulo">Até</span>{Number.isFinite(limiteDia) ? limiteDia : "—"} por dia</span>
          <span className="seletor"><span className="rotulo">Saíram da lista</span>{saiu}</span>
        </div>
      </div>
      <Erro mensagem={meta.erro || erroAcao} />

      <div className="painel regra-fixa" style={{ margin: 0 }}>
        <b>Para não bloquear o número:</b> as mensagens saem aos poucos (até {config.por_minuto ?? 20} por minuto e {Number.isFinite(limiteDia) ? limiteDia : "o limite"} a cada 24 horas). Se a Meta baixar a qualidade do número para baixa, os disparos pausam sozinhos. Quem responde cai na Thais; quem pede para sair nunca mais recebe. Depois de 90 dias, nome e telefone de quem não respondeu são apagados.
      </div>

      {!meta.dados ? <Carregando /> : (
        <NovoDisparo modelos={meta.dados.modelos} custo={config.custo_usd ?? 0.0625} aoCriar={recarregar} />
      )}

      <div>
        <div className="titulo-secao"><h3>Disparos</h3><span className="etiqueta pendente">{campanhas.length}</span></div>
        {campanhas.length === 0 ? (
          <p className="mudo pequeno">Nenhum disparo ainda.</p>
        ) : (
          <div className="lista-disparos">
            {campanhas.map((c) => {
              const n = contagem.get(c.id) ?? {};
              const total = Object.values(n).reduce((s, v) => s + v, 0);
              const feitos = total - (n.na_fila ?? 0);
              const [situacao, cor] = SITUACAO[c.status] ?? [c.status, "pendente"];
              return (
                <div key={c.id} className="painel disparo">
                  <div className="linha-titulo">
                    <div>
                      <b>{c.nome}</b> <span className={`etiqueta ${cor}`}>{situacao}</span>
                      <p className="mudo pequeno" style={{ margin: "2px 0 0" }}>Mensagem {c.modelo} · criado em {dataHora(c.criado_em)}{c.concluida_em ? ` · terminou em ${dataHora(c.concluida_em)}` : ""}</p>
                    </div>
                    <div className="atalhos">
                      {c.status === "rascunho" && <button type="button" className="botao pequeno" onClick={() => mudar(c, "iniciar")}>Iniciar envio</button>}
                      {c.status === "enviando" && <button type="button" className="botao secundario pequeno" onClick={() => mudar(c, "pausar")}>Pausar</button>}
                      {c.status === "pausada" && <button type="button" className="botao pequeno" onClick={() => mudar(c, "retomar")}>Retomar</button>}
                      {["rascunho", "enviando", "pausada"].includes(c.status) && <button type="button" className="botao pequeno perigo" onClick={() => mudar(c, "cancelar")}>Cancelar</button>}
                    </div>
                  </div>
                  {c.motivo_pausa && <p className="pequeno texto-alerta" style={{ margin: 0 }}>{c.motivo_pausa}</p>}
                  <div className="barra-progresso" aria-label={`${feitos} de ${total} processados`}><span style={{ width: `${total ? (feitos / total) * 100 : 0}%` }} /></div>
                  <dl className="numeros-disparo">
                    {Object.entries(NOME_DO_RESULTADO).filter(([k]) => n[k]).map(([k, rotulo]) => (
                      <div key={k}><dt>{rotulo}</dt><dd className="dado">{n[k]}</dd></div>
                    ))}
                  </dl>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <NovaMensagem aoCriar={recarregar} />

      <div className="painel formulario">
        <button type="button" className="botao secundario pequeno" style={{ alignSelf: "flex-start" }} onClick={() => setVerModelos(!verModelos)}>
          {verModelos ? "Esconder" : "Ver"} mensagens na Meta ({meta.dados?.modelos.length ?? 0})
        </button>
        {verModelos && (
          <ul className="lista">
            {(meta.dados?.modelos ?? []).map((m) => {
              const [sit, cor] = SITUACAO_DO_MODELO[m.situacao] ?? [m.situacao, "pendente"];
              return (
                <li key={`${m.nome}-${m.idioma}`} className="pequeno">
                  <b>{m.nome}</b> <span className={`etiqueta ${cor}`}>{sit}</span> <span className="mudo">{m.categoria === "MARKETING" ? "divulgação" : m.categoria === "UTILITY" ? "serviço" : m.categoria}</span>
                  {m.motivo_recusa && <span className="texto-alerta"> · motivo: {m.motivo_recusa}</span>}
                  <p className="mudo" style={{ margin: "2px 0 8px" }}>{m.texto}</p>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
