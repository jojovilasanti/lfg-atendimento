// Configurações → Campanhas da Thais: o que a Thais sabe de cada campanha de
// anúncio (ex.: loteamento Atmosphere) e como atender esses clientes. O lead é
// reconhecido pelas palavras da campanha no anúncio ou na mensagem e fica com a
// origem da campanha. Mudou e salvou: vale na próxima mensagem (até 1 minuto).
import { useEffect, useState } from "react";
import { Carregando, Erro, Interruptor, useCarregar } from "../comum.jsx";
import { useSessao } from "../sessao.jsx";
import { exigir, mensagemDeErro, supabase } from "../supabase.js";

const VAZIA = { id: null, nome: "", origem: "Facebook Ads – ", palavras: [], base: "", perguntas: [], proibido: "", exemplo: "", ativo: true };

export default function CampanhasDaThais() {
  const { versao, recarregar } = useSessao();
  const { dados, erro } = useCarregar(async () => exigir(await supabase.from("campanhas_ia").select("*").order("criado_em")), [versao]);
  const [aberta, setAberta] = useState(null);

  useEffect(() => {
    if (dados?.length && !aberta) setAberta(dados[0].id);
  }, [dados]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!dados) return <><Erro mensagem={erro} /><Carregando /></>;
  const atual = aberta === "nova" ? VAZIA : dados.find((c) => c.id === aberta);

  return (
    <div className="formulario">
      <div className="painel formulario">
        <h3 style={{ margin: 0 }}>Campanhas da Thais</h3>
        <p className="mudo" style={{ margin: 0 }}>
          O que a Thais sabe de cada campanha e como atender esses clientes. Quando o anúncio ou a mensagem do cliente traz uma das palavras da campanha, o lead fica com a origem dela e a Thais usa estas informações. Ela nunca inventa o que não estiver aqui.
        </p>
        <div className="filtros" role="group" aria-label="Campanhas">
          {dados.map((c) => (
            <button key={c.id} type="button" className="filtro" aria-pressed={aberta === c.id} onClick={() => setAberta(c.id)}>
              {c.nome} {!c.ativo && <small className="mudo">(desligada)</small>}
            </button>
          ))}
          <button type="button" className="filtro" aria-pressed={aberta === "nova"} onClick={() => setAberta("nova")}>+ Nova campanha</button>
        </div>
      </div>
      {atual && <EditarCampanha key={atual.id ?? "nova"} campanha={atual} aoSalvar={(id) => { recarregar(); setAberta(id); }} />}
    </div>
  );
}

function EditarCampanha({ campanha, aoSalvar }) {
  const [c, setC] = useState({ ...campanha, palavrasTexto: campanha.palavras.join(", "), perguntasTexto: campanha.perguntas.join("\n") });
  const [ocupado, setOcupado] = useState(false);
  const [aviso, setAviso] = useState(null);
  const mudar = (campo) => (e) => setC({ ...c, [campo]: e.target.value });

  async function salvar(evento) {
    evento.preventDefault();
    setOcupado(true);
    setAviso(null);
    try {
      const id = exigir(await supabase.rpc("salvar_campanha_ia", {
        p_id: c.id,
        p_nome: c.nome,
        p_origem: c.origem,
        p_palavras: c.palavrasTexto.split(/[,\n]/).map((p) => p.trim()).filter(Boolean),
        p_base: c.base,
        p_perguntas: c.perguntasTexto.split("\n").map((p) => p.trim()).filter(Boolean),
        p_proibido: c.proibido,
        p_exemplo: c.exemplo,
        p_ativo: c.ativo,
      }));
      setAviso(["ok", "Salvo. A Thais usa a versão nova a partir da próxima mensagem (em até 1 minuto)."]);
      aoSalvar(id);
    } catch (e) {
      setAviso(["erro", mensagemDeErro(e)]);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <form className="painel formulario" onSubmit={salvar}>
      <div className="grade-prazos">
        <label className="campo">
          Nome da campanha
          <input required minLength={2} maxLength={80} value={c.nome} onChange={mudar("nome")} placeholder="Atmosphere (Plaenge)" />
        </label>
        <label className="campo">
          Origem que aparece no lead
          <input required minLength={2} maxLength={80} value={c.origem} onChange={mudar("origem")} placeholder="Facebook Ads – Atmosphere" />
        </label>
      </div>
      <label className="campo">
        Palavras que reconhecem o cliente <small className="mudo">(separadas por vírgula; maiúsculas e acentos não importam)</small>
        <input required value={c.palavrasTexto} onChange={mudar("palavrasTexto")} placeholder="atmosphere, plaenge, chácara dos poderes" />
      </label>
      <label className="campo">
        Informações do empreendimento <small className="mudo">(a Thais usa só o que estiver aqui)</small>
        <textarea rows={14} maxLength={8000} value={c.base} onChange={mudar("base")} />
      </label>
      <label className="campo">
        Perguntas de qualificação <small className="mudo">(uma por linha, na ordem; a Thais faz uma por vez)</small>
        <textarea rows={6} value={c.perguntasTexto} onChange={mudar("perguntasTexto")} />
      </label>
      <label className="campo">
        O que a Thais não pode fazer
        <textarea rows={4} maxLength={3000} value={c.proibido} onChange={mudar("proibido")} />
      </label>
      <label className="campo">
        Exemplo de primeira resposta <small className="mudo">([nome] vira o nome do cliente)</small>
        <textarea rows={4} maxLength={1500} value={c.exemplo} onChange={mudar("exemplo")} />
      </label>
      <label className="campo" style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Interruptor ligado={c.ativo} aoMudar={(v) => setC({ ...c, ativo: v })} rotulo={c.ativo ? "Desligar campanha" : "Ligar campanha"} />
        <span>{c.ativo ? "Campanha ligada: a Thais reconhece e atende esses clientes" : "Campanha desligada: a Thais atende como um cliente comum"}</span>
      </label>
      {aviso && <p className={aviso[0] === "ok" ? "aviso-ok" : "aviso-erro"} role="status" style={{ margin: 0 }}>{aviso[1]}</p>}
      <button type="submit" className="botao" style={{ alignSelf: "flex-start" }} disabled={ocupado}>{ocupado ? "Salvando…" : "Salvar campanha"}</button>
    </form>
  );
}
