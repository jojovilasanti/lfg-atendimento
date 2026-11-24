// Google Agenda de cada pessoa da equipe (OAuth, Google Calendar API).
//
// POST /functions/v1/google-agenda
//   { acao: "conectar" }       (login do painel) devolve o endereço de autorização do Google
//   { acao: "desconectar" }    (login do painel) apaga os eventos criados e esquece a conta
//   { acao: "sincronizar", origem: "demanda" | "visita", id }  (banco, x-avisos-chave)
// GET  /functions/v1/google-agenda/retorno?code&state
//   o Google volta para https://lfg.jojodigitals.com/google/retorno, que o Caddy
//   repassa para cá; a conta fica conectada e a pessoa volta para o painel.
//
// Segredos: GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET (projeto "LFG Painel" no Google Cloud).
import { confereChave, json } from "../_shared/acesso.ts";
import { banco, exigir } from "../_shared/banco.ts";

const PAINEL = "https://lfg.jojodigitals.com";
const RETORNO = `${PAINEL}/google/retorno`;
const ESCOPO = "https://www.googleapis.com/auth/calendar.events";
const ORIGENS_DO_PAINEL = [PAINEL, "http://localhost:5173"];
const FUSO = "America/Campo_Grande";

type Conexao = { corretor_id: string; email: string | null; refresh_token: string; access_token: string | null; expira_em: string | null };

function credenciais() {
  const id = Deno.env.get("GOOGLE_CLIENT_ID")?.trim();
  const segredo = Deno.env.get("GOOGLE_CLIENT_SECRET")?.trim();
  if (!id || !segredo) throw new Error("Google Agenda sem configuração: faltam GOOGLE_CLIENT_ID ou GOOGLE_CLIENT_SECRET.");
  return { id, segredo };
}

function cors(req: Request): Record<string, string> {
  const origem = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ORIGENS_DO_PAINEL.includes(origem) ? origem : PAINEL,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

// Quem está logado no painel (mesma conferência da função painel).
async function quemChama(req: Request): Promise<{ id: string; papel: string } | null> {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  let usuarioId: string | null = null;
  try {
    const { data, error } = await banco.auth.getClaims(token);
    if (!error && typeof data?.claims?.sub === "string") usuarioId = data.claims.sub;
  } catch {
    // segue para a consulta ao login
  }
  if (!usuarioId) {
    const { data } = await banco.auth.getUser(token);
    usuarioId = data.user?.id ?? null;
  }
  if (!usuarioId) return null;
  const { data } = await banco.from("corretores").select("id, papel, ativo").eq("usuario_id", usuarioId).maybeSingle();
  return data?.ativo ? { id: data.id, papel: data.papel } : null;
}

// --- Google: tokens e eventos -------------------------------------------------

async function pedirToken(campos: Record<string, string>): Promise<Record<string, unknown>> {
  const { id, segredo } = credenciais();
  const resposta = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: id, client_secret: segredo, ...campos }),
  });
  const corpo = await resposta.json().catch(() => ({}));
  if (!resposta.ok) throw new Error(`Google recusou o token: ${corpo.error ?? resposta.status}`);
  return corpo;
}

class ReconectarError extends Error {}

// Token válido da pessoa; renova sozinho quando venceu.
async function tokenDe(conexao: Conexao): Promise<string> {
  if (conexao.access_token && conexao.expira_em && new Date(conexao.expira_em).getTime() - Date.now() > 60_000) {
    return conexao.access_token;
  }
  try {
    const novo = await pedirToken({ grant_type: "refresh_token", refresh_token: conexao.refresh_token });
    const expira = new Date(Date.now() + Number(novo.expires_in ?? 3600) * 1000).toISOString();
    await banco.from("google_conexoes").update({ access_token: novo.access_token, expira_em: expira, erro: null }).eq("corretor_id", conexao.corretor_id);
    conexao.access_token = String(novo.access_token);
    conexao.expira_em = expira;
    return conexao.access_token;
  } catch (erro) {
    const texto = erro instanceof Error ? erro.message : String(erro);
    if (texto.includes("invalid_grant")) {
      await banco.from("google_conexoes").update({ erro: "A conta Google desconectou (senha trocada, acesso removido ou 7 dias em modo de teste). Conecte de novo." }).eq("corretor_id", conexao.corretor_id);
      throw new ReconectarError(texto);
    }
    throw erro;
  }
}

async function chamarAgenda(conexao: Conexao, metodo: string, caminho: string, corpo?: unknown): Promise<Record<string, unknown> | null> {
  const token = await tokenDe(conexao);
  const resposta = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events${caminho}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  if (metodo === "DELETE" && (resposta.status === 404 || resposta.status === 410)) return null;
  if (!resposta.ok) {
    const detalhe = await resposta.text().catch(() => "");
    const erro = new Error(`Google Agenda recusou (HTTP ${resposta.status}): ${detalhe.slice(0, 200)}`);
    (erro as Error & { status?: number }).status = resposta.status;
    throw erro;
  }
  return resposta.status === 204 ? null : await resposta.json();
}

// --- Demandas e visitas viram eventos ----------------------------------------

const somarMinutos = (iso: string, minutos: number) => new Date(new Date(iso).getTime() + minutos * 60_000).toISOString();
const STATUS: Record<string, string> = { pendente: "Pendente", em_andamento: "Em andamento", concluida: "Concluída" };

type Desejado = { corretor_id: string; evento: Record<string, unknown> };

async function eventosDesejados(origem: string, id: string): Promise<Desejado[]> {
  if (origem === "demanda") {
    const { data: d } = await banco.from("demandas").select("id, titulo, descricao, responsavel_id, prazo, status").eq("id", id).maybeSingle();
    if (!d) return [];
    return [{
      corretor_id: d.responsavel_id,
      evento: {
        summary: `${d.status === "concluida" ? "✅ " : "📋 "}${d.titulo}`,
        description: [d.descricao, `Status: ${STATUS[d.status] ?? d.status}`, `Demandas no painel: ${PAINEL}/#demandas`].filter(Boolean).join("\n\n"),
        start: { dateTime: d.prazo, timeZone: FUSO },
        end: { dateTime: somarMinutos(d.prazo, 30), timeZone: FUSO },
        extendedProperties: { private: { lfg: `demanda:${d.id}` } },
      },
    }];
  }
  const { data: v } = await banco.from("visitas")
    .select("id, tipo, local, inicio, fim, cliente_nome, cliente_telefone, corretor_id, tipo_visita, observacoes, status, imoveis(referencia, titulo, tipo, endereco, numero, bairro, cidade)")
    .eq("id", id).maybeSingle();
  // Cancelada ou cliente que não veio sai da agenda do Google; realizada fica.
  if (!v || !["agendada", "confirmada", "realizada"].includes(v.status) || !v.corretor_id) return [];
  const i = (v.imoveis ?? {}) as Record<string, string | null>;
  const endereco = [[i.endereco, i.numero].filter(Boolean).join(", "), i.bairro, i.cidade].filter(Boolean).join(", ") || v.local || "";
  const rotulo = ({ aluguel: "🏠 Visita aluguel", venda: "🏡 Visita venda", captacao: "📝 Captação", outro: "📌 Compromisso" } as Record<string, string>)[v.tipo] ?? "🏠 Visita";
  return [{
    corretor_id: v.corretor_id,
    evento: {
      summary: `${v.status === "confirmada" ? "✅ " : ""}${rotulo} ${i.referencia ?? ""}${v.cliente_nome ? ` · ${v.cliente_nome}` : ""}`.replace(/\s+/g, " "),
      location: endereco || undefined,
      description: [
        v.cliente_nome ? `${v.tipo === "captacao" ? "Proprietário" : "Cliente"}: ${v.cliente_nome}${v.cliente_telefone ? ` · ${v.cliente_telefone}` : ""}` : null,
        v.tipo === "aluguel" ? `Visita ${v.tipo_visita === "sozinha" ? "sozinha (cliente vai sem corretor)" : "acompanhada (com corretor)"}` : null,
        i.titulo ? `Imóvel: ${i.titulo}` : null,
        v.observacoes ? `Observações: ${v.observacoes}` : null,
        `Agenda no painel: ${PAINEL}/#agenda`,
      ].filter(Boolean).join("\n"),
      start: { dateTime: v.inicio, timeZone: FUSO },
      end: { dateTime: v.fim, timeZone: FUSO },
      extendedProperties: { private: { lfg: `visita:${v.id}` } },
    },
  }];
}

// Deixa o Google igual ao sistema: cria, atualiza ou apaga o evento de cada pessoa.
async function sincronizar(origem: string, id: string) {
  const desejados = await eventosDesejados(origem, id);
  const existentes = exigir(
    await banco.from("google_eventos").select("corretor_id, evento_id").eq("origem", origem).eq("origem_id", id),
    "ler eventos",
  ) as { corretor_id: string; evento_id: string }[];
  const pessoas = [...new Set([...desejados.map((d) => d.corretor_id), ...existentes.map((e) => e.corretor_id)])];
  if (!pessoas.length) return { feitos: 0 };
  const conexoes = new Map(
    (exigir(await banco.from("google_conexoes").select("*").in("corretor_id", pessoas), "ler conexões") as Conexao[]).map((c) => [c.corretor_id, c]),
  );
  const resultado: string[] = [];
  for (const pessoa of pessoas) {
    const conexao = conexoes.get(pessoa);
    const desejado = desejados.find((d) => d.corretor_id === pessoa);
    const existente = existentes.find((e) => e.corretor_id === pessoa);
    try {
      if (!conexao) {
        if (existente) await banco.from("google_eventos").delete().match({ origem, origem_id: id, corretor_id: pessoa });
        continue;
      }
      if (!desejado) {
        if (existente) {
          await chamarAgenda(conexao, "DELETE", `/${encodeURIComponent(existente.evento_id)}`);
          await banco.from("google_eventos").delete().match({ origem, origem_id: id, corretor_id: pessoa });
          resultado.push("apagado");
        }
        continue;
      }
      if (existente) {
        try {
          await chamarAgenda(conexao, "PUT", `/${encodeURIComponent(existente.evento_id)}`, desejado.evento);
          await banco.from("google_eventos").update({ atualizado_em: new Date().toISOString() }).match({ origem, origem_id: id, corretor_id: pessoa });
          resultado.push("atualizado");
          continue;
        } catch (erro) {
          // Apagado à mão no Google: cria de novo.
          if (![404, 410].includes((erro as { status?: number }).status ?? 0)) throw erro;
        }
      }
      const criado = await chamarAgenda(conexao, "POST", "", desejado.evento);
      await banco.from("google_eventos").upsert({ origem, origem_id: id, corretor_id: pessoa, evento_id: String(criado?.id), atualizado_em: new Date().toISOString() });
      resultado.push("criado");
    } catch (erro) {
      if (!(erro instanceof ReconectarError)) console.error("Google Agenda", origem, id, erro instanceof Error ? erro.message : erro);
      resultado.push("falhou");
    }
  }
  return { resultado };
}

// Ao conectar: leva para a agenda o que já está marcado daqui para frente.
async function levarOQueJaExiste(corretorId: string) {
  const desde = new Date(Date.now() - 86_400_000).toISOString();
  const { data: demandas } = await banco.from("demandas").select("id").eq("responsavel_id", corretorId).neq("status", "concluida").gte("prazo", desde).limit(200);
  const { data: visitas } = await banco.from("visitas").select("id").eq("corretor_id", corretorId).in("status", ["agendada", "confirmada"]).gte("inicio", desde).limit(200);
  for (const d of demandas ?? []) await sincronizar("demanda", d.id);
  for (const v of visitas ?? []) await sincronizar("visita", v.id);
}

// --- Conectar, voltar do Google, desconectar ---------------------------------

async function conectar(quem: { id: string }) {
  const { id } = credenciais();
  const estado = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  await banco.from("google_estados").delete().lt("criado_em", new Date(Date.now() - 15 * 60_000).toISOString());
  exigir(await banco.from("google_estados").insert({ estado, corretor_id: quem.id }), "guardar pedido");
  const endereco = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  endereco.search = new URLSearchParams({
    client_id: id, redirect_uri: RETORNO, response_type: "code", scope: ESCOPO,
    access_type: "offline", prompt: "consent", include_granted_scopes: "true", state: estado,
  }).toString();
  return { endereco: endereco.toString() };
}

function voltarAoPainel(papel: string | null, situacao: string) {
  const tela = papel === "corretor" ? "perfil" : "configuracoes";
  return new Response(null, { status: 302, headers: { Location: `${PAINEL}/?google=${situacao}#${tela}` } });
}

async function retorno(url: URL) {
  const codigo = url.searchParams.get("code");
  const estado = url.searchParams.get("state") ?? "";
  const { data: pedido } = await banco.from("google_estados").select("corretor_id, criado_em").eq("estado", estado).maybeSingle();
  if (estado) await banco.from("google_estados").delete().eq("estado", estado);
  const { data: pessoa } = pedido ? await banco.from("corretores").select("papel").eq("id", pedido.corretor_id).maybeSingle() : { data: null };
  const papel = pessoa?.papel ?? null;
  if (!pedido || Date.now() - new Date(pedido.criado_em).getTime() > 15 * 60_000) return voltarAoPainel(papel, "expirou");
  if (!codigo) return voltarAoPainel(papel, "cancelado");
  try {
    const token = await pedirToken({ grant_type: "authorization_code", code: codigo, redirect_uri: RETORNO });
    if (!String(token.scope ?? "").includes("calendar.events")) return voltarAoPainel(papel, "sem-permissao");
    if (!token.refresh_token) return voltarAoPainel(papel, "falhou");
    // A agenda principal tem como id o e-mail da conta.
    const info = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary", { headers: { Authorization: `Bearer ${token.access_token}` } })
      .then((r) => (r.ok ? r.json() : {})).catch(() => ({})) as { id?: string };
    exigir(await banco.from("google_conexoes").upsert({
      corretor_id: pedido.corretor_id,
      email: info.id ?? null,
      refresh_token: String(token.refresh_token),
      access_token: String(token.access_token),
      expira_em: new Date(Date.now() + Number(token.expires_in ?? 3600) * 1000).toISOString(),
      conectado_em: new Date().toISOString(),
      erro: null,
    }), "guardar conexão");
    // @ts-ignore EdgeRuntime existe no Supabase
    EdgeRuntime.waitUntil(levarOQueJaExiste(pedido.corretor_id).catch((e: unknown) => console.error("Levar eventos", e)));
    return voltarAoPainel(papel, "conectado");
  } catch (erro) {
    console.error("Retorno do Google", erro instanceof Error ? erro.message : erro);
    return voltarAoPainel(papel, "falhou");
  }
}

async function desconectar(quem: { id: string }) {
  const { data: conexao } = await banco.from("google_conexoes").select("*").eq("corretor_id", quem.id).maybeSingle();
  if (!conexao) return { ok: true };
  const eventos = exigir(await banco.from("google_eventos").select("origem, origem_id, evento_id").eq("corretor_id", quem.id), "ler eventos") as
    { origem: string; origem_id: string; evento_id: string }[];
  for (const e of eventos) {
    try {
      await chamarAgenda(conexao as Conexao, "DELETE", `/${encodeURIComponent(e.evento_id)}`);
    } catch {
      // conta já sem acesso: segue
    }
  }
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(conexao.refresh_token)}`, { method: "POST" }).catch(() => null);
  await banco.from("google_eventos").delete().eq("corretor_id", quem.id);
  await banco.from("google_conexoes").delete().eq("corretor_id", quem.id);
  return { ok: true, apagados: eventos.length };
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname.endsWith("/retorno")) return retorno(url);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json({ erro: "Use POST." }, 405);

  const corpo = await req.json().catch(() => ({})) as { acao?: string; origem?: string; id?: string };
  try {
    if (corpo.acao === "sincronizar") {
      if (!(await confereChave("avisos", req.headers.get("x-avisos-chave")))) return json({ erro: "Chave inválida." }, 401);
      if (!["demanda", "visita"].includes(corpo.origem ?? "") || !corpo.id) return json({ erro: "Pedido inválido." }, 400);
      return json(await sincronizar(corpo.origem!, corpo.id));
    }
    if (corpo.acao === "configurado") {
      if (!(await confereChave("simulador", req.headers.get("x-simulador-chave")))) return json({ erro: "Chave inválida." }, 401);
      return json({ client_id: Boolean(Deno.env.get("GOOGLE_CLIENT_ID")?.trim()), client_secret: Boolean(Deno.env.get("GOOGLE_CLIENT_SECRET")?.trim()) });
    }
    const quem = await quemChama(req);
    if (!quem) return new Response(JSON.stringify({ erro: "Entre no painel de novo." }), { status: 401, headers: { ...cors(req), "Content-Type": "application/json" } });
    const resposta = corpo.acao === "conectar" ? await conectar(quem) : corpo.acao === "desconectar" ? await desconectar(quem) : null;
    if (!resposta) return new Response(JSON.stringify({ erro: "Ação desconhecida." }), { status: 400, headers: { ...cors(req), "Content-Type": "application/json" } });
    return new Response(JSON.stringify(resposta), { headers: { ...cors(req), "Content-Type": "application/json" } });
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    console.error("google-agenda", mensagem);
    return new Response(JSON.stringify({ erro: mensagem }), { status: 500, headers: { ...cors(req), "Content-Type": "application/json" } });
  }
});
