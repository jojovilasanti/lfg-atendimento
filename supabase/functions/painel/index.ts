// Ações do painel que precisam do servidor.
//
// POST /functions/v1/painel   Authorization: Bearer <sessão de quem está logado>
//   { "acao": "enviar_mensagem", "lead_id", "texto", "responde_a"? }  corretor do lead ou gestor; responde_a = id da mensagem citada
//   { "acao": "enviar_audio", "lead_id", "audio" (base64), "tipo" }   corretor do lead ou gestor
//   { "acao": "preparar_arquivo", "lead_id", "nome", "tipo" }     endereço para o navegador subir a foto ou o documento
//   { "acao": "enviar_arquivo", "lead_id", "caminho", "nome", "tipo", "legenda"?, "responde_a"? }   manda pelo WhatsApp
//   { "acao": "chave_push" }       chave pública para o navegador ativar as notificações
//   { "acao": "testar_push" }      manda uma notificação de teste para quem pediu
//   { "acao": "criar_acesso", "nome", "email", "senha", "whatsapp", "creci", "papel" }   só o gestor
//   { "acao": "redefinir_senha", "corretor_id", "senha" }         gestor; administrativo, menos de gestor
//   { "acao": "definir_email", "corretor_id", "email", "senha"? }  gestor; administrativo só troca e-mail de quem já tem login e não é gestor
//   { "acao": "primeiro_gestor", "codigo", "nome", "email", "senha", "whatsapp" }
//     sem sessão: vale só com o código de convite, uma única vez
import { decodeBase64 } from "jsr:@std/encoding@1.0.10/base64";
import { confereChave } from "../_shared/acesso.ts";
import { banco, exigir } from "../_shared/banco.ts";
import { converterParaVoz, transcreverAudio } from "../_shared/midia.ts";
import { chavePublicaPush, notificar } from "../_shared/notificacoes.ts";
import { normalizarWhatsapp } from "../_shared/telefone.ts";
import { enviarArquivo as enviarArquivoNoWhatsapp, enviarAudio as enviarAudioNoWhatsapp, enviarTexto, subirMidia } from "../_shared/whatsapp.ts";

declare const EdgeRuntime: { waitUntil(promessa: Promise<unknown>): void };

const ORIGENS_DO_PAINEL = ["https://srv2083149.hstgr.cloud", "https://lfg.jojodigitals.com", "http://localhost:5173"];
const JANELA_DO_WHATSAPP_MS = 24 * 60 * 60 * 1000;
// Uns 10 minutos de áudio gravado no navegador.
const LIMITE_AUDIO_BYTES = 8 * 1024 * 1024;

type Papel = "corretor" | "gestor" | "administrativo";
type Corretor = { id: string; nome: string; papel: Papel; ativo: boolean; usuario_id: string | null };

// O administrativo faz o mesmo que o gestor, menos criar acessos, mexer no site,
// nos disparos e nos atendimentos (leads), e não mexe na conta de um gestor.
// O administrativo não troca senha nem e-mail de um gestor (nem vira gestor por aí).
async function podeMexerNaConta(quem: Corretor, corretorId: string) {
  if (quem.papel === "gestor") return;
  if (quem.papel !== "administrativo") throw new ErroDoPainel(403, "Só o gestor ou o administrativo mexe no acesso da equipe.");
  const alvo = exigir(await banco.from("corretores").select("papel").eq("id", corretorId).maybeSingle(), "ler pessoa") as { papel: Papel } | null;
  if (alvo?.papel === "gestor") throw new ErroDoPainel(403, "Só um gestor mexe no acesso de outro gestor.");
}
type Corpo = Record<string, unknown>;

class ErroDoPainel extends Error {
  constructor(public status: number, mensagem: string) {
    super(mensagem);
  }
}

function cabecalhosCors(req: Request): Record<string, string> {
  const origem = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ORIGENS_DO_PAINEL.includes(origem) ? origem : ORIGENS_DO_PAINEL[0],
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

function texto(valor: unknown, campo: string, minimo = 1, maximo = 200): string {
  const limpo = typeof valor === "string" ? valor.trim() : "";
  if (limpo.length < minimo || limpo.length > maximo) throw new ErroDoPainel(400, `Preencha ${campo}.`);
  return limpo;
}

function senhaValida(valor: unknown): string {
  if (typeof valor !== "string" || valor.length < 8) throw new ErroDoPainel(400, "A senha precisa ter pelo menos 8 caracteres.");
  return valor;
}

function emailValido(valor: unknown): string {
  const email = texto(valor, "o e-mail", 3, 200).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ErroDoPainel(400, "Esse e-mail não parece válido.");
  return email;
}

function whatsappValido(valor: unknown): string {
  const numero = normalizarWhatsapp(typeof valor === "string" ? valor : "");
  if (!numero) throw new ErroDoPainel(400, "Informe o WhatsApp com DDD, por exemplo (67) 99999-9999.");
  return numero;
}

// Quem está logado, pela sessão do Supabase. Só pessoas cadastradas e ativas na equipe.
// O token é conferido pela assinatura (chaves públicas do projeto, guardadas
// enquanto a função está quente); só cai na consulta ao login se não der.
async function quemChama(req: Request): Promise<Corretor> {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) throw new ErroDoPainel(401, "Entre no painel de novo.");
  let usuarioId: string | null = null;
  try {
    const { data, error } = await banco.auth.getClaims(token);
    if (!error && typeof data?.claims?.sub === "string") usuarioId = data.claims.sub;
  } catch {
    // segue para a consulta ao login
  }
  if (!usuarioId) {
    const { data, error } = await banco.auth.getUser(token);
    if (error || !data.user) throw new ErroDoPainel(401, "Sua sessão expirou. Entre no painel de novo.");
    usuarioId = data.user.id;
  }
  const corretor = exigir(
    await banco.from("corretores").select("id, nome, papel, ativo, usuario_id").eq("usuario_id", usuarioId).maybeSingle(),
    "ler cadastro",
  ) as Corretor | null;
  if (!corretor?.ativo) throw new ErroDoPainel(403, "Seu acesso não está ativo. Fale com o gestor.");
  return corretor;
}

async function criarPessoa(dados: Corpo, papel: Papel) {
  const nome = texto(dados.nome, "o nome");
  const email = emailValido(dados.email);
  const senha = senhaValida(dados.senha);
  const whatsapp = whatsappValido(dados.whatsapp);
  const creci = typeof dados.creci === "string" && dados.creci.trim() ? dados.creci.trim() : null;

  const { data: criado, error } = await banco.auth.admin.createUser({ email, password: senha, email_confirm: true, user_metadata: { nome } });
  if (error || !criado.user) {
    const jaExiste = /already|registered|exists/i.test(error?.message ?? "");
    throw new ErroDoPainel(jaExiste ? 409 : 400, jaExiste ? "Já existe um acesso com esse e-mail." : `Não foi possível criar o acesso: ${error?.message}`);
  }

  const { data: corretor, error: erroCadastro } = await banco
    .from("corretores")
    .insert({ nome, whatsapp, creci, papel, usuario_id: criado.user.id, no_rodizio: papel === "corretor", de_plantao: false })
    .select("*")
    .single();
  if (erroCadastro) {
    // Sem cadastro na equipe o acesso não serve para nada: desfaz.
    await banco.auth.admin.deleteUser(criado.user.id);
    const duplicado = erroCadastro.code === "23505";
    throw new ErroDoPainel(duplicado ? 409 : 400, duplicado ? "Esse WhatsApp já está cadastrado na equipe." : `Não foi possível cadastrar: ${erroCadastro.message}`);
  }
  return corretor;
}

type LeadParaResponder = { id: string; whatsapp: string; corretor_id: string | null; ultima_mensagem_cliente_em: string | null };

// Só o corretor do lead (ou o gestor) responde, e só dentro da janela de 24 horas.
// Confere o login e lê o lead ao mesmo tempo.
async function quemELead(req: Request, dados: Corpo): Promise<[Corretor, LeadParaResponder]> {
  const leadId = texto(dados.lead_id, "o lead", 1, 64);
  const [quem, leitura] = await Promise.all([
    quemChama(req),
    banco.from("leads").select("id, whatsapp, corretor_id, ultima_mensagem_cliente_em").eq("id", leadId).maybeSingle(),
  ]);
  return [quem, await leadParaResponder(quem, exigir(leitura, "ler lead") as LeadParaResponder | null)];
}

async function leadParaResponder(quem: Corretor, lead: LeadParaResponder | null): Promise<LeadParaResponder> {
  if (!lead) throw new ErroDoPainel(404, "Lead não encontrado.");
  // O administrativo não acompanha atendimentos: só o corretor do lead e o gestor respondem.
  if (quem.papel !== "gestor" && lead.corretor_id !== quem.id) {
    throw new ErroDoPainel(403, "Assuma o lead antes de responder.");
  }
  const ultimaDoCliente = lead.ultima_mensagem_cliente_em ? new Date(lead.ultima_mensagem_cliente_em).getTime() : 0;
  if (Date.now() - ultimaDoCliente > JANELA_DO_WHATSAPP_MS) {
    throw new ErroDoPainel(422, "O cliente não escreve há mais de 24 horas. O WhatsApp só permite retomar com uma mensagem-modelo aprovada.");
  }
  return lead;
}

async function enviarMensagem(req: Request, dados: Corpo) {
  const [quem, lead] = await quemELead(req, dados);
  const conteudo = texto(dados.texto, "a mensagem", 1, 4000);
  // Citação: só mensagens desta conversa que passaram pelo WhatsApp têm o ID.
  let citar: string | null = null;
  if (dados.responde_a != null) {
    const citada = exigir(
      await banco.from("mensagens").select("whatsapp_id").eq("id", Number(dados.responde_a)).eq("lead_id", lead.id).maybeSingle(),
      "ler mensagem citada",
    ) as { whatsapp_id: string | null } | null;
    citar = citada?.whatsapp_id ?? null;
  }

  // Leads do simulador não têm WhatsApp de verdade: a mensagem fica só registrada.
  const simulado = lead.whatsapp.startsWith("sim-");
  let whatsappId: string | null = null;
  let entrega = simulado ? "simulada" : "enviada";
  if (!simulado) {
    try {
      whatsappId = await enviarTexto(lead.whatsapp, conteudo, citar);
    } catch (erro) {
      console.error("Falha ao enviar mensagem do corretor", erro);
      throw new ErroDoPainel(502, "O WhatsApp não aceitou a mensagem. Tente de novo em instantes.");
    }
  }
  // Grava a mensagem e pausa a IA ao mesmo tempo: quem respondeu pessoalmente
  // assume a conversa.
  const [gravada, pausa] = await Promise.all([
    banco.from("mensagens")
      .insert({ lead_id: lead.id, autor: "corretor", corretor_id: quem.id, conteudo, whatsapp_id: whatsappId, status_entrega: entrega, cita_whatsapp_id: citar })
      .select("*")
      .single(),
    banco.from("leads").update({ ia_ativa: false }).eq("id", lead.id),
  ]);
  exigir(pausa, "pausar IA");
  return { mensagem: exigir(gravada, "registrar mensagem") };
}

// Áudio gravado no painel: vira mensagem de voz no WhatsApp do cliente e fica
// guardado no bucket, com a transcrição para a equipe e a IA lerem depois.
async function enviarAudio(req: Request, dados: Corpo) {
  const [quem, lead] = await quemELead(req, dados);
  let gravado: Uint8Array<ArrayBuffer>;
  try {
    gravado = decodeBase64(typeof dados.audio === "string" ? dados.audio : "") as Uint8Array<ArrayBuffer>;
  } catch {
    throw new ErroDoPainel(400, "O áudio não chegou inteiro. Grave de novo.");
  }
  if (gravado.length < 200) throw new ErroDoPainel(400, "O áudio ficou vazio. Grave de novo.");
  if (gravado.length > LIMITE_AUDIO_BYTES) throw new ErroDoPainel(413, "Áudio muito longo. Grave um mais curto.");

  let voz: Uint8Array<ArrayBuffer>;
  try {
    voz = await converterParaVoz(gravado);
  } catch (erro) {
    console.error("Falha ao converter o áudio do corretor", erro);
    throw new ErroDoPainel(502, "Não foi possível preparar o áudio. Tente gravar de novo.");
  }
  const caminho = `${lead.whatsapp}/corretor-${crypto.randomUUID()}.ogg`;
  exigir(await banco.storage.from("midias").upload(caminho, voz, { contentType: "audio/ogg" }), "guardar áudio");

  const simulado = lead.whatsapp.startsWith("sim-");
  let whatsappId: string | null = null;
  if (!simulado) {
    try {
      whatsappId = await enviarAudioNoWhatsapp(lead.whatsapp, await subirMidia(voz, "audio/ogg", "audio.ogg"));
    } catch (erro) {
      console.error("Falha ao enviar áudio do corretor", erro);
      throw new ErroDoPainel(502, "O WhatsApp não aceitou o áudio. Tente de novo em instantes.");
    }
  }
  const mensagem = exigir(
    await banco
      .from("mensagens")
      .insert({
        lead_id: lead.id, autor: "corretor", corretor_id: quem.id, tipo: "audio",
        midia_url: caminho, midia_tipo: "audio/ogg", whatsapp_id: whatsappId, status_entrega: simulado ? "simulada" : "enviada",
      })
      .select("*")
      .single(),
    "registrar áudio",
  ) as { id: number };
  exigir(await banco.from("leads").update({ ia_ativa: false }).eq("id", lead.id), "pausar IA");

  // A transcrição não segura a resposta do painel.
  EdgeRuntime.waitUntil(
    transcreverAudio(voz)
      .then(async (transcricao) => {
        if (transcricao) exigir(await banco.from("mensagens").update({ conteudo: transcricao }).eq("id", mensagem.id), "guardar transcrição");
      })
      .catch((erro) => console.warn("Áudio do corretor não foi transcrito", erro)),
  );
  return { mensagem };
}

// Fotos e documentos que o corretor manda. O navegador sobe o arquivo direto
// para o bucket (endereço assinado) e depois pede o envio; a Meta baixa o
// arquivo por um link temporário.
const TIPOS_DE_ARQUIVO: Record<string, { extensao: string; tipo: "image" | "document"; limite: number }> = {
  "image/jpeg": { extensao: "jpg", tipo: "image", limite: 5 },
  "image/png": { extensao: "png", tipo: "image", limite: 5 },
  "application/pdf": { extensao: "pdf", tipo: "document", limite: 15 },
  "application/msword": { extensao: "doc", tipo: "document", limite: 15 },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": { extensao: "docx", tipo: "document", limite: 15 },
  "application/vnd.ms-excel": { extensao: "xls", tipo: "document", limite: 15 },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": { extensao: "xlsx", tipo: "document", limite: 15 },
  "application/vnd.ms-powerpoint": { extensao: "ppt", tipo: "document", limite: 15 },
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": { extensao: "pptx", tipo: "document", limite: 15 },
  "text/plain": { extensao: "txt", tipo: "document", limite: 15 },
  "text/csv": { extensao: "csv", tipo: "document", limite: 15 },
};

function tipoDeArquivo(dados: Corpo) {
  const tipo = typeof dados.tipo === "string" ? dados.tipo.split(";")[0].trim().toLowerCase() : "";
  const regra = TIPOS_DE_ARQUIVO[tipo];
  if (!regra) throw new ErroDoPainel(415, "O WhatsApp não aceita esse tipo de arquivo. Envie foto (JPG ou PNG), PDF, Word, Excel, PowerPoint ou texto.");
  return { mime: tipo, ...regra };
}

async function prepararArquivo(req: Request, dados: Corpo) {
  const [, lead] = await quemELead(req, dados);
  const arquivo = tipoDeArquivo(dados);
  const caminho = `${lead.whatsapp}/corretor-${crypto.randomUUID()}.${arquivo.extensao}`;
  const { data, error } = await banco.storage.from("midias").createSignedUploadUrl(caminho);
  if (error || !data) throw new ErroDoPainel(500, "Não foi possível preparar o envio do arquivo.");
  return { caminho, token: data.token, limite_mb: arquivo.limite };
}

async function enviarArquivo(req: Request, dados: Corpo) {
  const [quem, lead] = await quemELead(req, dados);
  const arquivo = tipoDeArquivo(dados);
  const caminho = texto(dados.caminho, "o arquivo", 5, 300);
  if (!caminho.startsWith(`${lead.whatsapp}/corretor-`)) throw new ErroDoPainel(400, "Arquivo de outra conversa.");
  const nome = typeof dados.nome === "string" && dados.nome.trim() ? dados.nome.trim().slice(0, 120) : `arquivo.${arquivo.extensao}`;
  const legenda = typeof dados.legenda === "string" && dados.legenda.trim() ? dados.legenda.trim().slice(0, 1000) : null;

  const [assinado, citada] = await Promise.all([
    banco.storage.from("midias").createSignedUrl(caminho, 600),
    dados.responde_a != null
      ? banco.from("mensagens").select("whatsapp_id").eq("id", Number(dados.responde_a)).eq("lead_id", lead.id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (assinado.error || !assinado.data?.signedUrl) throw new ErroDoPainel(404, "O arquivo não chegou ao servidor. Tente de novo.");
  const citar = (citada.data as { whatsapp_id: string | null } | null)?.whatsapp_id ?? null;

  const simulado = lead.whatsapp.startsWith("sim-");
  let whatsappId: string | null = null;
  if (!simulado) {
    try {
      whatsappId = await enviarArquivoNoWhatsapp(lead.whatsapp, arquivo.tipo, assinado.data.signedUrl, { legenda, nomeDoArquivo: nome, citar });
    } catch (erro) {
      console.error("Falha ao enviar arquivo do corretor", erro);
      throw new ErroDoPainel(502, "O WhatsApp não aceitou o arquivo. Confira o tamanho e o tipo e tente de novo.");
    }
  }
  const [gravada, pausa] = await Promise.all([
    banco.from("mensagens").insert({
      lead_id: lead.id, autor: "corretor", corretor_id: quem.id, tipo: arquivo.tipo,
      conteudo: legenda ?? (arquivo.tipo === "document" ? nome : null),
      midia_url: caminho, midia_tipo: arquivo.mime, whatsapp_id: whatsappId,
      status_entrega: simulado ? "simulada" : "enviada", cita_whatsapp_id: citar,
    }).select("*").single(),
    banco.from("leads").update({ ia_ativa: false }).eq("id", lead.id),
  ]);
  exigir(pausa, "pausar IA");
  return { mensagem: exigir(gravada, "registrar arquivo") };
}

async function redefinirSenha(quem: Corretor, dados: Corpo) {
  const corretorId = texto(dados.corretor_id, "a pessoa", 1, 64);
  await podeMexerNaConta(quem, corretorId);
  const senha = senhaValida(dados.senha);
  const alvo = exigir(await banco.from("corretores").select("usuario_id").eq("id", corretorId).maybeSingle(), "ler pessoa") as
    | { usuario_id: string | null }
    | null;
  if (!alvo?.usuario_id) throw new ErroDoPainel(404, "Essa pessoa ainda não tem acesso ao painel.");
  const { error } = await banco.auth.admin.updateUserById(alvo.usuario_id, { password: senha });
  if (error) throw new ErroDoPainel(400, `Não foi possível trocar a senha: ${error.message}`);
  return { ok: true };
}

// E-mail de acesso de quem já está na equipe: troca o e-mail do login ou, se a
// pessoa ainda não tem login, cria um com a senha provisória e liga ao cadastro.
async function definirEmail(quem: Corretor, dados: Corpo) {
  const corretorId = texto(dados.corretor_id, "a pessoa", 1, 64);
  await podeMexerNaConta(quem, corretorId);
  const email = emailValido(dados.email);
  const alvo = exigir(await banco.from("corretores").select("id, nome, usuario_id").eq("id", corretorId).maybeSingle(), "ler pessoa") as
    | { id: string; nome: string; usuario_id: string | null }
    | null;
  if (!alvo) throw new ErroDoPainel(404, "Pessoa não encontrada.");
  // Criar o login de quem ainda não tem é criar acesso: só o gestor.
  if (!alvo.usuario_id && quem.papel !== "gestor") throw new ErroDoPainel(403, "Só o gestor cria acessos ao painel.");
  const jaUsado = (mensagem?: string) => /already|registered|exists/i.test(mensagem ?? "");

  if (alvo.usuario_id) {
    const { error } = await banco.auth.admin.updateUserById(alvo.usuario_id, { email, email_confirm: true });
    if (error) {
      throw new ErroDoPainel(jaUsado(error.message) ? 409 : 400, jaUsado(error.message) ? "Esse e-mail já é usado por outro acesso." : `Não foi possível trocar o e-mail: ${error.message}`);
    }
    return { ok: true, criado: false };
  }

  const senha = senhaValida(dados.senha);
  const { data: criado, error } = await banco.auth.admin.createUser({ email, password: senha, email_confirm: true, user_metadata: { nome: alvo.nome } });
  if (error || !criado.user) {
    throw new ErroDoPainel(jaUsado(error?.message) ? 409 : 400, jaUsado(error?.message) ? "Esse e-mail já é usado por outro acesso." : `Não foi possível criar o acesso: ${error?.message}`);
  }
  const { error: erroLigar } = await banco.from("corretores").update({ usuario_id: criado.user.id }).eq("id", alvo.id).is("usuario_id", null);
  if (erroLigar) {
    await banco.auth.admin.deleteUser(criado.user.id);
    throw new ErroDoPainel(400, `Não foi possível ligar o acesso: ${erroLigar.message}`);
  }
  return { ok: true, criado: true };
}

async function primeiroGestor(dados: Corpo) {
  if (!(await confereChave("convite_gestor", typeof dados.codigo === "string" ? dados.codigo.trim() : null))) {
    throw new ErroDoPainel(403, "Código de convite inválido ou já usado.");
  }
  const existente = exigir(await banco.from("corretores").select("id").eq("papel", "gestor").eq("ativo", true).limit(1), "procurar gestor") as unknown[];
  if (existente.length) throw new ErroDoPainel(409, "O painel já tem um gestor. Peça a ele o seu acesso.");
  const gestor = await criarPessoa(dados, "gestor");
  // O convite vale uma vez só.
  exigir(await banco.from("chaves_acesso").delete().eq("nome", "convite_gestor"), "apagar convite");
  return { gestor };
}

Deno.serve(async (req) => {
  const cors = cabecalhosCors(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const responder = (corpo: unknown, status = 200) =>
    new Response(JSON.stringify(corpo), { status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });
  if (req.method !== "POST") return responder({ erro: "Use POST." }, 405);

  try {
    const dados = (await req.json().catch(() => ({}))) as Corpo;
    switch (dados.acao) {
      case "primeiro_gestor":
        return responder(await primeiroGestor(dados));
      case "enviar_mensagem":
        return responder(await enviarMensagem(req, dados));
      case "enviar_audio":
        return responder(await enviarAudio(req, dados));
      case "preparar_arquivo":
        return responder(await prepararArquivo(req, dados));
      case "enviar_arquivo":
        return responder(await enviarArquivo(req, dados));
      case "chave_push":
        await quemChama(req);
        return responder({ chave: await chavePublicaPush() });
      case "testar_push": {
        const quem = await quemChama(req);
        const entregues = await notificar([quem.id], {
          titulo: "Notificações ligadas",
          texto: "É assim que você vai saber quando um cliente responder ou um lead chegar para você.",
          url: "/#leads",
          tag: "teste",
        });
        return responder({ entregues });
      }
      case "criar_acesso": {
        const quem = await quemChama(req);
        if (quem.papel !== "gestor") throw new ErroDoPainel(403, "Só o gestor cria acessos.");
        const papel: Papel = dados.papel === "gestor" ? "gestor" : dados.papel === "administrativo" ? "administrativo" : "corretor";
        return responder({ corretor: await criarPessoa(dados, papel) });
      }
      case "redefinir_senha":
        return responder(await redefinirSenha(await quemChama(req), dados));
      case "definir_email":
        return responder(await definirEmail(await quemChama(req), dados));
      default:
        return responder({ erro: "Ação desconhecida." }, 400);
    }
  } catch (erro) {
    if (erro instanceof ErroDoPainel) return responder({ erro: erro.message }, erro.status);
    console.error(erro);
    return responder({ erro: "Algo deu errado no servidor. Tente de novo." }, 500);
  }
});
