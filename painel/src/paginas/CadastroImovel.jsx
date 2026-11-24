import { useEffect, useRef, useState } from "react";
import { BotaoFechar, Carregando, Erro, Interruptor, nomeTipo, reais, telefone, useCarregar } from "../comum.jsx";
import { valorDigitado } from "../crm.jsx";
import {
  avaliarImovel, cepFormatado, COMODIDADES_DO_IMOVEL, COMODIDADES_DO_LOCAL, miniDaFoto, NOME_DA_MOBILIA, NOME_DA_OCUPACAO, nomeDeCaptador, reduzirFoto, semAcento, SITUACOES, TIPOS_DE_CADASTRO,
} from "../imoveis.js";
import { useSessao } from "../sessao.jsx";
import { exigir, mensagemDeErro, supabase } from "../supabase.js";

const ETAPAS = ["Localização", "Proprietário", "Características", "Comodidades", "Preço", "Fotos", "Anúncio"];
const COLUNAS_DO_DONO = "proprietarios(id, nome, telefone, email, observacoes)";

// Áreas que o imóvel precisa ter para sair do rascunho (a mesma regra do banco).
function areaQueFalta(campos, tipo) {
  if (tipo?.tipo === "TERRENO") return valorDigitado(campos.area_terreno) ? null : "Área do terreno";
  return valorDigitado(campos.area_construida) && valorDigitado(campos.area_util) ? null : "Área construída e área útil";
}
const ESPERA_PARA_SALVAR_MS = 1200;
// O rascunho automático grava mais rápido: é o que salva quem sai da tela sem querer.
const ESPERA_PARA_RASCUNHO_MS = 600;
const MAX_FOTOS = 40;

const CAMPOS_VAZIOS = {
  tipoId: "", cep: "", endereco: "", numero: "", complemento: "", bairro: "", cidade: "Campo Grande", uf: "MS",
  area_construida: "", area_util: "", area_terreno: "", medida_frente: "", medida_fundo: "",
  dormitorios: 0, suites: 0, banheiros: 0, vagas: 0,
  mobilia: "", ocupacao: "", aceita_pet: false, aceita_financiamento: false, comodidades: [],
  venda: false, valor_venda: "", locacao: false, valor_locacao: "", valor_condominio: "", valor_iptu: "", taxa_administracao: "",
  fotos: [], titulo: "", descricao: "", situacao: "rascunho", captador_id: "",
};

const paraCampo = (valor) => (valor === null || valor === undefined ? "" : String(Number(valor)).replace(".", ","));

function camposDoImovel(i, equipe) {
  const porPrefixo = TIPOS_DE_CADASTRO.find((t) => t.prefixo === i.referencia?.slice(0, 2));
  const tipo = porPrefixo ?? TIPOS_DE_CADASTRO.find((t) => t.tipo === i.tipo);
  return {
    ...CAMPOS_VAZIOS,
    tipoId: tipo?.id ?? "",
    cep: cepFormatado(i.cep), endereco: i.endereco ?? "", numero: i.numero ?? "", complemento: i.complemento ?? "", bairro: i.bairro ?? "", cidade: i.cidade ?? "", uf: i.uf ?? "",
    area_construida: paraCampo(i.area_construida), area_util: paraCampo(i.area_util), area_terreno: paraCampo(i.area_terreno),
    medida_frente: paraCampo(i.medida_frente), medida_fundo: paraCampo(i.medida_fundo),
    dormitorios: i.dormitorios ?? 0, suites: i.suites ?? 0, banheiros: i.banheiros ?? 0, vagas: i.vagas ?? 0,
    mobilia: i.mobilia ?? "", ocupacao: i.ocupacao ?? "", aceita_pet: !!i.aceita_pet, aceita_financiamento: i.aceita_financiamento === 1,
    comodidades: Object.entries(i.caracteristicas ?? {}).filter(([, v]) => v === "1").map(([k]) => k),
    venda: !!i.venda, valor_venda: paraCampo(i.valor_venda), locacao: !!i.locacao, valor_locacao: paraCampo(i.valor_locacao),
    valor_condominio: paraCampo(i.valor_condominio), valor_iptu: paraCampo(i.valor_iptu), taxa_administracao: paraCampo(i.taxa_administracao),
    fotos: i.fotos ?? [], titulo: i.titulo ?? "", descricao: i.descricao ?? "", situacao: i.situacao,
    captador_id: equipe.find((c) => semAcento(nomeDeCaptador(c)) === semAcento(i.captador))?.id ?? "",
  };
}

function dadosParaSalvar(c) {
  const tipo = TIPOS_DE_CADASTRO.find((t) => t.id === c.tipoId);
  return {
    tipo: tipo?.tipo, prefixo: tipo?.prefixo, finalidade: tipo?.finalidade, situacao: c.situacao,
    cep: c.cep.replace(/\D/g, ""), endereco: c.endereco, numero: c.numero, complemento: c.complemento, bairro: c.bairro, cidade: c.cidade, uf: c.uf,
    area_construida: valorDigitado(c.area_construida), area_util: valorDigitado(c.area_util), area_terreno: valorDigitado(c.area_terreno),
    medida_frente: valorDigitado(c.medida_frente), medida_fundo: valorDigitado(c.medida_fundo),
    dormitorios: c.dormitorios, suites: c.suites, banheiros: c.banheiros, vagas: c.vagas,
    mobilia: c.mobilia, ocupacao: c.ocupacao, aceita_pet: c.aceita_pet, aceita_financiamento: c.aceita_financiamento,
    caracteristicas: Object.fromEntries(c.comodidades.map((chave) => [chave, "1"])),
    venda: c.venda, valor_venda: valorDigitado(c.valor_venda), locacao: c.locacao, valor_locacao: valorDigitado(c.valor_locacao),
    valor_condominio: valorDigitado(c.valor_condominio), valor_iptu: valorDigitado(c.valor_iptu), taxa_administracao: valorDigitado(c.taxa_administracao),
    fotos: c.fotos, foto_mini: c.fotos[0] ? miniDaFoto(c.fotos[0]) : null,
    titulo: c.titulo, descricao: c.descricao, captador_id: c.captador_id,
  };
}

function Contador({ rotulo, dica, valor, aoMudar }) {
  return (
    <div className="contador-campo">
      <span className="contador-rotulo">{rotulo}{dica && <small className="mudo">{dica}</small>}</span>
      <div className="contador">
        <button type="button" aria-label={`Diminuir ${rotulo}`} disabled={valor <= 0} onClick={() => aoMudar(valor - 1)}>−</button>
        <output>{valor}</output>
        <button type="button" aria-label={`Aumentar ${rotulo}`} onClick={() => aoMudar(valor + 1)}>+</button>
      </div>
    </div>
  );
}

function CampoComUnidade({ id, rotulo, unidade, valor, aoMudar, ...resto }) {
  return (
    <label className="campo">{rotulo}
      <span className="com-unidade">
        <input id={id} inputMode="decimal" value={valor} onChange={(e) => aoMudar(e.target.value)} {...resto} />
        <span>{unidade}</span>
      </span>
    </label>
  );
}

function EtapaLocalizacao({ campos, mudar, definir, juntar }) {
  const [buscandoCep, setBuscandoCep] = useState(false);
  const [avisoCep, setAvisoCep] = useState(null);

  async function buscarCep(texto) {
    const cep = texto.replace(/\D/g, "");
    definir("cep")(cepFormatado(cep));
    setAvisoCep(null);
    if (cep.length !== 8) return;
    setBuscandoCep(true);
    try {
      const resposta = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
      const achado = await resposta.json();
      if (achado.erro) throw new Error();
      juntar({ endereco: achado.logradouro || campos.endereco, bairro: achado.bairro || campos.bairro, cidade: achado.localidade, uf: achado.uf });
    } catch {
      setAvisoCep("Não achei esse CEP. Preencha o endereço abaixo.");
    } finally {
      setBuscandoCep(false);
    }
  }

  return (
    <>
      <label className="campo">Tipo de imóvel
        <select id="cad-tipo" required value={campos.tipoId} onChange={mudar("tipoId")}>
          <option value="">Selecionar</option>
          {TIPOS_DE_CADASTRO.map((t) => <option key={t.id} value={t.id}>{t.nome}</option>)}
        </select>
      </label>
      <h3>Localização</h3>
      <label className="campo campo-curto">CEP
        <input id="cad-cep" inputMode="numeric" placeholder="79000-000" value={campos.cep} onChange={(e) => buscarCep(e.target.value)} />
        {buscandoCep && <small className="mudo">Procurando o endereço…</small>}
        {avisoCep && <small className="texto-alerta">{avisoCep}</small>}
      </label>
      <div className="grade-endereco">
        <label className="campo">Rua<input id="cad-rua" value={campos.endereco} onChange={mudar("endereco")} /></label>
        <label className="campo">Número<input id="cad-numero" value={campos.numero} onChange={mudar("numero")} /></label>
      </div>
      <label className="campo">Complemento<input id="cad-complemento" placeholder="Bloco, apartamento, casa..." value={campos.complemento} onChange={mudar("complemento")} /></label>
      <div className="grade-endereco tres">
        <label className="campo">Bairro<input id="cad-bairro" required value={campos.bairro} onChange={mudar("bairro")} /></label>
        <label className="campo">Cidade<input id="cad-cidade" required value={campos.cidade} onChange={mudar("cidade")} /></label>
        <label className="campo">Estado<input id="cad-uf" required maxLength={2} value={campos.uf} onChange={(e) => definir("uf")(e.target.value.toUpperCase())} /></label>
      </div>
      <p className="mudo pequeno" style={{ margin: 0 }}>Rua e número ficam para a equipe. O site mostra só o bairro, e a Thais informa a rua sem o número.</p>
    </>
  );
}

const DONO_VAZIO = { id: null, nome: "", telefone: "", email: "", observacoes: "" };

function EtapaProprietario({ codigo, donos, aoMudar }) {
  const [form, setForm] = useState(donos.length ? null : DONO_VAZIO);
  const [existente, setExistente] = useState(null);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState(null);
  const mudar = (campo) => (e) => setForm((atual) => ({ ...atual, [campo]: e.target.value }));

  // Telefone já cadastrado: o mesmo proprietário só ganha o vínculo com este imóvel.
  async function mudarTelefone(e) {
    const valor = e.target.value;
    setForm((atual) => ({ ...atual, telefone: valor }));
    setExistente(null);
    const digitos = valor.replace(/\D/g, "");
    if (form.id || digitos.length < 10) return;
    const achados = await supabase.rpc("proprietario_pelo_telefone", { p_telefone: digitos });
    if (achados.data?.[0]) setExistente(achados.data[0]);
  }

  async function salvar() {
    setOcupado(true);
    setErro(null);
    try {
      exigir(await supabase.rpc("salvar_proprietario", {
        p_codigo: codigo, p_id: form.id, p_nome: existente ? existente.nome : form.nome, p_telefone: form.telefone,
        p_email: form.email.trim() || null, p_observacoes: form.observacoes.trim() || null,
      }));
      await aoMudar();
      setForm(null);
      setExistente(null);
    } catch (e) {
      setErro(mensagemDeErro(e));
    } finally {
      setOcupado(false);
    }
  }

  async function remover(dono) {
    if (!window.confirm(`Tirar ${dono.nome} deste imóvel? O cadastro dele continua guardado.`)) return;
    setErro(null);
    try {
      exigir(await supabase.rpc("desvincular_proprietario", { p_codigo: codigo, p_proprietario_id: dono.id }));
      await aoMudar();
    } catch (e) {
      setErro(mensagemDeErro(e));
    }
  }

  return (
    <>
      <h3>Proprietário</h3>
      <p className="mudo pequeno" style={{ margin: 0 }}>Obrigatório: o imóvel só é publicado com o proprietário. Só o gestor e o captador veem estes dados; a Thais e o site não recebem.</p>
      {donos.map((dono) => (
        <div key={dono.id} className="dono-cadastro">
          <div>
            <b>{dono.nome}</b>
            <span className="mudo pequeno">{[telefone(dono.telefone), dono.email].filter(Boolean).join(" · ")}</span>
          </div>
          <div className="atalhos">
            <button type="button" className="botao secundario pequeno" onClick={() => { setExistente(null); setForm({ ...DONO_VAZIO, ...dono, email: dono.email ?? "", observacoes: dono.observacoes ?? "", telefone: telefone(dono.telefone) }); }}>Editar</button>
            <button type="button" className="botao secundario pequeno" onClick={() => remover(dono)}>Tirar</button>
          </div>
        </div>
      ))}
      {form ? (
        <div className="bloco-preco">
          <div className="grade-endereco">
            <label className="campo">Nome completo *
              <input id="dono-nome" autoComplete="off" value={existente ? existente.nome : form.nome} disabled={!!existente} onChange={mudar("nome")} />
            </label>
            <label className="campo">Telefone ou WhatsApp *
              <input id="dono-telefone" inputMode="tel" autoComplete="off" placeholder="(67) 99999-9999" value={form.telefone} onChange={mudarTelefone} />
            </label>
          </div>
          {existente && <p className="aviso-ok pequeno" style={{ margin: 0 }}>Este telefone já é de {existente.nome}. Ao salvar, ele fica ligado também a este imóvel.</p>}
          <div className="grade-endereco">
            <label className="campo">E-mail<input id="dono-email" type="email" autoComplete="off" value={form.email} disabled={!!existente} onChange={mudar("email")} /></label>
            <label className="campo">Observações<input id="dono-observacoes" autoComplete="off" placeholder="Ex.: falar à tarde, procurador..." value={form.observacoes} disabled={!!existente} onChange={mudar("observacoes")} /></label>
          </div>
          <Erro mensagem={erro} />
          <div className="atalhos">
            {donos.length > 0 && <button type="button" className="botao secundario" disabled={ocupado} onClick={() => { setForm(null); setExistente(null); setErro(null); }}>Cancelar</button>}
            <button type="button" className="botao" disabled={ocupado} onClick={salvar}>{ocupado ? "Salvando…" : form.id ? "Salvar proprietário" : "Adicionar proprietário"}</button>
          </div>
        </div>
      ) : (
        <>
          <Erro mensagem={erro} />
          <button type="button" className="botao secundario" style={{ alignSelf: "flex-start" }} onClick={() => setForm(DONO_VAZIO)}>Adicionar outro proprietário</button>
        </>
      )}
    </>
  );
}

function EtapaCaracteristicas({ campos, definir, tipo }) {
  const terreno = tipo?.tipo === "TERRENO";
  return (
    <>
      <h3>Áreas e medidas</h3>
      <p className="mudo pequeno" style={{ margin: 0 }}>{terreno ? "Obrigatória: área do terreno." : "Obrigatórias: área construída e área útil."}</p>
      <div className="grade-medidas">
        <CampoComUnidade id="cad-construida" rotulo={terreno ? "Área construída" : "Área construída *"} unidade="m²" valor={campos.area_construida} aoMudar={definir("area_construida")} />
        <CampoComUnidade id="cad-util" rotulo={terreno ? "Área útil" : "Área útil *"} unidade="m²" valor={campos.area_util} aoMudar={definir("area_util")} />
        <CampoComUnidade id="cad-terreno" rotulo={terreno ? "Terreno *" : "Terreno"} unidade="m²" valor={campos.area_terreno} aoMudar={definir("area_terreno")} />
        <CampoComUnidade id="cad-frente" rotulo="Medida de frente" unidade="m" valor={campos.medida_frente} aoMudar={definir("medida_frente")} />
        <CampoComUnidade id="cad-fundo" rotulo="Medida de fundo" unidade="m" valor={campos.medida_fundo} aoMudar={definir("medida_fundo")} />
      </div>
      <h3>Cômodos</h3>
      <div className="grade-contadores">
        <Contador rotulo="Quartos" dica="Incluindo suítes" valor={campos.dormitorios} aoMudar={definir("dormitorios")} />
        <Contador rotulo="Suítes" valor={campos.suites} aoMudar={definir("suites")} />
        <Contador rotulo="Banheiros" dica="Sem lavabo nem serviço" valor={campos.banheiros} aoMudar={definir("banheiros")} />
        <Contador rotulo="Vagas de garagem" valor={campos.vagas} aoMudar={definir("vagas")} />
      </div>
      <h3>Ocupação</h3>
      <div className="opcoes-radio" role="radiogroup" aria-label="Situação de ocupação">
        {Object.entries(NOME_DA_OCUPACAO).map(([id, nome]) => (
          <label key={id} className={campos.ocupacao === id ? "marcado" : ""}>
            <input type="radio" name="ocupacao" checked={campos.ocupacao === id} onChange={() => definir("ocupacao")(id)} />{nome}
          </label>
        ))}
      </div>
      <p className="mudo pequeno" style={{ margin: 0 }}>A ocupação é dado interno: não aparece no site e a Thais não recebe.</p>
    </>
  );
}

function EtapaComodidades({ campos, definir }) {
  const alternar = (chave) => definir("comodidades")(campos.comodidades.includes(chave) ? campos.comodidades.filter((c) => c !== chave) : [...campos.comodidades, chave]);
  const grupo = (lista) => (
    <div className="grade-marcar">
      {lista.map(([chave, nome]) => (
        <label key={chave}><input type="checkbox" checked={campos.comodidades.includes(chave)} onChange={() => alternar(chave)} />{nome}</label>
      ))}
    </div>
  );
  return (
    <>
      <h3>O imóvel está mobiliado?</h3>
      <div className="opcoes-radio" role="radiogroup" aria-label="Mobília">
        {Object.entries(NOME_DA_MOBILIA).map(([id, nome]) => (
          <label key={id} className={campos.mobilia === id ? "marcado" : ""}>
            <input type="radio" name="mobilia" checked={campos.mobilia === id} onChange={() => definir("mobilia")(id)} />{nome}
          </label>
        ))}
      </div>
      <h3>Comodidades do imóvel</h3>
      {grupo(COMODIDADES_DO_IMOVEL)}
      <h3>Segurança e condomínio</h3>
      {grupo(COMODIDADES_DO_LOCAL)}
      <h3>Condições</h3>
      <div className="grade-marcar">
        <label><input type="checkbox" checked={campos.aceita_pet} onChange={(e) => definir("aceita_pet")(e.target.checked)} />Aceita pet</label>
        <label><input type="checkbox" checked={campos.aceita_financiamento} onChange={(e) => definir("aceita_financiamento")(e.target.checked)} />Aceita financiamento</label>
      </div>
    </>
  );
}

function EtapaPreco({ campos, definir }) {
  const aluguel = valorDigitado(campos.valor_locacao);
  const taxa = valorDigitado(campos.taxa_administracao);
  const desconto = aluguel && taxa ? aluguel * (taxa / 100) : null;
  return (
    <>
      <div className="bloco-preco">
        <div className="linha-interruptor"><Interruptor ligado={campos.venda} aoMudar={definir("venda")} rotulo="Imóvel à venda" /><b>Venda</b></div>
        {campos.venda && <CampoComUnidade id="cad-venda" rotulo="Valor de venda" unidade="R$" placeholder="350.000" valor={campos.valor_venda} aoMudar={definir("valor_venda")} />}
      </div>
      <div className="bloco-preco">
        <div className="linha-interruptor"><Interruptor ligado={campos.locacao} aoMudar={definir("locacao")} rotulo="Imóvel para alugar" /><b>Aluguel</b></div>
        {campos.locacao && (
          <>
            <div className="grade-medidas">
              <CampoComUnidade id="cad-aluguel" rotulo="Valor do aluguel por mês" unidade="R$" placeholder="2.500" valor={campos.valor_locacao} aoMudar={definir("valor_locacao")} />
              <CampoComUnidade id="cad-taxa" rotulo="Taxa de administração (interna)" unidade="%" valor={campos.taxa_administracao} aoMudar={definir("taxa_administracao")} />
            </div>
            {desconto !== null && (
              <dl className="pares resumo-aluguel">
                <dt>Aluguel</dt><dd>{reais(aluguel)}</dd>
                <dt>Taxa de administração ({taxa}%)</dt><dd>− {reais(desconto)}</dd>
                <dt><b>Proprietário recebe</b></dt><dd><b>{reais(aluguel - desconto)}</b></dd>
              </dl>
            )}
          </>
        )}
      </div>
      <h3>Despesas</h3>
      <div className="grade-medidas">
        <CampoComUnidade id="cad-condominio" rotulo="Condomínio por mês" unidade="R$" valor={campos.valor_condominio} aoMudar={definir("valor_condominio")} />
        <CampoComUnidade id="cad-iptu" rotulo="IPTU" unidade="R$" valor={campos.valor_iptu} aoMudar={definir("valor_iptu")} />
      </div>
    </>
  );
}

function EtapaFotos({ codigo, fotos, aoMudar }) {
  const [progresso, setProgresso] = useState(null);
  const [erro, setErro] = useState(null);
  const [arrastada, setArrastada] = useState(null);
  const atuais = useRef(fotos);
  atuais.current = fotos;

  async function enviar(evento) {
    const arquivos = [...evento.target.files];
    evento.target.value = "";
    if (!arquivos.length) return;
    setErro(null);
    const espaco = MAX_FOTOS - atuais.current.length;
    if (arquivos.length > espaco) setErro(`O limite é de ${MAX_FOTOS} fotos por imóvel; enviei só as ${Math.max(espaco, 0)} primeiras.`);
    const lista = arquivos.slice(0, Math.max(espaco, 0));
    for (const [n, arquivo] of lista.entries()) {
      setProgresso(`Enviando ${n + 1} de ${lista.length}…`);
      try {
        const [grande, mini] = await Promise.all([reduzirFoto(arquivo, 1600, 0.82), reduzirFoto(arquivo, 640, 0.75)]);
        const nome = `${codigo}/${crypto.randomUUID()}`;
        exigir(await supabase.storage.from("imoveis").upload(`${nome}.jpg`, grande, { contentType: "image/jpeg" }));
        exigir(await supabase.storage.from("imoveis").upload(`${nome}-mini.jpg`, mini, { contentType: "image/jpeg" }));
        aoMudar([...atuais.current, supabase.storage.from("imoveis").getPublicUrl(`${nome}.jpg`).data.publicUrl]);
      } catch (e) {
        setErro(`Não consegui enviar ${arquivo.name}: ${mensagemDeErro(e)}`);
      }
    }
    setProgresso(null);
  }

  function mover(de, para) {
    if (para < 0 || para >= fotos.length || de === para) return;
    const nova = [...fotos];
    const [foto] = nova.splice(de, 1);
    nova.splice(para, 0, foto);
    aoMudar(nova);
  }

  async function remover(url) {
    aoMudar(fotos.filter((f) => f !== url));
    const caminho = url.split("/object/public/imoveis/")[1];
    if (caminho) await supabase.storage.from("imoveis").remove([caminho, caminho.replace(/\.jpg$/, "-mini.jpg")]);
  }

  return (
    <>
      <h3>Fotos <span className="etiqueta pendente">{fotos.length}</span></h3>
      <p className="mudo pequeno" style={{ margin: 0 }}>Arraste para ordenar. A primeira é a capa. O Grupo OLX exige pelo menos 5 fotos.</p>
      <Erro mensagem={erro} />
      <div className="fotos-cadastro">
        {fotos.map((foto, n) => (
          <figure
            key={foto}
            draggable
            className={arrastada === n ? "arrastando" : ""}
            onDragStart={() => setArrastada(n)}
            onDragEnd={() => setArrastada(null)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); mover(arrastada, n); setArrastada(null); }}
          >
            <img src={miniDaFoto(foto)} alt={`Foto ${n + 1}`} loading="lazy" />
            {n === 0 && <figcaption>Capa</figcaption>}
            <div className="acoes-foto">
              {n > 0 && <button type="button" onClick={() => mover(n, 0)}>Tornar capa</button>}
              <button type="button" aria-label={`Mover foto ${n + 1} para antes`} disabled={n === 0} onClick={() => mover(n, n - 1)}>← Antes</button>
              <button type="button" aria-label={`Mover foto ${n + 1} para depois`} disabled={n === fotos.length - 1} onClick={() => mover(n, n + 1)}>Depois →</button>
              <button type="button" aria-label={`Remover foto ${n + 1}`} onClick={() => remover(foto)}>✕ Remover</button>
            </div>
          </figure>
        ))}
        <label className="adicionar-foto">
          <span aria-hidden="true">+</span>
          {progresso ?? "Adicionar fotos"}
          <input type="file" className="invisivel" accept="image/jpeg,image/png,image/webp" multiple disabled={!!progresso} onChange={enviar} />
        </label>
      </div>
    </>
  );
}

function EtapaAnuncio({ campos, mudar, definir, equipe, souGestor, avaliacao, publicado, faltaParaPublicar }) {
  return (
    <>
      <label className="campo">Título do anúncio
        <input id="cad-titulo" maxLength={100} placeholder="Ex.: Casa com quintal perto do Shopping Norte Sul" value={campos.titulo} onChange={mudar("titulo")} />
        <small className="mudo">{campos.titulo.trim().length} de 100. Mínimo de 10.</small>
      </label>
      <label className="campo">Descrição
        <textarea id="cad-descricao" rows={8} maxLength={3000} value={campos.descricao} onChange={mudar("descricao")} />
        <small className="mudo">{campos.descricao.trim().length} de 3.000. Mínimo de 50.</small>
      </label>
      {souGestor && (
        <label className="campo">Captador
          <select id="cad-captador" value={campos.captador_id} onChange={mudar("captador_id")}>
            <option value="">Manter o atual</option>
            {equipe.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
          </select>
          <small className="mudo">O lead que perguntar por este imóvel vai primeiro para o captador.</small>
        </label>
      )}
      {publicado && (
        <label className="campo campo-curto">Situação
          <select id="cad-situacao" value={campos.situacao} onChange={(e) => definir("situacao")(e.target.value)}>
            {SITUACOES.map(([id, nome]) => <option key={id} value={id}>{nome}</option>)}
          </select>
          <small className="mudo">Só o que está Disponível vai para a Thais e para o site.</small>
        </label>
      )}
      {faltaParaPublicar.length > 0 && (
        <div className="painel-qualidade alerta">
          <b>Para publicar, falta:</b>
          <ul className="lista-simples">{faltaParaPublicar.map((p) => <li key={p}>{p}</li>)}</ul>
        </div>
      )}
      <div className="painel-qualidade">
        <b>Qualidade do anúncio: {avaliacao.rotulo}</b>
        {avaliacao.pendencias.length > 0 ? <ul className="lista-simples">{avaliacao.pendencias.map((p) => <li key={p}>{p}</li>)}</ul> : <p className="pequeno mudo" style={{ margin: "4px 0 0" }}>Tudo certo para publicar nos portais.</p>}
      </div>
    </>
  );
}

const pacoteDoRascunho = (campos, etapa, codigo) => JSON.stringify({ campos, etapa, codigo: codigo ?? null });

// Cópia no aparelho, gravada a cada letra: cobre quem fecha a página antes de o banco
// receber a última mudança. Ao voltar, ela completa o rascunho do banco e é enviada.
const chaveDaCopia = (id) => `lfg-rascunho-imovel-${id}`;
function lerCopia(id) {
  try {
    return JSON.parse(localStorage.getItem(chaveDaCopia(id)) ?? "null");
  } catch {
    return null;
  }
}
function gravarCopia(id, pacote) {
  try {
    localStorage.setItem(chaveDaCopia(id), JSON.stringify({ ...pacote, codigo: pacote.codigo ?? null, em: Date.now() }));
  } catch {
    // sem espaço ou navegação privada: fica só o banco
  }
}
function apagarCopia(id, seIgualA = null) {
  try {
    const copia = lerCopia(id);
    if (seIgualA === null || (copia && pacoteDoRascunho(copia.campos, copia.etapa, copia.codigo) === seIgualA)) localStorage.removeItem(chaveDaCopia(id));
  } catch {
    // nada a fazer
  }
}

export default function CadastroImovel({ codigoInicial = null, voltar, aoApagar, abrir }) {
  const { eu, souGestor } = useSessao();
  // Gestor que cadastra já entra como captador; administrativo escolhe quem captou.
  const captadorInicial = eu.papel === "gestor" ? eu.id : "";
  // Rascunho automático: um por pessoa, no banco (tabela rascunhos_imovel). Vale para o
  // cadastro novo e para quem volta ao imóvel-rascunho que esse rascunho criou.
  const [modoRascunho, setModoRascunho] = useState(false);
  const [temRascunho, setTemRascunho] = useState(false);
  const [estadoRascunho, setEstadoRascunho] = useState(null);
  const rascunhoSalvo = useRef(null);
  const rascunhoPendente = useRef(null);
  const filaDoRascunho = useRef(Promise.resolve());
  const rascunhoEncerrado = useRef(false);
  const [codigo, setCodigo] = useState(codigoInicial);
  const [referencia, setReferencia] = useState(null);
  const [campos, setCampos] = useState(null);
  const [etapa, setEtapa] = useState(0);
  const [situacaoSalva, setSituacaoSalva] = useState("rascunho");
  const [estado, setEstado] = useState(null);
  const [erro, setErro] = useState(null);
  const [ocupado, setOcupado] = useState(false);
  const ultimoSalvo = useRef(null);
  const fila = useRef(Promise.resolve());
  const codigoAtual = useRef(codigoInicial);
  const [donos, setDonos] = useState([]);

  const { dados, erro: erroAoCarregar } = useCarregar(async () => {
    const equipe = exigir(await supabase.from("corretores").select("id, nome, nome_no_univen").eq("ativo", true).order("nome"));
    let imovel = codigoInicial ? exigir(await supabase.from("imoveis").select("*").eq("codigo", codigoInicial).maybeSingle()) : null;
    if (codigoInicial && !imovel) throw new Error("Imóvel não encontrado.");
    if (imovel && imovel.origem !== "proprio") throw new Error("Este imóvel vem do Univen: edite por lá até a troca dos portais.");

    let rascunho = null;
    if (!codigoInicial || imovel.situacao === "rascunho") {
      rascunho = exigir(await supabase.from("rascunhos_imovel").select("codigo, campos, etapa, atualizado_em").eq("corretor_id", eu.id).maybeSingle());
      // Abrindo outro imóvel-rascunho (antigo) pela lista: não é o rascunho automático.
      if (codigoInicial && rascunho?.codigo !== codigoInicial) rascunho = null;
    }
    if (!codigoInicial && rascunho?.codigo) {
      imovel = exigir(await supabase.from("imoveis").select("*").eq("codigo", rascunho.codigo).maybeSingle());
      // O imóvel do rascunho foi publicado ou apagado em outro lugar: começa do zero.
      if (!imovel || imovel.situacao !== "rascunho") {
        exigir(await supabase.from("rascunhos_imovel").delete().eq("corretor_id", eu.id));
        imovel = null;
        rascunho = null;
      }
    }
    const codigo = imovel?.codigo ?? null;
    const vinculos = codigo ? exigir(await supabase.from("imovel_proprietarios").select(COLUNAS_DO_DONO).eq("imovel_codigo", codigo)) : [];
    return { equipe, imovel, rascunho, modoRascunho: !codigoInicial || !!rascunho, donos: vinculos.map((v) => v.proprietarios).filter(Boolean) };
  }, [codigoInicial]);

  useEffect(() => {
    if (!dados || campos) return;
    const vazios = { ...CAMPOS_VAZIOS, captador_id: captadorInicial };
    const doImovel = dados.imovel ? camposDoImovel(dados.imovel, dados.equipe) : vazios;
    const { rascunho, imovel } = dados;
    const copia = dados.modoRascunho ? lerCopia(eu.id) : null;
    const usarCopia = !!copia?.campos && copia.codigo === (imovel?.codigo ?? null) && (!rascunho || copia.em > Date.parse(rascunho.atualizado_em));
    if (copia && !usarCopia) apagarCopia(eu.id);
    const base = usarCopia ? copia : rascunho;
    // O rascunho é o mais novo: guarda até o que ainda não tinha ido para o imóvel.
    const iniciais = base ? { ...vazios, ...base.campos, ...(imovel ? {} : { fotos: [] }) } : doImovel;
    const etapaInicial = base && imovel ? Math.min(Math.max(base.etapa ?? 0, 0), ETAPAS.length - 1) : 0;
    setDonos(dados.donos);
    if (imovel) {
      setReferencia(imovel.referencia);
      setSituacaoSalva(imovel.situacao);
      setCodigo(imovel.codigo);
      codigoAtual.current = imovel.codigo;
    }
    setModoRascunho(dados.modoRascunho);
    setTemRascunho(!!base);
    setEstadoRascunho(base ? "recuperado" : null);
    // Com a cópia do aparelho mais nova, o banco fica "desatualizado" e recebe a cópia em seguida.
    rascunhoSalvo.current = usarCopia
      ? (rascunho ? pacoteDoRascunho(rascunho.campos, rascunho.etapa, rascunho.codigo) : null)
      : pacoteDoRascunho(iniciais, etapaInicial, imovel?.codigo);
    ultimoSalvo.current = JSON.stringify(doImovel);
    setEtapa(etapaInicial);
    setCampos(iniciais);
  }, [dados, campos, souGestor, eu.id, captadorInicial]);

  // Uma gravação do rascunho por vez; a última versão pedida é a que vale.
  function gravarRascunho() {
    const tarefa = filaDoRascunho.current.then(async () => {
      const pacote = rascunhoPendente.current;
      if (!pacote || rascunhoEncerrado.current) return;
      rascunhoPendente.current = null;
      const texto = pacoteDoRascunho(pacote.campos, pacote.etapa, pacote.codigo);
      if (texto === rascunhoSalvo.current) return;
      setEstadoRascunho("salvando");
      try {
        exigir(await supabase.from("rascunhos_imovel").upsert({
          corretor_id: eu.id, codigo: pacote.codigo ?? null, campos: pacote.campos, etapa: pacote.etapa, atualizado_em: new Date().toISOString(),
        }));
        rascunhoSalvo.current = texto;
        apagarCopia(eu.id, texto);
        if (!rascunhoEncerrado.current) {
          setTemRascunho(true);
          setEstadoRascunho("salvo");
        }
      } catch {
        rascunhoPendente.current ??= pacote;
        if (!rascunhoEncerrado.current) setEstadoRascunho("erro");
      }
    });
    filaDoRascunho.current = tarefa.catch(() => {});
    return filaDoRascunho.current;
  }
  const gravarRascunhoAgora = useRef(gravarRascunho);
  gravarRascunhoAgora.current = gravarRascunho;

  // Grava o rascunho logo que a pessoa para de mexer, e na hora se ela sair da tela.
  useEffect(() => {
    if (!modoRascunho || !campos || rascunhoEncerrado.current) return undefined;
    if (pacoteDoRascunho(campos, etapa, codigo) === rascunhoSalvo.current) return undefined;
    rascunhoPendente.current = { campos, etapa, codigo };
    gravarCopia(eu.id, rascunhoPendente.current);
    const espera = setTimeout(() => gravarRascunhoAgora.current(), ESPERA_PARA_RASCUNHO_MS);
    return () => clearTimeout(espera);
  }, [modoRascunho, campos, etapa, codigo]);

  useEffect(() => {
    const aoSair = () => {
      if (rascunhoPendente.current) gravarRascunhoAgora.current();
    };
    window.addEventListener("pagehide", aoSair);
    document.addEventListener("visibilitychange", aoSair);
    return () => {
      window.removeEventListener("pagehide", aoSair);
      document.removeEventListener("visibilitychange", aoSair);
      aoSair();
    };
  }, []);

  async function apagarRascunhoAutomatico() {
    rascunhoEncerrado.current = true;
    rascunhoPendente.current = null;
    await filaDoRascunho.current;
    apagarCopia(eu.id);
    exigir(await supabase.from("rascunhos_imovel").delete().eq("corretor_id", eu.id));
    setTemRascunho(false);
    setEstadoRascunho(null);
  }

  // Uma gravação por vez, sempre na ordem em que foram pedidas.
  function salvar(novos) {
    const tarefa = fila.current.then(async () => {
      setEstado("salvando");
      const salvo = exigir(await supabase.rpc("salvar_imovel", { p_codigo: codigoAtual.current, p_dados: dadosParaSalvar(novos) }));
      if (!codigoAtual.current) {
        codigoAtual.current = salvo.codigo;
        setCodigo(salvo.codigo);
        // No rascunho automático o endereço fica #imoveis/novo: ao recarregar, ele volta.
        if (!modoRascunho) history.replaceState(null, "", `#imoveis/${salvo.codigo}/editar`);
      }
      setReferencia(salvo.referencia);
      setSituacaoSalva(salvo.situacao);
      ultimoSalvo.current = JSON.stringify(novos);
      setEstado("salvo");
      setErro(null);
      return salvo;
    });
    fila.current = tarefa.catch(() => {});
    return tarefa.catch((e) => {
      setEstado("erro");
      setErro(mensagemDeErro(e));
      throw e;
    });
  }

  // Depois de criado, grava sozinho logo que a pessoa para de mexer.
  useEffect(() => {
    if (!campos || !codigo || JSON.stringify(campos) === ultimoSalvo.current) return undefined;
    const espera = setTimeout(() => salvar(campos).catch(() => {}), ESPERA_PARA_SALVAR_MS);
    return () => clearTimeout(espera);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campos, codigo]);

  if (erroAoCarregar) return <section className="vista"><button type="button" className="voltar" onClick={voltar}>← Voltar</button><Erro mensagem={erroAoCarregar} /></section>;
  if (!campos) return <Carregando />;

  const mudar = (campo) => (e) => setCampos((c) => ({ ...c, [campo]: e.target.value }));
  const definir = (campo) => (valor) => setCampos((c) => ({ ...c, [campo]: valor }));
  const juntar = (novos) => setCampos((c) => ({ ...c, ...novos }));

  const tipo = TIPOS_DE_CADASTRO.find((t) => t.id === campos.tipoId);
  const dadosAtuais = dadosParaSalvar(campos);
  const avaliacao = avaliarImovel({ ...dadosAtuais, origem: "proprio", area_construida: dadosAtuais.area_construida, cep: dadosAtuais.cep });
  const publicado = situacaoSalva !== "rascunho";
  const faltaNoInicio = !campos.tipoId ? "Escolha o tipo do imóvel." : !campos.bairro.trim() || !campos.cidade.trim() || !campos.uf.trim() ? "Preencha bairro, cidade e estado." : null;
  const faltaArea = areaQueFalta(campos, tipo);
  // O que cada etapa obrigatória precisa antes de seguir.
  const faltaNaEtapa = [
    faltaNoInicio,
    donos.length ? null : "Cadastre o proprietário (nome completo e telefone) para continuar.",
    faltaArea ? `Informe: ${faltaArea.toLowerCase()}.` : null,
  ];
  const faltaParaPublicar = [
    faltaNoInicio && "Tipo, bairro, cidade e estado",
    !donos.length && "Proprietário (nome completo e telefone)",
    faltaArea,
    !(dadosAtuais.venda && dadosAtuais.valor_venda) && !(dadosAtuais.locacao && dadosAtuais.valor_locacao) && "Valor de venda ou de aluguel",
    !campos.fotos.length && "Pelo menos 1 foto",
  ].filter(Boolean);

  async function recarregarDonos() {
    const vinculos = exigir(await supabase.from("imovel_proprietarios").select(COLUNAS_DO_DONO).eq("imovel_codigo", codigoAtual.current));
    setDonos(vinculos.map((v) => v.proprietarios).filter(Boolean));
  }

  async function irParaEtapa(destino) {
    const falta = faltaNaEtapa.slice(0, destino).find(Boolean);
    if (falta) {
      if (codigoAtual.current) setEtapa(faltaNaEtapa.findIndex(Boolean));
      return setErro(falta);
    }
    setOcupado(true);
    try {
      if (JSON.stringify(campos) !== ultimoSalvo.current || !codigoAtual.current) await salvar(campos);
      setEtapa(destino);
      window.scrollTo({ top: 0 });
    } catch {
      // o erro já aparece perto dos botões
    } finally {
      setOcupado(false);
    }
  }

  async function concluir(situacao) {
    const novos = { ...campos, situacao };
    setOcupado(true);
    try {
      const salvo = await salvar(novos);
      // Publicado: virou imóvel de verdade e o rascunho some. "Salvar rascunho" guarda para depois.
      if (modoRascunho && salvo.situacao !== "rascunho") await apagarRascunhoAutomatico();
      else if (modoRascunho) await gravarRascunho();
      setCampos(novos);
      abrir(salvo.codigo);
    } catch {
      setOcupado(false);
    }
  }

  async function sair() {
    setOcupado(true);
    try {
      if (codigoAtual.current && JSON.stringify(campos) !== ultimoSalvo.current) await salvar(campos);
      if (codigoAtual.current) abrir(codigoAtual.current);
      else voltar();
    } catch {
      setOcupado(false);
    }
  }

  async function descartarRascunho() {
    if (!window.confirm("Descartar este rascunho e começar do zero? O que foi preenchido e as fotos enviadas serão apagados.")) return;
    setOcupado(true);
    setErro(null);
    try {
      await apagarRascunhoAutomatico();
      await fila.current;
      if (codigoAtual.current) {
        const nomes = campos.fotos.flatMap((url) => {
          const caminho = url.split("/object/public/imoveis/")[1];
          return caminho ? [caminho, caminho.replace(/\.jpg$/, "-mini.jpg")] : [];
        });
        exigir(await supabase.rpc("apagar_rascunho", { p_codigo: codigoAtual.current }));
        if (nomes.length) await supabase.storage.from("imoveis").remove(nomes);
      }
      const vazios = { ...CAMPOS_VAZIOS, captador_id: captadorInicial };
      codigoAtual.current = null;
      setCodigo(null);
      setReferencia(null);
      setSituacaoSalva("rascunho");
      setDonos([]);
      setEstado(null);
      setEtapa(0);
      ultimoSalvo.current = JSON.stringify(vazios);
      rascunhoSalvo.current = pacoteDoRascunho(vazios, 0, null);
      rascunhoEncerrado.current = false;
      setCampos(vazios);
      window.scrollTo({ top: 0 });
    } catch (e) {
      setErro(mensagemDeErro(e));
    } finally {
      setOcupado(false);
    }
  }

  async function apagar() {
    if (!window.confirm("Apagar este rascunho e as fotos dele?")) return;
    setOcupado(true);
    try {
      const nomes = campos.fotos.flatMap((url) => {
        const caminho = url.split("/object/public/imoveis/")[1];
        return caminho ? [caminho, caminho.replace(/\.jpg$/, "-mini.jpg")] : [];
      });
      exigir(await supabase.rpc("apagar_rascunho", { p_codigo: codigoAtual.current }));
      if (nomes.length) await supabase.storage.from("imoveis").remove(nomes);
      aoApagar();
    } catch (e) {
      setErro(mensagemDeErro(e));
      setOcupado(false);
    }
  }

  return (
    <section className="vista" aria-labelledby="t-cadastro">
      <div className="painel cadastro">
        <div className="cadastro-topo">
          <div className="cadastro-titulo">
            <h2 id="t-cadastro">{codigoInicial && !modoRascunho ? "Editar imóvel" : "Cadastro do imóvel"}</h2>
            {modoRascunho && temRascunho && (
              <p className="aviso-rascunho" role="status">
                <span className={`ponto-rascunho ${estadoRascunho ?? ""}`} aria-hidden="true" />
                {estadoRascunho === "salvando" ? "Salvando rascunho…"
                  : estadoRascunho === "erro" ? "Sem conexão: o rascunho será salvo quando voltar"
                  : estadoRascunho === "recuperado" ? "Rascunho recuperado de onde você parou"
                  : "Rascunho salvo"}
                <button type="button" className="link-botao pequeno" disabled={ocupado} onClick={descartarRascunho}>Descartar rascunho</button>
              </p>
            )}
          </div>
          <BotaoFechar className="fechar-cadastro" aoFechar={sair} desativado={ocupado} rotulo="Fechar o cadastro (o que foi preenchido fica salvo)" />
          <ol className="etapas-cadastro">
            {ETAPAS.map((nome, n) => (
              <li key={nome} className={n < etapa ? "feita" : n === etapa ? "atual" : ""}>
                <button type="button" aria-current={n === etapa ? "step" : undefined} disabled={ocupado || (!codigo && n > 0)} onClick={() => irParaEtapa(n)}>
                  <i aria-hidden="true">{n < etapa ? "✓" : n + 1}</i><span>{nome}</span>
                </button>
              </li>
            ))}
          </ol>
        </div>

        {referencia && (
          <div className="resumo-cadastro">
            {campos.fotos[0] ? <img src={miniDaFoto(campos.fotos[0])} alt="" /> : <span className="foto-tabela" />}
            <div>
              <span className="rotulo">{referencia} · {SITUACOES.find(([id]) => id === situacaoSalva)?.[1]}</span>
              <b>{[campos.endereco, campos.numero].filter(Boolean).join(", ") || campos.bairro}</b>
              <span className="mudo pequeno">{tipo?.nome ?? nomeTipo(dados.imovel?.tipo)} em {campos.bairro}</span>
            </div>
          </div>
        )}

        <div className="formulario corpo-cadastro">
          {etapa === 0 && <EtapaLocalizacao campos={campos} mudar={mudar} definir={definir} juntar={juntar} />}
          {etapa === 1 && <EtapaProprietario codigo={codigo} donos={donos} aoMudar={recarregarDonos} />}
          {etapa === 2 && <EtapaCaracteristicas campos={campos} definir={definir} tipo={tipo} />}
          {etapa === 3 && <EtapaComodidades campos={campos} definir={definir} />}
          {etapa === 4 && <EtapaPreco campos={campos} definir={definir} />}
          {etapa === 5 && <EtapaFotos codigo={codigo} fotos={campos.fotos} aoMudar={definir("fotos")} />}
          {etapa === 6 && <EtapaAnuncio campos={campos} mudar={mudar} definir={definir} equipe={dados.equipe} souGestor={souGestor} avaliacao={avaliacao} publicado={publicado} faltaParaPublicar={faltaParaPublicar} />}
        </div>

        <Erro mensagem={erro} />
        <div className="rodape-cadastro">
          <div className="atalhos">
            <button type="button" className="botao secundario" disabled={ocupado} onClick={sair}>Sair do cadastro</button>
            {codigo && !publicado && !modoRascunho && <button type="button" className="link-botao pequeno" disabled={ocupado} onClick={apagar}>Apagar rascunho</button>}
            {estado === "salvando" && <span className="mudo pequeno">Salvando…</span>}
            {estado === "salvo" && <span className="mudo pequeno">Suas alterações foram salvas</span>}
          </div>
          <div className="atalhos">
            {etapa > 0 && <button type="button" className="botao secundario" disabled={ocupado} onClick={() => irParaEtapa(etapa - 1)}>Voltar</button>}
            {etapa < ETAPAS.length - 1 && <button type="button" className="botao" disabled={ocupado} onClick={() => irParaEtapa(etapa + 1)}>Continuar</button>}
            {etapa === ETAPAS.length - 1 && !publicado && (
              <>
                <button type="button" className="botao secundario" disabled={ocupado} onClick={() => concluir("rascunho")}>Salvar rascunho</button>
                <button type="button" className="botao" disabled={ocupado || faltaParaPublicar.length > 0} onClick={() => concluir("disponivel")}>Publicar</button>
              </>
            )}
            {etapa === ETAPAS.length - 1 && publicado && <button type="button" className="botao" disabled={ocupado} onClick={() => concluir(campos.situacao)}>Concluir</button>}
          </div>
        </div>
      </div>
    </section>
  );
}
