import { useEffect, useState } from "react";
import { Carregando, Erro, haQuanto, nomeDoPapel, telefone, useCarregar } from "../comum.jsx";
import { useSessao } from "../sessao.jsx";
import { chamarPainel, exigir, mensagemDeErro, supabase } from "../supabase.js";
import { reduzirFoto } from "../imoveis.js";
import ConfigGerais from "./ConfigGerais.jsx";
import RegrasRodizio from "./RegrasRodizio.jsx";
import { GradeDaAgenda } from "./Agenda.jsx";
import CampanhasDaThais from "./CampanhasDaThais.jsx";
import Perfil, { iniciais } from "./Perfil.jsx";

// [id, nome, descrição curta, grupo]
const ABAS = [
  ["geral", "Configurações gerais", "Empresa, horário, marca d’água e chave da API", "Empresa"],
  ["conta", "Minha conta", "Seus dados, Google Agenda, sua página e senha", "Empresa"],
  ["regras", "Regras do plantão", "Rodízio, horários e follow-up", "Atendimento"],
  ["agenda", "Agenda de visitas", "Grade de horários das visitas", "Atendimento"],
  ["campanhas", "Campanhas da Thais", "O que a IA sabe de cada campanha", "Atendimento"],
  ["equipe", "Equipe e acessos", "Quem entra no painel e o perfil", "Equipe"],
  ["integracoes", "Integrações", "WhatsApp, IA, Univen e o que está ligado", "Equipe"],
];
const GRUPOS_DAS_ABAS = ["Empresa", "Atendimento", "Equipe"];
// A aba fica no endereço (#configuracoes/regras) para dar para mandar o link direto.
const abaDoEndereco = () => {
  const [vista, aba] = location.hash.slice(1).split("/");
  return vista === "configuracoes" && ABAS.some(([id]) => id === aba) ? aba : null;
};

// Campos que a IA sabe conferir antes de passar o lead (ver agente.ts).
const PERGUNTAS = [
  ["interesse", "Se quer comprar ou alugar"],
  ["regiao", "Região ou bairro"],
  ["orcamento", "Orçamento"],
  ["quartos", "Quantidade de quartos"],
  ["forma_pagamento", "Forma de pagamento"],
  ["urgencia", "Urgência"],
  ["nome", "Nome do cliente"],
];

export default function Configuracoes() {
  // Volta do Google Agenda (?google=...): abre direto em Minha conta, onde fica a conexão.
  const [aba, setAbaAgora] = useState(() => (new URLSearchParams(location.search).get("google") ? "conta" : abaDoEndereco() ?? "geral"));
  const setAba = (id) => {
    setAbaAgora(id);
    history.replaceState(null, "", `#configuracoes/${id}`);
  };
  useEffect(() => {
    const aoMudar = () => {
      const doEndereco = abaDoEndereco();
      if (doEndereco) setAbaAgora(doEndereco);
    };
    window.addEventListener("hashchange", aoMudar);
    return () => window.removeEventListener("hashchange", aoMudar);
  }, []);
  // No celular o menu vira uma faixa que rola de lado: a parte aberta fica à vista.
  useEffect(() => {
    const menu = document.querySelector(".config-menu");
    const botao = menu?.querySelector("[aria-current='page']");
    if (!botao || !window.matchMedia?.("(max-width: 900px)").matches) return;
    // Rola só a faixa, de lado; a página fica onde está.
    menu.scrollTo({ left: botao.offsetLeft - 12, behavior: "smooth" });
  }, [aba]);
  return (
    <section className="vista vista-config" aria-labelledby="t-config">
      <div className="cabeca-vista">
        <div>
          <h2 id="t-config">Configurações</h2>
          <p>Dados da empresa, regras do plantão, quem tem acesso ao painel e o que já está ligado.</p>
        </div>
      </div>
      <div className="config-estrutura">
        <nav className="config-menu" aria-label="Partes das configurações">
          {GRUPOS_DAS_ABAS.map((grupo) => (
            <div key={grupo} className="config-grupo" role="group" aria-label={grupo}>
              <span className="config-grupo-titulo" aria-hidden="true">{grupo}</span>
              {ABAS.filter(([, , , g]) => g === grupo).map(([id, nome, descricao]) => (
                <button key={id} type="button" aria-current={aba === id ? "page" : undefined} onClick={() => setAba(id)}>
                  <b>{nome}</b>
                  <small>{descricao}</small>
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="config-conteudo">
          {aba === "geral" && <ConfigGerais />}
          {aba === "regras" && <div className="formulario"><Regras /><HorariosDistribuicao /><FollowupThais /><FollowupComCorretor /><RegrasRodizio /></div>}
          {aba === "agenda" && <GradeDaAgenda />}
          {aba === "campanhas" && <CampanhasDaThais />}
          {aba === "equipe" && <Equipe />}
          {aba === "integracoes" && <Integracoes />}
          {aba === "conta" && <Perfil embutido />}
        </div>
      </div>
    </section>
  );
}

function Regras() {
  const { souGestor, versao } = useSessao();
  const { dados, erro } = useCarregar(async () => {
    const linhas = exigir(await supabase.from("configuracoes").select("chave, valor").in("chave", ["prazo_rodizio_minutos", "prazo_resposta_minutos", "perguntas_obrigatorias"]));
    return Object.fromEntries(linhas.map((l) => [l.chave, l.valor]));
  }, [versao]);
  const [prazo, setPrazo] = useState("");
  const [prazoResposta, setPrazoResposta] = useState("");
  const [perguntas, setPerguntas] = useState([]);
  const [salvo, setSalvo] = useState(null);
  const [erroSalvar, setErroSalvar] = useState(null);

  useEffect(() => {
    if (!dados) return;
    setPrazo(String(dados.prazo_rodizio_minutos ?? 5));
    setPrazoResposta(String(dados.prazo_resposta_minutos ?? 5));
    setPerguntas(dados.perguntas_obrigatorias ?? []);
  }, [dados]);

  async function salvar(evento) {
    evento.preventDefault();
    setSalvo(null);
    setErroSalvar(null);
    const minutos = Number(prazo);
    const minutosResposta = Number(prazoResposta);
    if (!Number.isInteger(minutos) || minutos < 1 || minutos > 120) return setErroSalvar("O prazo para assumir precisa ser um número de 1 a 120 minutos.");
    if (!Number.isInteger(minutosResposta) || minutosResposta < 1 || minutosResposta > 120) return setErroSalvar("O prazo para responder precisa ser um número de 1 a 120 minutos.");
    try {
      exigir(await supabase.from("configuracoes").update({ valor: minutos, atualizado_em: new Date().toISOString() }).eq("chave", "prazo_rodizio_minutos").select());
      exigir(await supabase.from("configuracoes").update({ valor: minutosResposta, atualizado_em: new Date().toISOString() }).eq("chave", "prazo_resposta_minutos").select());
      exigir(await supabase.from("configuracoes").update({ valor: perguntas, atualizado_em: new Date().toISOString() }).eq("chave", "perguntas_obrigatorias").select());
      setSalvo("Regras salvas. Valem para os próximos leads.");
    } catch (e) {
      setErroSalvar(mensagemDeErro(e));
    }
  }

  if (!dados) return <><Erro mensagem={erro} /><Carregando /></>;
  return (
    <form className="painel" onSubmit={salvar} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <h3 style={{ margin: 0 }}>Regras do plantão {!souGestor && <span className="etiqueta pendente">só o gestor altera</span>}</h3>
      <div className="grade-prazos">
        <label className="campo">
          Minutos para o corretor assumir o lead
          <input id="regra-prazo" type="number" min={1} max={120} value={prazo} onChange={(e) => setPrazo(e.target.value)} disabled={!souGestor} />
          <small className="mudo">Sem assumir nesse tempo, o lead passa para o próximo do rodízio.</small>
        </label>
        <label className="campo">
          Minutos para responder depois de assumir
          <input id="regra-prazo-resposta" type="number" min={1} max={120} value={prazoResposta} onChange={(e) => setPrazoResposta(e.target.value)} disabled={!souGestor} />
          <small className="mudo">Conta de quando ele assume. Sem mandar mensagem pelo sistema nesse tempo, o lead sai dele e volta ao rodízio.</small>
        </label>
      </div>
      <fieldset style={{ border: 0, padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }} disabled={!souGestor}>
        <legend className="campo" style={{ color: "var(--texto-2)", fontWeight: 600, marginBottom: 8 }}>O que a IA precisa saber antes de passar o lead (lead quente passa antes)</legend>
        {PERGUNTAS.map(([id, texto]) => (
          <label key={id} style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <input id={`pergunta-${id}`} type="checkbox" style={{ width: "auto" }} checked={perguntas.includes(id)} onChange={(e) => setPerguntas(e.target.checked ? [...perguntas, id] : perguntas.filter((p) => p !== id))} />
            {texto}
          </label>
        ))}
      </fieldset>
      <Erro mensagem={erroSalvar} />
      {salvo && <p className="aviso-ok" role="status">{salvo}</p>}
      {souGestor && <button className="botao" type="submit" style={{ alignSelf: "flex-start" }}>Salvar regras</button>}
    </form>
  );
}

// Follow-up da Thais quando o cliente para de responder: 5 mensagens no
// horário comercial e, depois da 5ª, o atendimento é finalizado. Só o gestor muda.
const PADRAO_FOLLOWUP = {
  ativo: true,
  mensagens: [
    "Ainda não tive sua resposta. Quando quiser, estou aqui para te ajudar.",
    "O dia deve estar bem corrido, eu entendo. Mas sigo à disposição para te atender.",
    "Caso prefira conversar outro dia, é só me avisar qual o melhor momento para falarmos, ok?",
    "Não tive resposta. Talvez não seja o melhor momento para conversar.",
    "Como não conseguimos prosseguir, estou finalizando seu atendimento. Se precisar, a LFG Imóveis está à disposição.",
  ],
  passos: [{ apos_horas: 2 }, { apos_horas: 4 }, { proximo_dia: "08:30" }, { apos_horas: 6 }, { proximo_dia: "08:30" }],
};

function FollowupThais() {
  const { souGestorPleno, versao, recarregar } = useSessao();
  const { dados, erro } = useCarregar(async () => {
    const linha = exigir(await supabase.from("configuracoes").select("valor").eq("chave", "followup").maybeSingle());
    return { ...PADRAO_FOLLOWUP, ...(linha?.valor ?? {}) };
  }, [versao]);
  const [campos, setCampos] = useState(null);
  const [salvo, setSalvo] = useState(null);
  const [erroSalvar, setErroSalvar] = useState(null);
  const [ocupado, setOcupado] = useState(false);
  useEffect(() => {
    if (dados) setCampos(dados);
  }, [dados]);

  async function salvar(evento) {
    evento.preventDefault();
    setSalvo(null);
    setErroSalvar(null);
    setOcupado(true);
    try {
      exigir(await supabase.rpc("salvar_followup", { p_ativo: campos.ativo, p_mensagens: campos.mensagens, p_passos: campos.passos }));
      setSalvo(campos.ativo ? "Follow-up salvo e ligado." : "Follow-up desligado: nenhuma mensagem nova sai.");
      recarregar();
    } catch (e) {
      setErroSalvar(mensagemDeErro(e));
    } finally {
      setOcupado(false);
    }
  }

  if (!campos) return <><Erro mensagem={erro} /><Carregando /></>;
  const travado = !souGestorPleno;
  const mudarMensagem = (i, texto) => setCampos({ ...campos, mensagens: campos.mensagens.map((m, j) => (j === i ? texto : m)) });
  const mudarPasso = (i, passo) => setCampos({ ...campos, passos: campos.passos.map((p, j) => (j === i ? passo : p)) });
  return (
    <form className="painel formulario" onSubmit={salvar}>
      <h3 style={{ margin: 0 }}>Follow-up da Thais {travado && <span className="etiqueta pendente">só o gestor altera</span>}</h3>
      <p className="mudo" style={{ margin: 0 }}>
        Quando o cliente para de responder a Thais, ela manda estas mensagens, só no horário comercial. Se ele responder, se um corretor assumir ou se a IA for desligada, a sequência para. Depois da 5ª, o atendimento é finalizado com o motivo "Sem resposta do cliente".
      </p>
      <label className="linha-marcar">
        <input type="checkbox" checked={campos.ativo} disabled={travado} onChange={(e) => setCampos({ ...campos, ativo: e.target.checked })} />
        Follow-up ligado
      </label>
      {campos.mensagens.map((texto, i) => {
        const passo = campos.passos[i] ?? {};
        const proximoDia = "proximo_dia" in passo;
        return (
          <fieldset key={i} className="passo-followup" disabled={travado}>
            <legend>{i + 1}ª mensagem</legend>
            <div className="quando-followup">
              <select value={proximoDia ? "dia" : "horas"} onChange={(e) => mudarPasso(i, e.target.value === "dia" ? { proximo_dia: "08:30" } : { apos_horas: 2 })}>
                <option value="horas">horas depois {i === 0 ? "da última mensagem da Thais" : "da anterior"}</option>
                <option value="dia">no dia útil seguinte, às</option>
              </select>
              {proximoDia
                ? <input type="time" required value={passo.proximo_dia} onChange={(e) => mudarPasso(i, { proximo_dia: e.target.value })} />
                : <input type="number" required min={0.5} max={24} step={0.5} value={passo.apos_horas} onChange={(e) => mudarPasso(i, { apos_horas: Number(e.target.value) })} aria-label="Horas" />}
            </div>
            <textarea rows={2} required maxLength={1000} value={texto} onChange={(e) => mudarMensagem(i, e.target.value)} />
          </fieldset>
        );
      })}
      <p className="mudo pequeno" style={{ margin: 0 }}>
        Até 23 horas depois da última mensagem do cliente, sai o texto acima. Depois disso o WhatsApp só aceita mensagem aprovada pela Meta: sai o texto aprovado (o original). Se mudar um texto aqui, ele vale para o envio dentro das 23 horas.
      </p>
      <Erro mensagem={erroSalvar} />
      {salvo && <p className="aviso-ok" role="status">{salvo}</p>}
      {souGestorPleno && <button className="botao" type="submit" disabled={ocupado} style={{ alignSelf: "flex-start" }}>{ocupado ? "Salvando…" : "Salvar follow-up"}</button>}
    </form>
  );
}

// Leads com corretor: aviso ao corretor e follow-up da Thais quando a conversa
// para (só no horário comercial). Só o gestor muda.
function FollowupComCorretor() {
  const { souGestorPleno, versao, recarregar } = useSessao();
  const { dados, erro } = useCarregar(async () => {
    const linha = exigir(await supabase.from("configuracoes").select("valor").eq("chave", "followup_corretor").maybeSingle());
    return { ativo: false, alerta_horas: 20, followup_horas: 24, maximo: 3, ...(linha?.valor ?? {}) };
  }, [versao]);
  const [campos, setCampos] = useState(null);
  const [salvo, setSalvo] = useState(null);
  const [erroSalvar, setErroSalvar] = useState(null);
  const [ocupado, setOcupado] = useState(false);
  useEffect(() => {
    if (dados) setCampos(dados);
  }, [dados]);

  async function salvar(evento) {
    evento.preventDefault();
    setSalvo(null);
    setErroSalvar(null);
    setOcupado(true);
    try {
      exigir(await supabase.rpc("salvar_followup_corretor", {
        p_ativo: campos.ativo, p_alerta_horas: Number(campos.alerta_horas), p_followup_horas: Number(campos.followup_horas), p_maximo: Number(campos.maximo),
      }));
      setSalvo(campos.ativo ? "Acompanhamento ligado." : "Acompanhamento desligado: nenhum aviso nem follow-up sai.");
      recarregar();
    } catch (e) {
      setErroSalvar(mensagemDeErro(e));
    } finally {
      setOcupado(false);
    }
  }

  if (!campos) return <><Erro mensagem={erro} /><Carregando /></>;
  const travado = !souGestorPleno;
  const mudar = (campo) => (e) => setCampos({ ...campos, [campo]: e.target.value });
  return (
    <form className="painel formulario" onSubmit={salvar}>
      <h3 style={{ margin: 0 }}>Leads com corretor: conversa parada {travado && <span className="etiqueta pendente">só o gestor altera</span>}</h3>
      <p className="mudo" style={{ margin: 0 }}>
        Quando um lead com corretor fica sem mensagem nossa, o corretor é avisado e, se continuar parado, a Thais retoma o contato lendo a conversa. Ela não promete nada novo e a IA segue pausada: se o cliente responder, quem continua é o corretor. Os prazos contam desde a última mensagem nossa e o follow-up só sai no horário comercial.
      </p>
      <label className="linha-marcar">
        <input type="checkbox" checked={!!campos.ativo} disabled={travado} onChange={(e) => setCampos({ ...campos, ativo: e.target.checked })} />
        Acompanhamento ligado
      </label>
      <div className="grade-prazos">
        <label className="campo">Avisar o corretor depois de (horas)
          <input type="number" min={1} max={71} step={1} required disabled={travado} value={campos.alerta_horas} onChange={mudar("alerta_horas")} />
        </label>
        <label className="campo">Follow-up da Thais depois de (horas)
          <input type="number" min={2} max={72} step={1} required disabled={travado} value={campos.followup_horas} onChange={mudar("followup_horas")} />
        </label>
        <label className="campo">Follow-ups seguidos, no máximo
          <input type="number" min={1} max={10} step={1} required disabled={travado} value={campos.maximo} onChange={mudar("maximo")} />
        </label>
      </div>
      <p className="mudo pequeno" style={{ margin: 0 }}>
        Se o cliente falou nas últimas 23 horas, a Thais escreve a mensagem a partir da conversa. Se não, o WhatsApp só aceita a mensagem-modelo aprovada pela Meta. Depois do último follow-up sem resposta, o gestor é avisado.
      </p>
      <Erro mensagem={erroSalvar} />
      {salvo && <p className="aviso-ok" role="status">{salvo}</p>}
      {souGestorPleno && <button className="botao" type="submit" disabled={ocupado} style={{ alignSelf: "flex-start" }}>{ocupado ? "Salvando…" : "Salvar acompanhamento"}</button>}
    </form>
  );
}

// Horários de distribuição: comercial (todos do rodízio), plantão (só quem ligou
// o botão) e fora do horário (sem rodízio; o captador é avisado e o prazo dele
// começa na abertura). Só o gestor muda (o banco também confere).
const DIAS_UTEIS = [[1, "Seg"], [2, "Ter"], [3, "Qua"], [4, "Qui"], [5, "Sex"], [6, "Sáb"], [7, "Dom"]];
const PADRAO_HORARIOS = { dias: [1, 2, 3, 4, 5], inicio: "08:00", fim_comercial: "17:00", fim_plantao: "22:00", fora_ativo: true };

function HorariosDistribuicao() {
  const { souGestorPleno, versao, recarregar } = useSessao();
  const { dados, erro } = useCarregar(async () => {
    const linha = exigir(await supabase.from("configuracoes").select("valor").eq("chave", "horarios_distribuicao").maybeSingle());
    return { ...PADRAO_HORARIOS, ...(linha?.valor ?? {}) };
  }, [versao]);
  const [campos, setCampos] = useState(null);
  const [salvo, setSalvo] = useState(null);
  const [erroSalvar, setErroSalvar] = useState(null);
  const [ocupado, setOcupado] = useState(false);
  useEffect(() => {
    if (dados) setCampos(dados);
  }, [dados]);

  async function salvar(evento) {
    evento.preventDefault();
    setSalvo(null);
    setErroSalvar(null);
    setOcupado(true);
    try {
      exigir(await supabase.rpc("salvar_horarios_distribuicao", {
        p_dias: campos.dias, p_inicio: campos.inicio, p_fim_comercial: campos.fim_comercial, p_fim_plantao: campos.fim_plantao, p_fora_ativo: campos.fora_ativo,
      }));
      setSalvo("Horários salvos. Valem a partir do próximo lead.");
      recarregar();
    } catch (e) {
      setErroSalvar(mensagemDeErro(e));
    } finally {
      setOcupado(false);
    }
  }

  if (!campos) return <><Erro mensagem={erro} /><Carregando /></>;
  const travado = !souGestorPleno;
  const alternarDia = (d) => setCampos({ ...campos, dias: campos.dias.includes(d) ? campos.dias.filter((x) => x !== d) : [...campos.dias, d].sort() });
  return (
    <form className="painel formulario" onSubmit={salvar}>
      <h3 style={{ margin: 0 }}>Horários de distribuição {travado && <span className="etiqueta pendente">só o gestor altera</span>}</h3>
      <p className="mudo" style={{ margin: 0 }}>
        O captador do imóvel recebe o lead primeiro, em qualquer horário. Depois: no <b>horário comercial</b>, o rodízio usa todos do rodízio; no <b>plantão</b> (dias úteis depois do comercial e fim de semana), só quem ligou o botão Plantão; <b>fora do horário</b> não há rodízio, a Thais atende e avisa o cliente, o captador é avisado e o prazo dele começa na abertura.
      </p>
      <div className="filtros" role="group" aria-label="Dias de horário comercial">
        {DIAS_UTEIS.map(([d, nome]) => (
          <button key={d} type="button" className="filtro" aria-pressed={campos.dias.includes(d)} disabled={travado} onClick={() => alternarDia(d)}>{nome}</button>
        ))}
      </div>
      <div className="grade-prazos">
        <label className="campo">
          Abertura (comercial e plantão)
          <input type="time" required value={campos.inicio} disabled={travado} onChange={(e) => setCampos({ ...campos, inicio: e.target.value })} />
        </label>
        <label className="campo">
          Fim do horário comercial
          <input type="time" required value={campos.fim_comercial} disabled={travado} onChange={(e) => setCampos({ ...campos, fim_comercial: e.target.value })} />
        </label>
        <label className="campo">
          Fim do plantão
          <input type="time" required value={campos.fim_plantao} disabled={travado} onChange={(e) => setCampos({ ...campos, fim_plantao: e.target.value })} />
          <small className="mudo">Horário de Campo Grande.</small>
        </label>
      </div>
      <label className="linha-marcar">
        <input type="checkbox" checked={campos.fora_ativo} disabled={travado} onChange={(e) => setCampos({ ...campos, fora_ativo: e.target.checked })} />
        Fora do horário ({campos.fim_plantao} às {campos.inicio}) sem rodízio
      </label>
      {!campos.fora_ativo && <p className="texto-alerta pequeno" style={{ margin: 0 }}>Desligado: de madrugada o rodízio de plantão continua funcionando, com prazos correndo.</p>}
      <Erro mensagem={erroSalvar} />
      {salvo && <p className="aviso-ok" role="status">{salvo}</p>}
      {souGestorPleno && <button className="botao" type="submit" disabled={ocupado} style={{ alignSelf: "flex-start" }}>{ocupado ? "Salvando…" : "Salvar horários"}</button>}
    </form>
  );
}

function Equipe() {
  const { souGestor, souGestorPleno, versao, recarregar } = useSessao();
  // O administrativo não mexe no acesso de um gestor (o banco também recusa).
  const podeMexer = (p) => souGestorPleno || p.papel !== "gestor";
  const vazio = { nome: "", whatsapp: "", email: "", senha: "", creci: "", papel: "corretor" };
  const [novo, setNovo] = useState(vazio);
  const [mensagem, setMensagem] = useState(null);
  const [erroAcao, setErroAcao] = useState(null);
  const [ocupado, setOcupado] = useState(false);
  const [senhaDe, setSenhaDe] = useState(null);
  const [novaSenha, setNovaSenha] = useState("");
  const { dados, erro } = useCarregar(async () => exigir(await supabase.from("corretores").select("*").order("nome")), [versao]);
  const { dados: emails } = useCarregar(async () => (souGestor ? exigir(await supabase.rpc("emails_da_equipe")) : []), [versao, souGestor]);
  const emailDe = new Map((emails ?? []).map((e) => [e.corretor_id, e.email]));
  const mudar = (campo) => (e) => setNovo({ ...novo, [campo]: e.target.value });

  async function agir(acao, sucesso) {
    setOcupado(true);
    setErroAcao(null);
    setMensagem(null);
    try {
      await acao();
      setMensagem(sucesso);
      recarregar();
    } catch (e) {
      setErroAcao(mensagemDeErro(e));
    } finally {
      setOcupado(false);
    }
  }

  const criar = (evento) => {
    evento.preventDefault();
    agir(async () => {
      await chamarPainel("criar_acesso", novo);
      setNovo(vazio);
    }, `Acesso criado. Passe para ${novo.nome.split(" ")[0]} o e-mail e a senha provisória; dá para trocar a senha em Minha conta.`);
  };
  const redefinir = (pessoa) => agir(async () => {
    await chamarPainel("redefinir_senha", { corretor_id: pessoa.id, senha: novaSenha });
    setSenhaDe(null);
    setNovaSenha("");
  }, `Senha de ${pessoa.nome.split(" ")[0]} trocada.`);
  const atualizar = (pessoa, mudancas) => supabase.rpc("gestor_atualizar_pessoa", {
    p_id: pessoa.id, p_nome: pessoa.nome, p_whatsapp: pessoa.whatsapp, p_creci: pessoa.creci ?? null,
    p_papel: pessoa.papel, p_ativo: pessoa.ativo, p_no_rodizio: pessoa.no_rodizio, ...mudancas,
  });
  const mudarAtivo = (pessoa) => agir(async () => exigir(await atualizar(pessoa, { p_ativo: !pessoa.ativo })),
    pessoa.ativo ? `${pessoa.nome.split(" ")[0]} não acessa mais o painel nem recebe leads.` : `${pessoa.nome.split(" ")[0]} voltou a ter acesso.`);
  const [editando, setEditando] = useState(null);
  // Foto de outra pessoa: vai na pasta dela no bucket "perfis" e já fica salva.
  const trocarFoto = (evento) => {
    const arquivo = evento.target.files?.[0];
    evento.target.value = "";
    if (!arquivo) return;
    const pessoa = dados.find((p) => p.id === editando.id);
    agir(async () => {
      const foto = await reduzirFoto(arquivo, 400, 0.85);
      const caminho = `${pessoa.id}/foto-${Date.now()}.jpg`;
      exigir(await supabase.storage.from("perfis").upload(caminho, foto, { contentType: "image/jpeg" }));
      const url = supabase.storage.from("perfis").getPublicUrl(caminho).data.publicUrl;
      exigir(await supabase.rpc("gestor_definir_foto", { p_id: pessoa.id, p_foto_url: url }));
      const anterior = (pessoa.foto_url ?? "").split("/object/public/perfis/")[1];
      if (anterior) await supabase.storage.from("perfis").remove([anterior]);
      setEditando((atual) => atual && { ...atual, foto_url: url });
    }, `Foto de ${pessoa.nome.split(" ")[0]} salva.`);
  };
  const tirarFoto = () => {
    const pessoa = dados.find((p) => p.id === editando.id);
    agir(async () => {
      exigir(await supabase.rpc("gestor_definir_foto", { p_id: pessoa.id, p_foto_url: null }));
      const anterior = (pessoa.foto_url ?? "").split("/object/public/perfis/")[1];
      if (anterior) await supabase.storage.from("perfis").remove([anterior]);
      setEditando((atual) => atual && { ...atual, foto_url: "" });
    }, `Foto de ${pessoa.nome.split(" ")[0]} removida.`);
  };
  const salvarEdicao = (evento) => {
    evento.preventDefault();
    const pessoa = dados.find((p) => p.id === editando.id);
    const emailAtual = emailDe.get(pessoa.id) ?? "";
    const emailNovo = editando.email.trim().toLowerCase();
    agir(async () => {
      if (emailNovo && emailNovo !== emailAtual) {
        await chamarPainel("definir_email", { corretor_id: pessoa.id, email: emailNovo, senha: pessoa.usuario_id ? undefined : editando.senha });
      }
      exigir(await atualizar(pessoa, {
        p_nome: editando.nome, p_whatsapp: editando.whatsapp, p_creci: editando.creci || null,
        p_papel: editando.papel, p_no_rodizio: editando.no_rodizio,
      }));
      if (editando.papel !== "administrativo" && editando.slug.trim() && editando.slug.trim() !== (pessoa.slug ?? "")) {
        exigir(await supabase.rpc("definir_slug_corretor", { p_corretor_id: pessoa.id, p_slug: editando.slug.trim() }));
      }
      setEditando(null);
    }, !pessoa.usuario_id && emailNovo
      ? `Acesso de ${editando.nome.split(" ")[0]} criado. Passe o e-mail e a senha provisória; dá para trocar a senha em Meu perfil.`
      : `Dados de ${editando.nome.split(" ")[0]} salvos.`);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Erro mensagem={erro || erroAcao} />
      {mensagem && <p className="aviso-ok" role="status">{mensagem}</p>}
      {souGestorPleno && (
        <form className="painel" onSubmit={criar} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <h3 style={{ margin: 0 }}>Cadastrar pessoa na equipe</h3>
          <div className="grade-campos">
            <label className="campo">Nome<input id="novo-nome" required value={novo.nome} onChange={mudar("nome")} /></label>
            <label className="campo">WhatsApp pessoal<input id="novo-whatsapp" required value={novo.whatsapp} onChange={mudar("whatsapp")} placeholder="(67) 99999-9999" inputMode="tel" /></label>
            <label className="campo">E-mail de acesso<input id="novo-email" type="email" required value={novo.email} onChange={mudar("email")} /></label>
            <label className="campo">Senha provisória<input id="novo-senha" type="text" required minLength={8} value={novo.senha} onChange={mudar("senha")} placeholder="mínimo 8 caracteres" autoComplete="off" /></label>
            <label className="campo">CRECI (opcional)<input id="novo-creci" value={novo.creci} onChange={mudar("creci")} /></label>
            <label className="campo">Papel<select id="novo-papel" value={novo.papel} onChange={mudar("papel")}><option value="corretor">Corretor</option><option value="administrativo">Administrativo</option><option value="gestor">Gestor</option></select></label>
          </div>
          <p className="mudo pequeno" style={{ margin: 0 }}>O corretor entra fora do plantão; ele mesmo liga o plantão na tela Plantão. O administrativo não entra no rodízio. Informe o WhatsApp dele: é para onde vão os avisos da agenda de visitas.</p>
          <button className="botao" type="submit" disabled={ocupado} style={{ alignSelf: "flex-start" }}>{ocupado ? "Criando…" : "Criar acesso"}</button>
        </form>
      )}
      {editando && (
        <form className="painel formulario" onSubmit={salvarEdicao}>
          <h3 style={{ margin: 0 }}>Editar {editando.nome.split(" ")[0]}</h3>
          <div className="foto-perfil">
            {editando.foto_url ? <img src={editando.foto_url} alt={`Foto de ${editando.nome}`} /> : <span aria-hidden="true">{iniciais(editando.nome)}</span>}
            <label className="botao secundario pequeno">
              {editando.foto_url ? "Trocar foto" : "Enviar foto"}
              <input type="file" accept="image/jpeg,image/png,image/webp" className="invisivel" disabled={ocupado} onChange={trocarFoto} />
            </label>
            {editando.foto_url && <button type="button" className="botao secundario pequeno" disabled={ocupado} onClick={tirarFoto}>Tirar foto</button>}
          </div>
          <div className="grade-campos">
            <label className="campo">Nome<input id="editar-nome" required value={editando.nome} onChange={(e) => setEditando({ ...editando, nome: e.target.value })} /></label>
            <label className="campo">WhatsApp<input id="editar-whatsapp" required inputMode="tel" value={editando.whatsapp} onChange={(e) => setEditando({ ...editando, whatsapp: e.target.value })} /></label>
            <label className="campo">E-mail de acesso<input id="editar-email" type="email" required={!editando.temLogin} value={editando.email} onChange={(e) => setEditando({ ...editando, email: e.target.value })} /></label>
            {!editando.temLogin && <label className="campo">Senha provisória<input id="editar-senha" type="text" required minLength={8} autoComplete="off" placeholder="mínimo 8 caracteres" value={editando.senha} onChange={(e) => setEditando({ ...editando, senha: e.target.value })} /></label>}
            <label className="campo">CRECI<input id="editar-creci" value={editando.creci} onChange={(e) => setEditando({ ...editando, creci: e.target.value })} /></label>
            <label className="campo">Perfil
              <select id="editar-papel" value={editando.papel} onChange={(e) => setEditando({ ...editando, papel: e.target.value })}>
                <option value="corretor">Corretor</option>
                <option value="administrativo">Administrativo</option>
                {souGestorPleno && <option value="gestor">Gestor</option>}
              </select>
            </label>
          </div>
          {editando.papel !== "administrativo" && (
            <label className="campo">
              Endereço da página pública
              <span className="campo-prefixo"><span className="mudo">lfg.jojodigitals.com/corretor/</span><input id="editar-slug" value={editando.slug} pattern="[a-z0-9]+(-[a-z0-9]+)*" minLength={3} maxLength={60} title="Letras minúsculas, números e hífens" onChange={(e) => setEditando({ ...editando, slug: e.target.value.toLowerCase() })} /></span>
              <small className="mudo">Gerado pelo nome. Ao mudar, o link antigo deixa de funcionar.</small>
            </label>
          )}
          <label className="linha-marcar"><input type="checkbox" disabled={editando.papel === "administrativo"} checked={editando.no_rodizio && editando.papel !== "administrativo"} onChange={(e) => setEditando({ ...editando, no_rodizio: e.target.checked })} /> Participa do rodízio de plantão</label>
          <p className="mudo pequeno" style={{ margin: 0 }}>O gestor vê e muda tudo no sistema. O administrativo também, menos criar acessos, o site e os disparos. O corretor fica com o dia a dia. Ninguém tira o próprio acesso de gestor, e a equipe sempre fica com pelo menos um gestor.</p>
          <div className="atalhos">
            <button type="button" className="botao secundario" onClick={() => setEditando(null)}>Cancelar</button>
            <button type="submit" className="botao" disabled={ocupado}>Salvar</button>
          </div>
        </form>
      )}
      {!dados ? <Carregando /> : (
        <div className="tabela-caixa">
          <table className="tabela-cartoes">
            <thead><tr><th>Pessoa</th><th>Perfil</th><th>WhatsApp</th><th>Situação</th>{souGestor && <th>Ações</th>}</tr></thead>
            <tbody>
              {dados.map((p) => (
                <tr key={p.id}>
                  <td><span className="forte">{p.nome}</span>{p.creci && <span className="sub">CRECI {p.creci}</span>}{p.slug && p.papel !== "administrativo" && <a className="sub" href={`https://lfg.jojodigitals.com/corretor/${p.slug}`} target="_blank" rel="noopener noreferrer">/corretor/{p.slug}</a>}{souGestor && <span className="sub">{emailDe.get(p.id) ?? (p.usuario_id ? "" : "sem acesso ao painel")}</span>}</td>
                  <td data-rotulo="Perfil">{nomeDoPapel(p.papel)}{p.no_rodizio && <span className="sub">no rodízio</span>}</td>
                  <td className="dado" data-rotulo="WhatsApp">{telefone(p.whatsapp)}</td>
                  <td data-rotulo="Situação"><span className={`etiqueta ${p.ativo ? "pronto" : "pendente"}`}>{p.ativo ? "ativo" : "inativo"}</span></td>
                  {souGestor && (
                    <td className="c-acoes">
                      {!podeMexer(p) ? <span className="mudo pequeno">Só o gestor altera</span> : senhaDe === p.id ? (
                        <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <input id={`senha-${p.id}`} type="text" minLength={8} placeholder="nova senha" value={novaSenha} onChange={(e) => setNovaSenha(e.target.value)} style={{ maxWidth: 160 }} autoComplete="off" />
                          <button type="button" className="botao pequeno" disabled={ocupado || novaSenha.length < 8} onClick={() => redefinir(p)}>Salvar</button>
                          <button type="button" className="botao secundario pequeno" onClick={() => setSenhaDe(null)}>Cancelar</button>
                        </span>
                      ) : (
                        <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <button type="button" className="botao secundario pequeno" onClick={() => setEditando({ id: p.id, nome: p.nome, whatsapp: telefone(p.whatsapp), creci: p.creci ?? "", papel: p.papel, no_rodizio: p.no_rodizio, foto_url: p.foto_url ?? "", email: emailDe.get(p.id) ?? "", temLogin: Boolean(p.usuario_id), senha: "", slug: p.slug ?? "" })}>Editar</button>
                          <button type="button" className="botao secundario pequeno" onClick={() => { setSenhaDe(p.id); setNovaSenha(""); }}>Trocar senha</button>
                          <button type="button" className={`botao pequeno ${p.ativo ? "perigo" : "secundario"}`} disabled={ocupado} onClick={() => mudarAtivo(p)}>{p.ativo ? "Desativar" : "Reativar"}</button>
                        </span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {dados && <Captadores equipe={dados} souGestor={souGestor} ocupado={ocupado} agir={agir} />}
    </div>
  );
}

// Lead de um imóvel vai para o captador dele no Univen. Aqui se diz quem da
// equipe é cada captador; quem tem o mesmo nome no cadastro já é ligado sozinho.
function Captadores({ equipe, souGestor, ocupado, agir }) {
  const { versao } = useSessao();
  const { dados, erro } = useCarregar(async () => exigir(await supabase.rpc("captadores_do_univen")), [versao]);
  const nomes = new Map(equipe.map((p) => [p.id, p.nome]));
  const ativos = equipe.filter((p) => p.ativo);

  const ligar = (captador, corretorId) => agir(async () => {
    exigir(await supabase.from("corretores").update({ nome_no_univen: null }).eq("nome_no_univen", captador).select());
    if (corretorId) exigir(await supabase.from("corretores").update({ nome_no_univen: captador }).eq("id", corretorId).select());
  }, corretorId ? `${captador} no Univen agora é ${nomes.get(corretorId)}.` : `${captador} ficou sem ligação com a equipe.`);

  return (
    <div className="painel" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <h3 style={{ margin: 0 }}>Captadores no Univen</h3>
        <p className="mudo pequeno" style={{ margin: "4px 0 0" }}>
          O lead de um imóvel vai para o captador dele, de plantão ou não. Captador fora da equipe, ou que não assume no prazo, passa o lead para o rodízio de plantão.
        </p>
      </div>
      <Erro mensagem={erro} />
      {!dados ? <Carregando /> : (
        <div className="tabela-caixa">
          <table className="tabela-cartoes">
            <thead><tr><th>Captador no Univen</th><th>Imóveis ativos</th><th>Na equipe</th></tr></thead>
            <tbody>
              {dados.map((c) => (
                <tr key={c.captador}>
                  <td className="forte">{c.captador}</td>
                  <td className="dado" data-rotulo="Imóveis ativos">{c.imoveis_ativos}</td>
                  <td data-rotulo="Na equipe" className="c-largo">
                    {souGestor ? (
                      <select id={`captador-${c.captador}`} value={c.corretor_id ?? ""} disabled={ocupado} onChange={(e) => ligar(c.captador, e.target.value || null)} aria-label={`Quem é ${c.captador} na equipe`}>
                        <option value="">Fora da equipe (vai para o rodízio)</option>
                        {ativos.map((p) => <option key={p.id} value={p.id}>{p.nome}</option>)}
                      </select>
                    ) : (
                      c.corretor_id ? nomes.get(c.corretor_id) : <span className="mudo">fora da equipe</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Integracoes() {
  const { dados } = useCarregar(async () => exigir(await supabase.from("sincronizacoes").select("iniciada_em, sucesso, imoveis_no_xml, erro").order("iniciada_em", { ascending: false }).limit(1)), []);
  const leitura = dados?.[0];
  const itens = [
    ["pronto", "✓", "WhatsApp oficial", "(67) 99820-6049 ligado à API da Meta. A IA responde e o corretor responde por aqui.", "Ligado"],
    ["pronto", "✓", "Inteligência artificial (Claude)", "Atende, qualifica, consulta imóveis e passa ao corretor.", "Ligado"],
    [leitura?.sucesso === false ? "alerta" : "pronto", leitura?.sucesso === false ? "!" : "✓", "Estoque do Univen", leitura ? `Última leitura ${haQuanto(leitura.iniciada_em)} · ${leitura.imoveis_no_xml ?? "—"} imóveis${leitura.erro ? ` · erro: ${leitura.erro}` : ""}` : "Lido a cada 15 minutos.", leitura?.sucesso === false ? "Com erro" : "Ligado"],
    ["pronto", "✓", "Aviso ao corretor pelo WhatsApp", "O corretor recebe o lead no WhatsApp com os botões Assumir e Não posso agora.", "Ligado"],
    ["pendente", "·", "Envio do lead ao Univen", "Aguarda a Union informar como receber leads.", "Pendente"],
    ["pronto", "✓", "Áudios, fotos e documentos", "Áudio é transcrito na VPS; foto e PDF vão para a IA.", "Ligado"],
  ];
  return (
    <div className="painel">
      <ul className="lista">
        {itens.map(([classe, marca, titulo, descricao, estado]) => (
          <li key={titulo} className="item-status">
            <span className={`marcador ${classe}`}>{marca}</span>
            <div><div className="titulo">{titulo}</div><div className="mudo pequeno">{descricao}</div></div>
            <span className={`etiqueta ${classe}`}>{estado}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
