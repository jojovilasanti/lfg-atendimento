// Lembretes da agenda: notificação no celular do corretor 1 dia e 1 hora antes
// de cada compromisso (visita, captação, outro). O banco chama a cada 5 minutos
// (interno.chamar_lembretes) só quando há lembrete a mandar.
//
// POST /functions/v1/lembretes
// Cabeçalho: x-avisos-chave (o mesmo da função avisos)
import { confereChave, json } from "../_shared/acesso.ts";
import { banco, exigir } from "../_shared/banco.ts";
import { notificar } from "../_shared/notificacoes.ts";

const FUSO = "America/Campo_Grande";
const TIPO: Record<string, string> = { aluguel: "Visita (aluguel)", venda: "Visita (venda)", captacao: "Captação", outro: "Compromisso" };

type Visita = {
  id: string; tipo: string; inicio: string; criado_em: string; corretor_id: string; cliente_nome: string | null; local: string | null;
  lembrete_dia_em: string | null; lembrete_hora_em: string | null;
  imoveis: { referencia: string | null; bairro: string | null; endereco: string | null; numero: string | null } | null;
};

const hora = (iso: string) => new Intl.DateTimeFormat("pt-BR", { timeZone: FUSO, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
const dia = (iso: string) => new Intl.DateTimeFormat("pt-BR", { timeZone: FUSO, weekday: "long", day: "2-digit", month: "2-digit" }).format(new Date(iso));

function onde(v: Visita): string {
  const i = v.imoveis;
  if (i) return [i.referencia, i.bairro].filter(Boolean).join(" · ");
  return v.local ?? "";
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ erro: "Use POST." }, 405);
  if (!(await confereChave("avisos", req.headers.get("x-avisos-chave")))) return json({ erro: "Chave inválida." }, 401);

  const agora = Date.now();
  const visitas = exigir(
    await banco.from("visitas")
      .select("id, tipo, inicio, criado_em, corretor_id, cliente_nome, local, lembrete_dia_em, lembrete_hora_em, imoveis(referencia, bairro, endereco, numero)")
      .in("status", ["agendada", "confirmada"])
      .not("corretor_id", "is", null)
      .gt("inicio", new Date(agora).toISOString())
      .lte("inicio", new Date(agora + 24 * 3600_000).toISOString())
      .order("inicio"),
    "ler visitas",
  ) as unknown as Visita[];

  const enviados: string[] = [];
  for (const v of visitas) {
    const inicio = new Date(v.inicio).getTime();
    const criado = new Date(v.criado_em).getTime();
    const falta = inicio - agora;
    const local = onde(v);
    const quem = v.cliente_nome ? ` com ${v.cliente_nome.split(" ")[0]}` : "";

    let tipo: "dia" | "hora" | null = null;
    if (!v.lembrete_hora_em && falta <= 60 * 60_000 && inicio - criado >= 70 * 60_000) tipo = "hora";
    else if (!v.lembrete_dia_em && falta > 3 * 3600_000 && inicio - criado >= 20 * 3600_000) tipo = "dia";
    if (!tipo) continue;

    // Marca antes de mandar: se duas chamadas se cruzarem, só uma envia.
    const campo = tipo === "dia" ? "lembrete_dia_em" : "lembrete_hora_em";
    const { data: marcada } = await banco.from("visitas").update({ [campo]: new Date().toISOString() })
      .eq("id", v.id).is(campo, null).select("id");
    if (!marcada?.length) continue;

    const titulo = tipo === "dia"
      ? `Amanhã: ${TIPO[v.tipo] ?? "Compromisso"} às ${hora(v.inicio)}`
      : `Daqui a pouco: ${TIPO[v.tipo] ?? "Compromisso"} às ${hora(v.inicio)}`;
    const texto = [tipo === "dia" ? dia(v.inicio) : null, local, quem.trim() ? quem.trim() : null].filter(Boolean).join(" · ");
    const entregues = await notificar([v.corretor_id], { titulo, texto: texto || "Abra a agenda para ver os detalhes.", url: `/#agenda/visita/${v.id}`, tag: `lembrete-${tipo}-${v.id}` })
      .catch((erro) => {
        console.warn("Lembrete não saiu", erro);
        return 0;
      });
    enviados.push(`${v.id}:${tipo}:${entregues}`);
  }
  console.log(`Lembretes: ${enviados.length} enviados.`);
  return json({ ok: true, enviados });
});
