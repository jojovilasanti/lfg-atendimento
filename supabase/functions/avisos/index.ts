// Avisos que o banco manda pelo WhatsApp:
// - ao corretor, quando um lead é oferecido (ao captador do imóvel ou no
//   rodízio; gatilho em atribuicoes): a mensagem-modelo "novo_lead", com os
//   botões Assumir e Não posso agora;
// - ao cliente que espera o corretor (gatilho em mensagens do tipo
//   acompanhamento): o aviso de fila, em texto livre;
// - ao cliente que parou de responder a Thais (tipo followup): texto livre até
//   23 h da última mensagem dele, depois a mensagem-modelo da etapa;
// - ao corretor, como notificação do sistema no painel: a oferta acima e cada
//   mensagem do cliente de um lead dele (gatilho em mensagens do cliente);
// - ao corretor, como notificação, o próximo passo que venceu (tarefas);
// - ao corretor responsável (ou aos gestores), quando alguém clica no WhatsApp
//   de um imóvel no site (registrar_clique_whatsapp);
// - ao corretor que assumiu um lead e não respondeu a tempo: o lead foi
//   redistribuído (interno.processar_prazos_rodizio);
// - ao administrativo e aos gestores, quando uma visita é agendada, remarcada
//   ou cancelada (gatilho em visitas).
//
// POST /functions/v1/avisos
// Cabeçalho: x-avisos-chave (valor no Vault, hash em chaves_acesso)
// Corpo: { "atribuicao_id": "..." }, { "mensagem_id": 123 }, { "notificar_mensagem_id": 123 }, { "tarefa_id": "..." }, { "clique_id": 123 }, { "prazo_perdido_id": "..." } ou { "visita_id": "...", "evento": "agendada" }
import { confereChave, json } from "../_shared/acesso.ts";
import { banco, exigir } from "../_shared/banco.ts";
import { notificar } from "../_shared/notificacoes.ts";
import { botoesDaOferta, MODELO_NOVO_LEAD, variavelDoModelo } from "../_shared/rodizio.ts";
import { JANELA_LIVRE_FOLLOWUP_MS, nomeDoModeloFollowup } from "../_shared/followup.ts";
import { telefoneLegivel } from "../_shared/telefone.ts";
import { MODELO_VISITA_AGENDADA, MODELO_VISITA_CANCELADA, MODELO_VISITA_REMARCADA, quandoDaVisita, TIPO_DE_VISITA } from "../_shared/visitas.ts";
import { enviarModelo, enviarTexto } from "../_shared/whatsapp.ts";

// Texto da notificação quando o cliente manda algo além de texto.
const ROTULO_DA_MIDIA: Record<string, string> = {
  audio: "🎤 Áudio",
  image: "📷 Foto",
  video: "🎬 Vídeo",
  document: "📄 Documento",
  localizacao: "📍 Localização",
};

const resumir = (texto: string, limite: number) => {
  const limpo = texto.replace(/\s+/g, " ").trim();
  return limpo.length > limite ? `${limpo.slice(0, limite - 1)}…` : limpo;
};

type Oferta = {
  id: string;
  lead_id: string;
  corretor_id: string;
  status: string;
  prazo_em: string;
  motivo: "captador" | "rodizio" | "gestor";
  corretores: { nome: string; whatsapp: string | null };
  leads: {
    nome: string | null;
    whatsapp: string;
    resumo: string | null;
    interesse: string | null;
    ficha: Record<string, unknown>;
    imoveis: { referencia: string | null } | null;
  };
};

// Sem resumo da IA, o corretor recebe o que já está na ficha.
function resumoDoLead(lead: Oferta["leads"]): string {
  if (lead.resumo) return lead.resumo;
  const f = lead.ficha ?? {};
  const partes = [
    lead.interesse === "locacao" ? "Quer alugar" : lead.interesse === "compra" ? "Quer comprar" : null,
    f.tipo_imovel,
    f.regiao && `em ${f.regiao}`,
    f.orcamento_max && `até R$ ${Number(f.orcamento_max).toLocaleString("pt-BR")}`,
  ].filter(Boolean);
  return partes.length ? partes.join(" ") : "Ainda sem detalhes; veja a conversa no painel.";
}

async function avisarCorretor(atribuicaoId: string): Promise<Response> {
  const oferta = exigir(
    await banco
      .from("atribuicoes")
      .select("id, lead_id, corretor_id, status, prazo_em, motivo, corretores(nome, whatsapp), leads(nome, whatsapp, resumo, interesse, ficha, imoveis(referencia))")
      .eq("id", atribuicaoId)
      .maybeSingle(),
    "ler oferta",
  ) as Oferta | null;
  if (!oferta || oferta.status !== "pendente") return json({ ok: false, motivo: "oferta inexistente ou já respondida" });

  const marcar = async (mudancas: Record<string, unknown>) =>
    exigir(await banco.from("atribuicoes").update(mudancas).eq("id", oferta.id), "registrar aviso");

  // Conversas do simulador não avisam ninguém.
  if (oferta.leads.whatsapp.startsWith("sim-")) {
    await marcar({ aviso_status: "simulado" });
    return json({ ok: true, simulado: true });
  }

  const minutos = Math.max(1, Math.round((new Date(oferta.prazo_em).getTime() - Date.now()) / 60_000));
  // Fora do horário (22h às 8h) o captador é avisado na hora, mas o prazo só
  // começa na abertura: o aviso diz os minutos do prazo e a partir de quando.
  const prazoConfigurado = Number(((await banco.from("configuracoes").select("valor").eq("chave", "prazo_rodizio_minutos").maybeSingle()).data?.valor) ?? 15) || 15;
  const comecaDepois = minutos > prazoConfigurado + 2;
  const comecaAs = new Date(new Date(oferta.prazo_em).getTime() - prazoConfigurado * 60_000)
    .toLocaleTimeString("pt-BR", { timeZone: "America/Campo_Grande", hour: "2-digit", minute: "2-digit" });
  const textoDosMinutos = comecaDepois ? `${prazoConfigurado} (contando a partir das ${comecaAs})` : String(minutos);
  // A notificação do painel não depende do WhatsApp do corretor.
  await notificar([oferta.corretor_id], {
    titulo: "Novo lead para você",
    texto: resumir(`${oferta.leads.nome ?? "Cliente sem nome"} · ${resumoDoLead(oferta.leads).replace(/\.?\s*$/, ".")} ${comecaDepois ? `Prazo de ${prazoConfigurado} min a partir das ${comecaAs}.` : `Assuma em até ${minutos} min.`}`, 180),
    url: `/#leads/${oferta.lead_id}`,
    tag: `oferta-${oferta.id}`,
  }).catch((erro) => console.warn("Notificação da oferta não saiu", erro));
  if (!oferta.corretores.whatsapp) {
    await marcar({ aviso_status: "sem_whatsapp" });
    return json({ ok: false, motivo: "corretor sem WhatsApp no cadastro" });
  }

  try {
    const whatsappId = await enviarModelo(
      oferta.corretores.whatsapp,
      MODELO_NOVO_LEAD.name,
      [
        variavelDoModelo(oferta.corretores.nome.split(" ")[0], 40),
        oferta.motivo === "captador"
          ? `do seu imóvel ${oferta.leads.imoveis?.referencia ?? "captado"}`
          : oferta.motivo === "gestor"
          ? "encaminhado pela gestão"
          : "do rodízio de plantão",
        variavelDoModelo(oferta.leads.nome ?? "sem nome", 60),
        variavelDoModelo(resumoDoLead(oferta.leads), 600),
        textoDosMinutos,
      ],
      botoesDaOferta(oferta.id),
    );
    await marcar({ aviso_whatsapp_id: whatsappId, aviso_status: "enviado" });
    return json({ ok: true, whatsapp_id: whatsappId });
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    console.error("Aviso ao corretor não saiu", mensagem);
    await marcar({ aviso_status: `falhou: ${mensagem}`.slice(0, 300) });
    return json({ erro: mensagem }, 502);
  }
}

// O texto já vem pronto do banco: aviso de fila (interno.registrar_acompanhamentos)
// ou pedido de avaliação no fim do atendimento (interno.pedir_avaliacao).
// Fora das 24 horas da última mensagem do cliente, o WhatsApp só aceita modelo
// aprovado: a avaliação vai pelo modelo "avaliacao_atendimento".
const JANELA_MS = 24 * 3600 * 1000;

async function avisarCliente(mensagemId: number): Promise<Response> {
  const mensagem = exigir(
    await banco
      .from("mensagens")
      .select("id, tipo, conteudo, status_entrega, followup_n, leads(whatsapp, ultima_mensagem_cliente_em)")
      .eq("id", mensagemId)
      .in("tipo", ["acompanhamento", "avaliacao", "followup"])
      .maybeSingle(),
    "ler aviso ao cliente",
  ) as {
    id: number; tipo: string; conteudo: string; status_entrega: string | null; followup_n: number | null;
    leads: { whatsapp: string; ultima_mensagem_cliente_em: string | null };
  } | null;
  if (!mensagem || mensagem.status_entrega !== "pendente") return json({ ok: false, motivo: "aviso inexistente ou já enviado" });

  const marcar = async (mudancas: Record<string, unknown>) =>
    exigir(await banco.from("mensagens").update(mudancas).eq("id", mensagem.id), "registrar aviso de fila");

  if (mensagem.leads.whatsapp.startsWith("sim-")) {
    await marcar({ status_entrega: "simulado" });
    return json({ ok: true, simulado: true });
  }
  try {
    const ultima = mensagem.leads.ultima_mensagem_cliente_em ? new Date(mensagem.leads.ultima_mensagem_cliente_em).getTime() : 0;
    const janelaAberta = Date.now() - ultima < JANELA_MS;
    let whatsappId: string | null;
    // Follow-up: texto livre até 23 h da última mensagem do cliente; depois, o modelo da etapa.
    if (mensagem.tipo === "followup" && Date.now() - ultima >= JANELA_LIVRE_FOLLOWUP_MS) {
      whatsappId = await enviarModelo(mensagem.leads.whatsapp, nomeDoModeloFollowup(mensagem.followup_n ?? 1), []);
    } else if (mensagem.tipo === "avaliacao" && !janelaAberta) {
      const cfg = (await banco.from("configuracoes").select("valor").eq("chave", "avaliacao").maybeSingle()).data?.valor as { modelo?: string } | undefined;
      whatsappId = await enviarModelo(mensagem.leads.whatsapp, cfg?.modelo ?? "avaliacao_atendimento", []);
    } else {
      whatsappId = await enviarTexto(mensagem.leads.whatsapp, mensagem.conteudo);
    }
    await marcar({ whatsapp_id: whatsappId, status_entrega: "enviada" });
    return json({ ok: true, whatsapp_id: whatsappId });
  } catch (erro) {
    const texto = erro instanceof Error ? erro.message : String(erro);
    console.error("Aviso ao cliente não saiu", texto);
    await marcar({ status_entrega: `falhou: ${texto}`.slice(0, 300) });
    return json({ erro: texto }, 502);
  }
}

// Cliente escreveu: avisa o corretor do lead e quem está com a oferta aberta.
async function notificarMensagem(mensagemId: number): Promise<Response> {
  const mensagem = exigir(
    await banco.from("mensagens").select("id, tipo, conteudo, leads(id, nome, whatsapp, corretor_id)").eq("id", mensagemId).maybeSingle(),
    "ler mensagem do cliente",
  ) as { id: number; tipo: string; conteudo: string | null; leads: { id: string; nome: string | null; whatsapp: string; corretor_id: string | null } } | null;
  if (!mensagem) return json({ ok: false, motivo: "mensagem inexistente" });
  if (mensagem.leads.whatsapp.startsWith("sim-")) return json({ ok: true, simulado: true });

  const ofertas = exigir(
    await banco.from("atribuicoes").select("corretor_id").eq("lead_id", mensagem.leads.id).eq("status", "pendente"),
    "ler oferta aberta",
  ) as { corretor_id: string }[];
  const destinos = [mensagem.leads.corretor_id, ...ofertas.map((o) => o.corretor_id)].filter((id): id is string => !!id);
  const conteudo = mensagem.conteudo?.trim();
  const rotulo = ROTULO_DA_MIDIA[mensagem.tipo];
  const entregues = await notificar(destinos, {
    titulo: `${mensagem.leads.nome ?? "Cliente"} respondeu`,
    texto: resumir(rotulo ? `${rotulo}${conteudo ? `: ${conteudo}` : ""}` : conteudo || "Nova mensagem", 160),
    url: `/#leads/${mensagem.leads.id}`,
    // Mensagens seguidas do mesmo cliente trocam a notificação em vez de empilhar.
    tag: `lead-${mensagem.leads.id}`,
  });
  return json({ ok: true, entregues });
}

// O próximo passo marcado no funil venceu.
async function avisarTarefa(tarefaId: string): Promise<Response> {
  const tarefa = exigir(
    await banco.from("tarefas").select("id, titulo, corretor_id, concluida_em, leads(id, nome, whatsapp)").eq("id", tarefaId).maybeSingle(),
    "ler tarefa",
  ) as { id: string; titulo: string; corretor_id: string; concluida_em: string | null; leads: { id: string; nome: string | null; whatsapp: string } } | null;
  if (!tarefa || tarefa.concluida_em) return json({ ok: false, motivo: "tarefa inexistente ou concluída" });
  if (tarefa.leads.whatsapp.startsWith("sim-")) return json({ ok: true, simulado: true });
  const entregues = await notificar([tarefa.corretor_id], {
    titulo: `Próximo passo: ${tarefa.leads.nome ?? "cliente sem nome"}`,
    texto: resumir(tarefa.titulo, 160),
    url: `/#leads/${tarefa.leads.id}`,
    tag: `tarefa-${tarefa.id}`,
  });
  return json({ ok: true, entregues });
}

const ORIGENS: Record<string, string> = { site: "pelo site", zap: "pelo ZAP Imóveis", vivareal: "pelo Viva Real", olx: "pela OLX", chavesnamao: "pelo Chaves na Mão", imovelweb: "pelo Imovelweb" };
const TIPOS: Record<string, string> = {
  CASA: "Casa", APARTAMENTO: "Apartamento", TERRENO: "Terreno", CHACARA: "Chácara", SALAO: "Salão", BARRACAO: "Barracão",
  SALA: "Sala", GALPAO: "Galpão", PONTO: "Ponto comercial", AREA: "Área", COMERCIAL: "Comercial",
};

// Alguém clicou no WhatsApp de um imóvel: avisa o captador; sem captador, os gestores.
async function avisarClique(cliqueId: number): Promise<Response> {
  const clique = exigir(
    await banco
      .from("cliques_whatsapp")
      .select("id, imovel_codigo, corretor_id, origem, nome, telefone, criado_em, imoveis(referencia, titulo, tipo, bairro)")
      .eq("id", cliqueId)
      .maybeSingle(),
    "ler clique no WhatsApp",
  ) as {
    id: number; imovel_codigo: string; corretor_id: string | null; origem: string; nome: string | null; telefone: string | null; criado_em: string;
    imoveis: { referencia: string | null; titulo: string | null; tipo: string | null; bairro: string | null };
  } | null;
  if (!clique) return json({ ok: false, motivo: "clique inexistente" });

  let destinos = clique.corretor_id ? [clique.corretor_id] : [];
  if (!destinos.length) {
    const gestores = exigir(await banco.from("corretores").select("id").eq("ativo", true).eq("papel", "gestor"), "ler gestores") as { id: string }[];
    destinos = gestores.map((g) => g.id);
  }
  const i = clique.imoveis;
  const descricao = i.titulo?.trim() || `${TIPOS[i.tipo ?? ""] ?? "Imóvel"}${i.bairro ? ` em ${i.bairro}` : ""}`;
  const quando = new Date(clique.criado_em).toLocaleString("pt-BR", { timeZone: "America/Campo_Grande", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const cliente = [clique.nome, clique.telefone].filter(Boolean).join(", ");
  const entregues = await notificar(destinos, {
    titulo: `Cliente abriu o WhatsApp do ${i.referencia ?? "imóvel"}`,
    texto: resumir(`${descricao} · ${ORIGENS[clique.origem] ?? `por ${clique.origem}`} · ${quando.replace(",", " às")}${cliente ? ` · ${cliente}` : ""}`, 180),
    url: `/#imoveis/${clique.imovel_codigo}`,
    tag: `clique-${clique.imovel_codigo}`,
  });
  return json({ ok: true, entregues });
}

// O corretor assumiu e não mandou mensagem no prazo: o lead voltou ao rodízio.
// Notificação no app sempre; no WhatsApp só sai se a Meta deixar (janela de
// 24 horas aberta com o corretor). Sem modelo aprovado, a recusa é ignorada.
async function avisarPrazoPerdido(atribuicaoId: string): Promise<Response> {
  const perdida = exigir(
    await banco.from("atribuicoes")
      .select("id, lead_id, corretor_id, perdeu_prazo, corretores(nome, whatsapp), leads(nome, whatsapp)")
      .eq("id", atribuicaoId).maybeSingle(),
    "ler prazo perdido",
  ) as { id: string; lead_id: string; corretor_id: string; perdeu_prazo: string | null; corretores: { nome: string; whatsapp: string | null }; leads: { nome: string | null; whatsapp: string } } | null;
  if (!perdida || perdida.perdeu_prazo !== "responder") return json({ ok: false, motivo: "nada a avisar" });
  if (perdida.leads.whatsapp.startsWith("sim-")) return json({ ok: true, simulado: true });
  const minutos = Number(((await banco.from("configuracoes").select("valor").eq("chave", "prazo_resposta_minutos").maybeSingle()).data?.valor) ?? 5);
  const cliente = perdida.leads.nome ?? "o cliente";
  const entregues = await notificar([perdida.corretor_id], {
    titulo: "Você perdeu o prazo para responder",
    texto: `Você assumiu ${cliente} e não mandou mensagem em ${minutos} min. O lead foi redistribuído no rodízio.`,
    url: "/#leads",
    tag: `prazo-${perdida.id}`,
  }).catch(() => 0);
  let whatsapp = "não enviado";
  if (perdida.corretores.whatsapp) {
    try {
      await enviarTexto(
        perdida.corretores.whatsapp,
        `⏱ ${perdida.corretores.nome.split(" ")[0]}, você assumiu o lead ${cliente} mas não mandou mensagem em ${minutos} min. Ele foi redistribuído para o próximo corretor do rodízio.`,
      );
      whatsapp = "enviado";
    } catch (erro) {
      whatsapp = `recusado: ${erro instanceof Error ? erro.message : String(erro)}`.slice(0, 200);
    }
  }
  return json({ ok: true, entregues, whatsapp });
}

// Visita agendada, remarcada ou cancelada: alerta no WhatsApp do administrativo
// e dos gestores (e notificação no painel). Sem o modelo aprovado, tenta o texto
// livre, que só chega com a janela de 24 horas aberta.
type Visita = {
  id: string; imovel_codigo: string; inicio: string; cliente_nome: string; cliente_telefone: string; tipo_visita: string;
  remarcada_de: string | null; motivo_cancelamento: string | null; status: string;
  imoveis: { referencia: string | null; titulo: string | null; tipo: string | null; endereco: string | null; numero: string | null; bairro: string | null; cidade: string | null };
  corretor: { nome: string } | null;
  cancelou: { nome: string } | null;
};

// O mesmo texto dos modelos, para o envio livre enquanto a Meta não aprova.
const preencher = (modelo: { components: { text: string }[] }, v: string[]) =>
  modelo.components[0].text.replace(/\{\{(\d+)\}\}/g, (_, n) => v[Number(n) - 1] ?? "");
const MODELOS_DO_EVENTO: Record<string, typeof MODELO_VISITA_AGENDADA> = {
  agendada: MODELO_VISITA_AGENDADA,
  remarcada: MODELO_VISITA_REMARCADA,
  cancelada: MODELO_VISITA_CANCELADA,
};

async function avisarVisita(visitaId: string, evento: string): Promise<Response> {
  const modelo = MODELOS_DO_EVENTO[evento];
  if (!modelo) return json({ erro: "Evento desconhecido." }, 400);
  const visita = exigir(
    await banco.from("visitas")
      .select("id, imovel_codigo, inicio, cliente_nome, cliente_telefone, tipo_visita, remarcada_de, motivo_cancelamento, status, imoveis(referencia, titulo, tipo, endereco, numero, bairro, cidade), corretor:corretores!visitas_corretor_id_fkey(nome), cancelou:corretores!visitas_cancelada_por_fkey(nome)")
      .eq("id", visitaId).maybeSingle(),
    "ler visita",
  ) as Visita | null;
  if (!visita) return json({ ok: false, motivo: "visita inexistente" });

  const i = visita.imoveis;
  const imovel = variavelDoModelo(`${i.referencia ?? visita.imovel_codigo} · ${i.titulo?.trim() || `${TIPOS[i.tipo ?? ""] ?? "Imóvel"}${i.bairro ? ` no ${i.bairro}` : ""}`}`, 120);
  const endereco = variavelDoModelo([[i.endereco, i.numero].filter(Boolean).join(", "), i.bairro, i.cidade].filter(Boolean).join(", ") || "endereço não informado", 160);
  const quando = quandoDaVisita(visita.inicio);
  const digitos = visita.cliente_telefone.replace(/\D/g, "");
  const cliente = variavelDoModelo(`${visita.cliente_nome}, ${telefoneLegivel(digitos.startsWith("55") ? digitos : `55${digitos}`)}`, 120);
  const corretor = visita.corretor?.nome.split(" ")[0] ?? "a definir";
  const tipo = TIPO_DE_VISITA[visita.tipo_visita] ?? visita.tipo_visita;

  let variaveis: string[], titulo: string, texto: string;
  if (evento === "agendada") {
    variaveis = [imovel, endereco, quando, cliente, corretor, tipo];
    titulo = "Nova visita agendada";
    texto = `${quando} · ${imovel} · ${visita.cliente_nome}`;
  } else if (evento === "remarcada") {
    const antes = visita.remarcada_de ? quandoDaVisita(visita.remarcada_de) : "não informado";
    variaveis = [imovel, endereco, quando, antes, cliente, corretor, tipo];
    titulo = "Visita remarcada";
    texto = `Agora ${quando} (antes ${antes}) · ${imovel}`;
  } else {
    const quem = variavelDoModelo(`${visita.cancelou?.nome.split(" ")[0] ?? "equipe"}${visita.motivo_cancelamento ? ` (${visita.motivo_cancelamento})` : ""}`, 160);
    variaveis = [imovel, endereco, quando, cliente, corretor, quem];
    titulo = "Visita cancelada";
    texto = `${quando} · ${imovel} · ${visita.cliente_nome}`;
  }

  const equipe = exigir(
    await banco.from("corretores").select("id, nome, whatsapp").eq("ativo", true).in("papel", ["administrativo", "gestor"]),
    "ler administrativo e gestores",
  ) as { id: string; nome: string; whatsapp: string | null }[];

  const entregues = await notificar(equipe.map((p) => p.id), { titulo, texto: resumir(texto, 180), url: "/#agenda", tag: `visita-${visita.id}` }).catch(() => 0);
  const enviados: string[] = [];
  const falhas: string[] = [];
  for (const pessoa of equipe) {
    if (!pessoa.whatsapp) {
      falhas.push(`${pessoa.nome}: sem WhatsApp`);
      continue;
    }
    try {
      await enviarModelo(pessoa.whatsapp, modelo.name, variaveis);
      enviados.push(pessoa.nome);
    } catch (erroModelo) {
      try {
        await enviarTexto(pessoa.whatsapp, preencher(modelo, variaveis));
        enviados.push(`${pessoa.nome} (texto livre)`);
      } catch {
        falhas.push(`${pessoa.nome}: ${erroModelo instanceof Error ? erroModelo.message : String(erroModelo)}`.slice(0, 200));
      }
    }
  }
  await banco.from("visitas").update({ aviso: { evento, enviados, falhas, notificacoes: entregues, em: new Date().toISOString() } }).eq("id", visita.id);
  return json({ ok: true, enviados, falhas, entregues });
}

// Alguém entrou numa demanda (participante novo, ou responsável de uma demanda
// que outra pessoa criou): notificação no celular de cada um.
async function avisarDemanda(demandaId: string, pessoas: string[]): Promise<Response> {
  const demanda = exigir(
    await banco.from("demandas").select("id, titulo, prazo, status, responsavel_id, criador:corretores!demandas_criada_por_fkey(nome)").eq("id", demandaId).maybeSingle(),
    "ler demanda",
  ) as { id: string; titulo: string; prazo: string; status: string; responsavel_id: string; criador: { nome: string } | null } | null;
  if (!demanda || demanda.status === "concluida") return json({ ok: false, motivo: "demanda inexistente ou concluída" });
  const quando = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Campo_Grande", weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(demanda.prazo));
  const quem = demanda.criador?.nome?.split(" ")[0];
  const entregues = await notificar(pessoas, {
    titulo: pessoas.length === 1 && pessoas[0] === demanda.responsavel_id ? "Nova demanda para você" : "Você foi incluído numa demanda",
    texto: resumir(`${demanda.titulo} · prazo ${quando}${quem ? ` · por ${quem}` : ""}`, 180),
    url: "/#demandas",
    tag: `demanda-${demanda.id}`,
  }).catch(() => 0);
  return json({ ok: true, entregues });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ erro: "Use POST." }, 405);
  if (!(await confereChave("avisos", req.headers.get("x-avisos-chave")))) return json({ erro: "Chave inválida." }, 401);

  const corpo = await req.json().catch(() => ({})) as { atribuicao_id?: string; mensagem_id?: number; notificar_mensagem_id?: number; tarefa_id?: string; clique_id?: number; prazo_perdido_id?: string; visita_id?: string; evento?: string; demanda_id?: string; pessoas?: string[] };
  if (corpo.demanda_id) return avisarDemanda(corpo.demanda_id, Array.isArray(corpo.pessoas) ? corpo.pessoas.filter((p) => typeof p === "string") : []);
  if (corpo.visita_id) return avisarVisita(corpo.visita_id, corpo.evento ?? "");
  if (corpo.prazo_perdido_id) return avisarPrazoPerdido(corpo.prazo_perdido_id);
  if (corpo.clique_id) return avisarClique(Number(corpo.clique_id));
  if (corpo.tarefa_id) return avisarTarefa(corpo.tarefa_id);
  if (corpo.notificar_mensagem_id) return notificarMensagem(Number(corpo.notificar_mensagem_id));
  if (corpo.mensagem_id) return avisarCliente(Number(corpo.mensagem_id));
  return avisarCorretor(corpo.atribuicao_id ?? "");
});
