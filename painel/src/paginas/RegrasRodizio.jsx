import { useEffect, useState } from "react";
import { Carregando, Erro, useCarregar } from "../comum.jsx";
import { useSessao } from "../sessao.jsx";
import { exigir, mensagemDeErro, supabase } from "../supabase.js";
import { REGRAS_DO_RODIZIO } from "./FilaRodizio.jsx";

const EXPLICACAO = {
  mais_tempo: "Recebe quem está há mais tempo sem receber lead do rodízio. Divide de forma justa ao longo do dia.",
  ordem_fixa: "Segue a sequência abaixo e volta ao primeiro depois do último. Quem está fora do plantão é pulado.",
  menos_hoje: "Recebe quem recebeu menos leads do rodízio hoje. No empate, quem está há mais tempo sem receber.",
};

// Regras do rodízio: só o gestor muda. A regra principal (captador do imóvel
// primeiro) é fixa e vale antes de qualquer uma destas.
export default function RegrasRodizio() {
  const { souGestor, versao, recarregar } = useSessao();
  const { dados, erro } = useCarregar(async () => {
    const [regras, equipe] = await Promise.all([
      supabase.rpc("regras_do_rodizio"),
      supabase.from("corretores").select("id, nome, ativo, no_rodizio, de_plantao, ordem_rodizio").order("ordem_rodizio", { nullsFirst: false }).order("nome"),
    ]);
    return { regras: exigir(regras) ?? {}, equipe: exigir(equipe) };
  }, [versao]);
  const [regra, setRegra] = useState("mais_tempo");
  const [fimDaFila, setFimDaFila] = useState(true);
  const [ordem, setOrdem] = useState([]);
  const [ocupado, setOcupado] = useState(false);
  const [erroSalvar, setErroSalvar] = useState(null);
  const [salvo, setSalvo] = useState(null);

  useEffect(() => {
    if (!dados) return;
    setRegra(dados.regras.regra ?? "mais_tempo");
    setFimDaFila(dados.regras.perder_prazo_vai_para_fim !== false);
    setOrdem(dados.equipe.filter((c) => c.ativo && c.no_rodizio));
  }, [dados]);

  if (!dados) return <><Erro mensagem={erro} /><Carregando /></>;

  const mover = (de, para) => {
    if (para < 0 || para >= ordem.length) return;
    const nova = [...ordem];
    const [item] = nova.splice(de, 1);
    nova.splice(para, 0, item);
    setOrdem(nova);
  };

  async function salvar(evento) {
    evento.preventDefault();
    setOcupado(true);
    setErroSalvar(null);
    setSalvo(null);
    try {
      exigir(await supabase.rpc("salvar_regras_rodizio", { p_regra: regra, p_perder_prazo_vai_para_fim: fimDaFila, p_ordem: ordem.map((c) => c.id) }));
      setSalvo("Regras do rodízio salvas. Valem para o próximo lead.");
      recarregar();
    } catch (e) {
      setErroSalvar(mensagemDeErro(e));
    } finally {
      setOcupado(false);
    }
  }

  return (
    <form className="painel formulario" onSubmit={salvar}>
      <h3 style={{ margin: 0 }}>Rodízio de leads {!souGestor && <span className="etiqueta pendente">só o gestor altera</span>}</h3>
      <div className="regra-fixa">
        <b>Regra principal (sempre):</b> lead de imóvel vai primeiro ao corretor captador do imóvel. Se ele não assumir no prazo, ou se o imóvel não tiver captador na equipe, o lead segue para o rodízio abaixo.
      </div>

      <fieldset disabled={!souGestor} style={{ border: 0, padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
        <legend className="rotulo" style={{ marginBottom: 8 }}>Como escolher o próximo do rodízio</legend>
        <div className="opcoes-radio opcoes-radio-coluna">
          {Object.entries(REGRAS_DO_RODIZIO).map(([id, nome]) => (
            <label key={id} className={regra === id ? "marcado" : ""}>
              <input type="radio" name="regra-rodizio" value={id} checked={regra === id} onChange={() => setRegra(id)} />
              <span><b>{nome}</b><span className="mudo pequeno" style={{ display: "block" }}>{EXPLICACAO[id]}</span></span>
            </label>
          ))}
        </div>
        <label className="linha-marcar">
          <input type="checkbox" checked={fimDaFila} onChange={(e) => setFimDaFila(e.target.checked)} />
          Quem perde o prazo ou passa o lead adiante vai para o fim da fila
        </label>
      </fieldset>

      <div className="formulario">
        <span className="rotulo">Ordem da equipe {regra === "ordem_fixa" ? "(sequência do rodízio)" : "(usada para desempatar)"}</span>
        <ol className="ordem-equipe">
          {ordem.map((c, i) => (
            <li key={c.id}>
              <span className="dado">{i + 1}º</span>
              <span className="nome">{c.nome}{!c.de_plantao && <span className="mudo pequeno"> · fora do plantão</span>}</span>
              {souGestor && (
                <span className="setas">
                  <button type="button" className="botao secundario pequeno" aria-label={`Subir ${c.nome}`} disabled={i === 0} onClick={() => mover(i, i - 1)}>↑ Subir</button>
                  <button type="button" className="botao secundario pequeno" aria-label={`Descer ${c.nome}`} disabled={i === ordem.length - 1} onClick={() => mover(i, i + 1)}>↓ Descer</button>
                </span>
              )}
            </li>
          ))}
        </ol>
        <p className="mudo pequeno" style={{ margin: 0 }}>Aparecem aqui só as pessoas com "No rodízio" ligado (tela Plantão). O tempo para assumir fica nas Regras do plantão, acima.</p>
      </div>

      <Erro mensagem={erroSalvar} />
      {salvo && <p className="aviso-ok" role="status" style={{ margin: 0 }}>{salvo}</p>}
      {souGestor && <button className="botao" type="submit" disabled={ocupado} style={{ alignSelf: "flex-start" }}>{ocupado ? "Salvando…" : "Salvar rodízio"}</button>}
    </form>
  );
}
