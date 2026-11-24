import { useEffect, useState } from "react";
import { Carregando, dataHora, Erro, useCarregar } from "../comum.jsx";
import { imagemDaMarca } from "../fotosDoImovel.js";
import { EMPRESA_PADRAO, logoDaEmpresa, useSessao } from "../sessao.jsx";
import { exigir, mensagemDeErro, supabase, SUPABASE_URL } from "../supabase.js";

const LIMITE_IMAGEM = 5 * 1024 * 1024;
export const ENDERECO_API = `${SUPABASE_URL}/functions/v1/api-imoveis`;

// Fusos do Brasil, de leste a oeste.
const FUSOS = [
  ["America/Noronha", "Fernando de Noronha"],
  ["America/Sao_Paulo", "São Paulo, Rio, Brasília, Sul e Sudeste"],
  ["America/Bahia", "Salvador (BA)"],
  ["America/Fortaleza", "Fortaleza (CE) e Nordeste"],
  ["America/Recife", "Recife (PE)"],
  ["America/Maceio", "Maceió (AL) e Aracaju (SE)"],
  ["America/Belem", "Belém (PA) e Amapá"],
  ["America/Araguaina", "Tocantins"],
  ["America/Santarem", "Oeste do Pará"],
  ["America/Campo_Grande", "Campo Grande (MS)"],
  ["America/Cuiaba", "Cuiabá (MT)"],
  ["America/Manaus", "Manaus (AM)"],
  ["America/Porto_Velho", "Porto Velho (RO)"],
  ["America/Boa_Vista", "Boa Vista (RR)"],
  ["America/Rio_Branco", "Rio Branco (AC)"],
  ["America/Eirunepe", "Oeste do Amazonas"],
];

const POSICOES = [
  ["centro", "Centro"],
  ["superior_esquerdo", "Canto superior esquerdo"],
  ["superior_direito", "Canto superior direito"],
  ["inferior_esquerdo", "Canto inferior esquerdo"],
  ["inferior_direito", "Canto inferior direito"],
];

function horaNoFuso(fuso) {
  try {
    return new Date().toLocaleTimeString("pt-BR", { timeZone: fuso, hour: "2-digit", minute: "2-digit" });
  } catch {
    return "—";
  }
}

function EnviarImagem({ pasta, rotulo, aoEnviar, aoFalhar }) {
  const [enviando, setEnviando] = useState(false);
  async function enviar(evento) {
    const arquivo = evento.target.files?.[0];
    evento.target.value = "";
    if (!arquivo) return;
    if (arquivo.size > LIMITE_IMAGEM) return aoFalhar("A imagem precisa ter até 5 MB.");
    setEnviando(true);
    try {
      const extensao = arquivo.type.split("/")[1] ?? "png";
      const caminho = `empresa/${pasta}-${Date.now()}.${extensao}`;
      exigir(await supabase.storage.from("site").upload(caminho, arquivo, { contentType: arquivo.type }));
      aoEnviar(supabase.storage.from("site").getPublicUrl(caminho).data.publicUrl);
    } catch (e) {
      aoFalhar(mensagemDeErro(e));
    } finally {
      setEnviando(false);
    }
  }
  return (
    <label className="botao secundario pequeno">
      {enviando ? "Enviando…" : rotulo}
      <input type="file" accept="image/png,image/webp,image/jpeg" className="invisivel" disabled={enviando} onChange={enviar} />
    </label>
  );
}

// Prévia da marca d'água: mesma silhueta branca, tamanho, canto e transparência
// que o painel usa ao baixar as fotos e que o site mostra.
function PreviaDaMarca({ marca, empresa }) {
  const { dados: foto } = useCarregar(async () => {
    const proprio = exigir(await supabase.from("imoveis").select("foto_principal").eq("origem", "proprio").not("foto_principal", "is", null).limit(1));
    if (proprio[0]?.foto_principal) return proprio[0].foto_principal;
    const qualquer = exigir(await supabase.from("imoveis").select("foto_principal").eq("ativo", true).not("foto_principal", "is", null).limit(1));
    return qualquer[0]?.foto_principal ?? null;
  }, []);
  const [vertical, horizontal] = marca.posicao === "centro" ? ["centro", "centro"] : marca.posicao.split("_");
  return (
    <div className="previa-marca" aria-label="Prévia da marca d'água">
      {foto ? <img src={foto} alt="" /> : <span className="previa-vazia" />}
      {marca.ativa && (
        <img
          className={`marca-sobre v-${vertical} h-${horizontal}`}
          src={imagemDaMarca(marca, empresa)}
          alt=""
          style={{ width: `${marca.tamanho}%`, opacity: marca.opacidade / 100 }}
        />
      )}
    </div>
  );
}

function ChaveDeApi({ api, aoMudarApi }) {
  const [criadaEm, setCriadaEm] = useState(undefined);
  const [novaChave, setNovaChave] = useState(null);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState(null);
  const [copiado, setCopiado] = useState(null);

  const ler = async () => setCriadaEm(exigir(await supabase.rpc("situacao_chave_api")));
  useEffect(() => {
    ler().catch((e) => setErro(mensagemDeErro(e)));
  }, []);

  async function agir(acao) {
    setOcupado(true);
    setErro(null);
    try {
      await acao();
      await ler();
    } catch (e) {
      setErro(mensagemDeErro(e));
    } finally {
      setOcupado(false);
    }
  }
  const gerar = () => {
    if (criadaEm && !confirm("A chave atual para de funcionar na hora. Quem usa a chave antiga vai precisar da nova. Gerar outra?")) return;
    agir(async () => setNovaChave(exigir(await supabase.rpc("gerar_chave_api"))));
  };
  const desligar = () => {
    if (!confirm("Desligar a chave de API? Quem usa a chave para de receber os imóveis.")) return;
    agir(async () => {
      exigir(await supabase.rpc("desligar_chave_api"));
      setNovaChave(null);
    });
  };
  const copiar = async (texto, qual) => {
    await navigator.clipboard.writeText(texto);
    setCopiado(qual);
    setTimeout(() => setCopiado(null), 2000);
  };

  return (
    <div className="formulario">
      {criadaEm === undefined ? <Carregando /> : (
        <p style={{ margin: 0 }}>
          {criadaEm ? <>Chave ligada desde {dataHora(criadaEm)}.</> : "Nenhuma chave ligada. Ninguém de fora consegue ler os imóveis."}
        </p>
      )}
      {novaChave && (
        <div className="aviso-chave" role="status">
          <b>Copie a chave agora.</b> Por segurança ela não aparece de novo; se perder, gere outra.
          <code>{novaChave}</code>
          <button type="button" className="botao pequeno" onClick={() => copiar(novaChave, "chave")}>{copiado === "chave" ? "Copiada" : "Copiar chave"}</button>
        </div>
      )}
      <div className="atalhos">
        <button type="button" className="botao secundario" disabled={ocupado} onClick={gerar}>{criadaEm ? "Gerar nova chave" : "Gerar chave"}</button>
        {criadaEm && <button type="button" className="botao secundario perigo" disabled={ocupado} onClick={desligar}>Desligar chave</button>}
      </div>
      <dl className="pares">
        <dt>Endereço</dt>
        <dd>
          <code className="quebra">{ENDERECO_API}</code>{" "}
          <button type="button" className="botao secundario pequeno" onClick={() => copiar(ENDERECO_API, "endereco")}>{copiado === "endereco" ? "Copiado" : "Copiar"}</button>
        </dd>
        <dt>Como usar</dt>
        <dd>Pedido GET com o cabeçalho <code>x-api-key: sua-chave</code>. A resposta traz os imóveis em JSON.</dd>
      </dl>
      <label className="linha-marcar">
        <input type="checkbox" checked={api.mostrar_internos} onChange={(e) => aoMudarApi({ mostrar_internos: e.target.checked })} />
        Mostrar informações internas do imóvel (endereço completo, CEP, captador, ocupação e taxa de administração)
      </label>
      <label className="linha-marcar">
        <input type="checkbox" checked={api.mostrar_indisponiveis} onChange={(e) => aoMudarApi({ mostrar_indisponiveis: e.target.checked })} />
        Mostrar também os imóveis indisponíveis
      </label>
      <p className="mudo pequeno" style={{ margin: 0 }}>Essas duas opções valem depois de clicar em Salvar, no fim da página. Rascunhos nunca aparecem.</p>
      <Erro mensagem={erro} />
    </div>
  );
}

export default function ConfigGerais() {
  const { empresa, recarregarEmpresa } = useSessao();
  const [campos, setCampos] = useState(null);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState(null);
  const [salvo, setSalvo] = useState(null);

  useEffect(() => {
    setCampos((atual) => atual ?? structuredClone({ ...EMPRESA_PADRAO, ...empresa }));
  }, [empresa]);
  if (!campos) return <Carregando />;

  const mudar = (campo) => (e) => setCampos({ ...campos, [campo]: e.target.value });
  const mudarMarca = (mudancas) => setCampos({ ...campos, marca: { ...campos.marca, ...mudancas } });
  const mudarApi = (mudancas) => setCampos({ ...campos, api: { ...campos.api, ...mudancas } });

  async function salvar(evento) {
    evento.preventDefault();
    setOcupado(true);
    setErro(null);
    setSalvo(null);
    try {
      const gravado = exigir(await supabase.rpc("salvar_empresa", { p_valor: campos }));
      setCampos(structuredClone({ ...EMPRESA_PADRAO, ...gravado }));
      setSalvo("Configurações salvas. O site atualiza em até 1 minuto.");
      recarregarEmpresa();
    } catch (e) {
      setErro(mensagemDeErro(e));
    } finally {
      setOcupado(false);
    }
  }

  const fusoNaLista = FUSOS.some(([id]) => id === campos.fuso);

  return (
    <form className="formulario config-gerais" onSubmit={salvar}>
      <section className="painel formulario">
        <h3 style={{ margin: 0 }}>Empresa</h3>
        <label className="campo">Nome da empresa<input id="empresa-nome" required maxLength={80} value={campos.nome} onChange={mudar("nome")} /></label>
        <div className="campo-imagem">
          <span className="rotulo">Logo</span>
          <img className="logo-previa" src={logoDaEmpresa(campos)} alt={`Logo atual: ${campos.nome}`} />
          <p className="mudo pequeno" style={{ margin: 0 }}>PNG com fundo transparente, na horizontal. Aparece na tela de entrada, no topo do painel, no site e é a marca d'água padrão.</p>
          <div className="atalhos">
            <EnviarImagem pasta="logo" rotulo={campos.logo_url ? "Trocar logo" : "Enviar logo"} aoEnviar={(url) => setCampos({ ...campos, logo_url: url })} aoFalhar={setErro} />
            {campos.logo_url && <button type="button" className="botao secundario pequeno" onClick={() => setCampos({ ...campos, logo_url: null })}>Usar a logo da LFG</button>}
          </div>
        </div>
      </section>

      <section className="painel formulario">
        <h3 style={{ margin: 0 }}>Data e horário</h3>
        <label className="campo">Fuso horário
          <select id="empresa-fuso" value={campos.fuso} onChange={mudar("fuso")}>
            {!fusoNaLista && <option value={campos.fuso}>{campos.fuso}</option>}
            {FUSOS.map(([id, nome]) => <option key={id} value={id}>{nome} · agora {horaNoFuso(id)}</option>)}
          </select>
        </label>
        <p className="mudo pequeno" style={{ margin: 0 }}>Vale para as datas e horas do painel, o horário do escritório e o plantão, e para a assistente virtual dizer a hora certa ao cliente.</p>
      </section>

      <section className="painel formulario">
        <div className="linha-titulo">
          <h3 style={{ margin: 0 }}>Marca d'água</h3>
          <button type="button" role="switch" className="interruptor" aria-checked={campos.marca.ativa} aria-label="Ativar marca d'água" onClick={() => mudarMarca({ ativa: !campos.marca.ativa })} />
        </div>
        <p className="mudo pequeno" style={{ margin: 0 }}>Entra nas fotos dos imóveis cadastrados aqui, no site e ao baixar pelo painel. As fotos que vêm do Univen já têm a marca de lá.</p>
        <div className="grade-marca">
          <PreviaDaMarca marca={campos.marca} empresa={campos} />
          <div className="formulario">
            <div className="atalhos">
              <EnviarImagem pasta="marca" rotulo="Usar outra imagem" aoEnviar={(url) => mudarMarca({ imagem_url: url })} aoFalhar={setErro} />
              {campos.marca.imagem_url && <button type="button" className="botao secundario pequeno" onClick={() => mudarMarca({ imagem_url: null })}>Usar a logo</button>}
            </div>
            <label className="campo">Tamanho: {campos.marca.tamanho}% da largura da foto
              <input id="marca-tamanho" type="range" min={10} max={80} step={1} value={campos.marca.tamanho} onChange={(e) => mudarMarca({ tamanho: Number(e.target.value) })} />
            </label>
            <label className="campo">Transparência: {100 - campos.marca.opacidade}%
              <input id="marca-opacidade" type="range" min={10} max={100} step={5} value={campos.marca.opacidade} onChange={(e) => mudarMarca({ opacidade: Number(e.target.value) })} />
            </label>
            <label className="campo">Posição
              <select id="marca-posicao" value={campos.marca.posicao} onChange={(e) => mudarMarca({ posicao: e.target.value })}>
                {POSICOES.map(([id, nome]) => <option key={id} value={id}>{nome}</option>)}
              </select>
            </label>
          </div>
        </div>
      </section>

      <section className="painel formulario">
        <h3 style={{ margin: 0 }}>Rodapé da descrição do imóvel</h3>
        <label className="campo">Texto que entra no fim de toda descrição no site
          <textarea id="empresa-rodape" rows={4} maxLength={1000} value={campos.rodape_descricao} onChange={mudar("rodape_descricao")}
            placeholder="Ex.: As medidas e áreas são aproximadas. Imóvel identificado sob o código [[codigo]]. Fale com [[captador]]." />
        </label>
        <p className="mudo pequeno" style={{ margin: 0 }}>Use <code>[[codigo]]</code> para o código do imóvel e <code>[[captador]]</code> para o nome de quem captou. Deixe em branco para não ter rodapé.</p>
      </section>

      <section className="painel formulario">
        <h3 style={{ margin: 0 }}>Chave da API</h3>
        <p className="mudo pequeno" style={{ margin: 0 }}>Para outro site ou parceiro ler os imóveis direto do sistema. O nosso site não precisa dela.</p>
        <ChaveDeApi api={campos.api} aoMudarApi={mudarApi} />
      </section>

      <Erro mensagem={erro} />
      {salvo && <p className="aviso-ok" role="status" style={{ margin: 0 }}>{salvo}</p>}
      <div className="barra-salvar">
        <button className="botao" type="submit" disabled={ocupado}>{ocupado ? "Salvando…" : "Salvar configurações"}</button>
      </div>
    </form>
  );
}
