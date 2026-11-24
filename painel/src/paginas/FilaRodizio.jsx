import { Carregando, contagem, dataHora, Erro, EtiquetaPrazo, hora, PRAZO_ATENCAO_LEAD, useAgora, useCarregar } from "../comum.jsx";
import { useSessao } from "../sessao.jsx";
import { exigir, supabase } from "../supabase.js";

const NOME_DO_PERIODO = { comercial: "horário comercial (todos do rodízio)", plantao: "plantão (só quem ligou o botão)", fora: "fora do horário (sem rodízio)" };

export const REGRAS_DO_RODIZIO = {
  mais_tempo: "Vez de quem está há mais tempo sem receber",
  ordem_fixa: "Ordem fixa definida pelo gestor",
  menos_hoje: "Quem recebeu menos leads hoje",
};

const RESULTADO = { aceita: ["assumiu", "pronto"], pendente: ["aguardando", "alerta"], expirada: ["perdeu o prazo", "pendente"], recusada: ["passou adiante", "pendente"], cancelada: ["cancelado", "pendente"] };

const inicioDeHoje = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
};

// Fila do rodízio como o sistema vai usar agora: só para ver, ninguém mexe aqui.
export function useFilaDoRodizio() {
  const { versao } = useSessao();
  return useCarregar(async () => {
    const [fila, regras, equipe] = await Promise.all([
      supabase.rpc("fila_do_rodizio"),
      supabase.rpc("regras_do_rodizio"),
      supabase.from("corretores").select("id, nome, ativo, no_rodizio, de_plantao, foto_url").order("nome"),
    ]);
    return { fila: exigir(fila) ?? [], regras: exigir(regras) ?? {}, equipe: exigir(equipe) };
  }, [versao]);
}

export function ProximoDoRodizio({ ir }) {
  const { eu } = useSessao();
  const { dados } = useFilaDoRodizio();
  if (!dados) return null;
  const nomes = new Map(dados.equipe.map((c) => [c.id, c.nome]));
  const proximo = dados.fila[0];
  const quem = proximo ? nomes.get(proximo.corretor_id)?.split(" ")[0] : "ninguém de plantão";
  // O corretor não abre a fila: o cartão é só informativo.
  if (eu.papel === "corretor") return <span className="seletor"><span className="rotulo">Próximo do rodízio</span>{quem}</span>;
  return (
    <button type="button" className="seletor seletor-botao" onClick={() => ir("plantao")} title="Ver a fila do rodízio">
      <span className="rotulo">Próximo do rodízio</span>
      {quem}
    </button>
  );
}

export default function FilaDoRodizio({ atribuicoes = [], leads = new Map(), abrirLead }) {
  const { dados, erro } = useFilaDoRodizio();
  const agora = useAgora();
  if (!dados) return <><Erro mensagem={erro} /><Carregando /></>;

  const pessoas = new Map(dados.equipe.map((c) => [c.id, c]));
  const nome = (id) => pessoas.get(id)?.nome ?? "Corretor";
  const naFila = new Set(dados.fila.map((f) => f.corretor_id));
  const fora = dados.equipe.filter((c) => c.ativo && c.no_rodizio && !naFila.has(c.id));
  const hoje = inicioDeHoje();
  const deHoje = atribuicoes.filter((a) => a.oferecida_em >= hoje);
  const regra = REGRAS_DO_RODIZIO[dados.regras.regra] ?? REGRAS_DO_RODIZIO.mais_tempo;

  return (
    <div className="grade-2">
      <div className="painel fila-rodizio">
        <h3>Fila do rodízio <span className="etiqueta pronto">{dados.fila.length} de plantão</span></h3>
        <p className="mudo pequeno" style={{ margin: 0 }}>
          Lead de imóvel vai primeiro ao captador do imóvel. Sem captador, segue a fila: <b>{regra.toLowerCase()}</b>. Prazo para assumir: {dados.regras.prazo_minutos ?? "—"} min; para responder depois de assumir: {dados.regras.prazo_resposta_minutos ?? "—"} min.
          {dados.regras.horarios && <> Agora: <b>{NOME_DO_PERIODO[dados.regras.periodo] ?? "—"}</b> (comercial {dados.regras.horarios.inicio}–{dados.regras.horarios.fim_comercial}, plantão até {dados.regras.horarios.fim_plantao}).</>}
        </p>
        {dados.regras.em_pausa && (
          <p className="aviso-ok" role="status" style={{ margin: 0 }}>
            🌙 Fora do horário: sem rodízio e nenhum prazo corre. O captador do imóvel é avisado na hora; o fluxo volta às {dados.regras.horarios?.inicio}.
          </p>
        )}
        {dados.fila.length === 0 ? (
          <div className="vazio"><span className="marcador alerta">!</span><div><b>Ninguém de plantão</b><p>Os leads ficam aguardando no painel até alguém ligar o plantão.</p></div></div>
        ) : (
          <ol className="fila">
            {dados.fila.map((f, i) => (
              <li key={f.corretor_id} className={i === 0 ? "proximo" : ""}>
                <span className="posicao">{i === 0 ? "Próximo" : `${f.posicao}º`}</span>
                <span className="quem">
                  {pessoas.get(f.corretor_id)?.foto_url ? <img src={pessoas.get(f.corretor_id).foto_url} alt="" /> : null}
                  <b>{nome(f.corretor_id)}</b>
                </span>
                <span className="detalhe-fila">
                  {f.oferta_ate
                    ? <EtiquetaPrazo prazo={f.oferta_ate} atencaoMin={PRAZO_ATENCAO_LEAD} agora={agora}>lead aguardando · faltam {contagem(f.oferta_ate, agora)}</EtiquetaPrazo>
                    : f.ultimo_lead ? `último lead ${dataHora(f.ultimo_lead)}` : "ainda não recebeu"}
                  {f.recebidos_hoje > 0 && <span className="mudo"> · {f.recebidos_hoje} hoje</span>}
                </span>
              </li>
            ))}
          </ol>
        )}
        {fora.length > 0 && <p className="mudo pequeno" style={{ margin: 0 }}>Fora do plantão: {fora.map((c) => c.nome.split(" ")[0]).join(", ")}</p>}
      </div>

      <div className="painel">
        <h3>Distribuídos hoje <span className="etiqueta pendente">{deHoje.length}</span></h3>
        {deHoje.length === 0 ? (
          <p className="mudo pequeno" style={{ margin: 0 }}>Nenhum lead foi passado aos corretores hoje.</p>
        ) : (
          <ul className="lista distribuidos">
            {deHoje.map((a) => {
              const [texto, cor] = RESULTADO[a.status] ?? [a.status, "pendente"];
              return (
                <li key={a.id}>
                  <button type="button" className="linha-distribuido" onClick={() => abrirLead?.(a.lead_id)}>
                    <span className="dado">{hora(a.oferecida_em)}</span>
                    <span className="quem-recebeu">
                      <b>{leads.get(a.lead_id)?.nome ?? "Cliente sem nome"}</b>
                      <span className="mudo pequeno"> → {nome(a.corretor_id)} · {a.motivo === "captador" ? "captador do imóvel" : a.motivo === "gestor" ? "passado pelo gestor" : "rodízio"}</span>
                    </span>
                    <span className={`etiqueta ${cor}`}>{texto}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
