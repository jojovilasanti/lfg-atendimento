// Compartilhar imóvel com o cliente, como nos grandes portais.
// O link abre a página pública lfg.jojodigitals.com/imovel/<REF>?c=<slug>; o
// WhatsApp de lá vai para o número oficial e entrega o lead a quem compartilhou.
// Cada envio é contado (registrar_compartilhamento) e o gestor vê os números na ficha.
import { useState } from "react";
import { Carregando, Erro, nomeTipo, reais, telefone, useCarregar } from "./comum.jsx";
import { Janela } from "./crm.jsx";
import { areaDoImovel, metros } from "./imoveis.js";
import { useSessao } from "./sessao.jsx";
import { exigir, supabase } from "./supabase.js";

const ENDERECO = "https://lfg.jojodigitals.com/imovel";

export function linkDoImovel(imovel, slug) {
  const ref = String(imovel.referencia || imovel.codigo).replace(/[^A-Za-z0-9-]/g, "");
  return `${ENDERECO}/${ref}${slug ? `?c=${encodeURIComponent(slug)}` : ""}`;
}

export function mensagemDoImovel(imovel, link) {
  const tipo = nomeTipo(imovel.tipo) || "Imóvel";
  const operacao = imovel.venda && imovel.locacao ? "para venda ou aluguel" : imovel.locacao ? "para alugar" : "à venda";
  const linhas = [`${tipo} ${operacao}${imovel.bairro ? ` no ${imovel.bairro}` : ""}`];
  const precos = [];
  if (imovel.venda && Number(imovel.valor_venda) > 0) precos.push(`Venda: ${reais(imovel.valor_venda)}`);
  if (imovel.locacao && Number(imovel.valor_locacao) > 0) precos.push(`Aluguel: ${reais(imovel.valor_locacao)}/mês`);
  if (Number(imovel.valor_condominio) > 0) precos.push(`Condomínio: ${reais(imovel.valor_condominio)}`);
  if (precos.length) linhas.push(precos.join(" · "));
  const dados = [];
  if (imovel.dormitorios) dados.push(`${imovel.dormitorios} quarto${imovel.dormitorios > 1 ? "s" : ""}${imovel.suites ? ` (${imovel.suites} suíte${imovel.suites > 1 ? "s" : ""})` : ""}`);
  if (imovel.vagas) dados.push(`${imovel.vagas} vaga${imovel.vagas > 1 ? "s" : ""}`);
  const area = areaDoImovel(imovel);
  if (area) dados.push(metros(area));
  if (dados.length) linhas.push(dados.join(" · "));
  linhas.push("", `Veja as fotos e os detalhes: ${link}`);
  return linhas.join("\n");
}

const registrar = (codigo, canal, leadId = null) =>
  supabase.rpc("registrar_compartilhamento", { p_imovel: codigo, p_canal: canal, p_lead_id: leadId }).then(() => {}, () => {});

export function BotaoCompartilhar({ imovel, className = "botao" }) {
  const [aberto, setAberto] = useState(false);
  return (
    <>
      <button type="button" className={`${className} botao-compartilhar`} onClick={() => setAberto(true)}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4" />
        </svg>
        Compartilhar
      </button>
      {aberto && <JanelaCompartilhar imovel={imovel} aoFechar={() => setAberto(false)} />}
    </>
  );
}

function JanelaCompartilhar({ imovel, aoFechar }) {
  const { eu } = useSessao();
  const link = linkDoImovel(imovel, eu.slug);
  const [texto, setTexto] = useState(() => mensagemDoImovel(imovel, link));
  const [aviso, setAviso] = useState(null);
  const temNativo = typeof navigator !== "undefined" && typeof navigator.share === "function";

  // Clientes ligados a este imóvel (que a pessoa pode ver): manda direto no número deles.
  const clientes = useCarregar(async () => exigir(
    await supabase.from("leads").select("id, nome, whatsapp").eq("imovel_codigo", imovel.codigo).neq("status", "encerrado")
      .order("ultima_mensagem_cliente_em", { ascending: false, nullsFirst: false }).limit(5),
  ).filter((l) => /^\d{10,13}$/.test(l.whatsapp)), [imovel.codigo]);

  const abrirWhatsapp = (numero, canal, leadId) => {
    registrar(imovel.codigo, canal, leadId);
    window.open(`https://wa.me/${numero ?? ""}?text=${encodeURIComponent(texto)}`, "_blank", "noopener");
  };

  async function nativo() {
    try {
      await navigator.share({ title: `${nomeTipo(imovel.tipo) || "Imóvel"} ${imovel.referencia}`, text: texto.replace(link, "").trim(), url: link });
      registrar(imovel.codigo, "nativo");
    } catch {
      // A pessoa fechou a janela do celular sem escolher: nada a fazer.
    }
  }

  async function copiar() {
    try {
      await navigator.clipboard.writeText(link);
      registrar(imovel.codigo, "copiar");
      setAviso("Link copiado!");
      setTimeout(() => setAviso(null), 2500);
    } catch {
      setAviso("Não deu para copiar. Segure o dedo no link abaixo e copie.");
    }
  }

  return (
    <Janela titulo={`Compartilhar ${imovel.referencia}`} aoFechar={aoFechar}>
      <div className="formulario compartilhar">
        <label className="campo">
          Mensagem <small className="mudo">(dá para editar antes de enviar)</small>
          <textarea rows={7} value={texto} onChange={(e) => setTexto(e.target.value)} />
        </label>

        <div className="opcoes-compartilhar">
          <button type="button" className="botao botao-whatsapp-grande" onClick={() => abrirWhatsapp(null, "whatsapp")}>WhatsApp</button>
          {temNativo && <button type="button" className="botao secundario" onClick={nativo}>Instagram, Messenger e outros</button>}
          <button type="button" className="botao secundario" onClick={copiar}>Copiar link</button>
        </div>
        {aviso && <p className="aviso-ok" role="status" style={{ margin: 0 }}>{aviso}</p>}

        {clientes.dados?.length > 0 && (
          <div className="bloco-detalhe">
            <span className="rotulo-detalhe">Mandar direto para o cliente</span>
            {clientes.dados.map((l) => (
              <button key={l.id} type="button" className="botao secundario linha-cliente" onClick={() => abrirWhatsapp(l.whatsapp, "whatsapp_cliente", l.id)}>
                <span><b>{l.nome ?? "Cliente"}</b> · {telefone(l.whatsapp)}</span><span aria-hidden="true">›</span>
              </button>
            ))}
          </div>
        )}
        <Erro mensagem={clientes.erro} />

        <p className="mudo pequeno" style={{ margin: 0, overflowWrap: "anywhere" }}>
          {link}
          {!eu.slug && <><br />Seu link ainda sai sem o seu nome: peça ao gestor para preencher o endereço da sua página em Configurações → Equipe.</>}
        </p>
      </div>
    </Janela>
  );
}

// Ficha do imóvel, só para gestor e administrativo: compartilhamentos e cliques.
export function NumerosDoCompartilhamento({ imovel }) {
  const { dados, erro } = useCarregar(async () => exigir(await supabase.rpc("estatisticas_compartilhamento", { p_imovel: imovel.codigo })), [imovel.codigo]);
  return (
    <div className="painel">
      <h3>Compartilhamentos</h3>
      <Erro mensagem={erro} />
      {!dados ? <Carregando /> : (
        <>
          <ul className="numeros-compartilhar">
            <li><b className="dado">{dados.compartilhamentos}</b><span>enviados</span></li>
            <li><b className="dado">{dados.aberturas}</b><span>aberturas</span></li>
            <li><b className="dado">{dados.cliques}</b><span>cliques no WhatsApp</span></li>
            <li><b className="dado">{dados.leads}</b><span>leads</span></li>
          </ul>
          {dados.por_corretor.length > 0 && (
            <ul className="pequeno" style={{ margin: 0, paddingLeft: 18 }}>
              {dados.por_corretor.map((p) => <li key={p.nome}>{p.nome}: {p.compartilhamentos} enviados, {p.aberturas} aberturas, {p.cliques} cliques</li>)}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
