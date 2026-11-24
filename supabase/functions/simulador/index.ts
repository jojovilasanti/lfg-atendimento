// Simulador de conversa: testa a IA sem WhatsApp. Cada "cliente" vira um lead
// separado com o número sim-<nome>, para nunca se misturar com leads reais.
//
// POST /functions/v1/simulador
// Cabeçalho: x-simulador-chave
// Corpo: { "cliente": "ana", "mensagem": "Oi!", "nome": "Ana" }
//        { "cliente": "ana", "midia_url": "https://...", "mensagem": "legenda (opcional)" }
//          foto, áudio ou PDF baixado do endereço, como se viesse pelo WhatsApp;
//          "midia_tipo" (ex.: "audio/ogg") corrige o tipo quando o site não informa
//        { "cliente": "ana", "reiniciar": true }  apaga a conversa simulada e os arquivos
//        { "cliente": "ana", "mensagem": "Oi", "simular_falha_ia": true }  testa o plano B (IA fora do ar)
//        { "cliente": "ana", "mensagem": "Olá! Posso ter mais informações sobre isso?", "anuncio": { "titulo": "...", "texto": "..." } }
//          como se viesse de um anúncio do Facebook/Instagram
import { chaveInternaValida, json } from "../_shared/acesso.ts";
import { type MidiaDoCliente, receberMensagemDoCliente } from "../_shared/atendimento.ts";
import { banco, exigir } from "../_shared/banco.ts";
import { transcreverAudio } from "../_shared/midia.ts";

async function midiaDeTeste(whatsapp: string, endereco: string, tipoInformado?: string): Promise<{ tipo: string; midia: MidiaDoCliente }> {
  const resposta = await fetch(endereco);
  if (!resposta.ok) throw new Error(`Mídia de teste não baixou (HTTP ${resposta.status}).`);
  const tipoArquivo = (tipoInformado ?? resposta.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim();
  const bytes = new Uint8Array(await resposta.arrayBuffer());
  const tipo = tipoArquivo.startsWith("image/") ? "image" : tipoArquivo.startsWith("audio/") ? "audio" : "document";
  return {
    tipo,
    midia: {
      tipo: tipoArquivo,
      preparar: async () => {
        const caminho = `${whatsapp}/${crypto.randomUUID()}`;
        exigir(await banco.storage.from("midias").upload(caminho, bytes, { contentType: tipoArquivo }), "guardar mídia de teste");
        return { caminho, tipo: tipoArquivo, texto: tipo === "audio" ? await transcreverAudio(bytes) : null };
      },
    },
  };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ erro: "Use POST." }, 405);
  if (!(await chaveInternaValida(req))) return json({ erro: "Chave do simulador inválida." }, 401);

  const corpo = await req.json().catch(() => null) as
    | {
      cliente?: string; mensagem?: string; nome?: string; midia_url?: string; midia_tipo?: string; reiniciar?: boolean; simular_falha_ia?: boolean;
      anuncio?: { titulo?: string; texto?: string };
    }
    | null;
  const cliente = String(corpo?.cliente ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40);
  if (!cliente) return json({ erro: "Envie { cliente, mensagem }." }, 400);
  const whatsapp = `sim-${cliente}`;

  if (corpo?.reiniciar) {
    exigir(await banco.from("leads").delete().eq("whatsapp", whatsapp), "apagar conversa simulada");
    const arquivos = exigir(await banco.storage.from("midias").list(whatsapp), "listar mídias de teste") as { name: string }[];
    if (arquivos.length) {
      exigir(await banco.storage.from("midias").remove(arquivos.map((a) => `${whatsapp}/${a.name}`)), "apagar mídias de teste");
    }
    return json({ ok: true, reiniciado: whatsapp });
  }
  if (!corpo?.mensagem?.trim() && !corpo?.midia_url) return json({ erro: "Envie { cliente, mensagem }." }, 400);

  try {
    const anexo = corpo.midia_url ? await midiaDeTeste(whatsapp, corpo.midia_url, corpo.midia_tipo) : null;
    const { lead, resultado } = await receberMensagemDoCliente({
      whatsapp,
      texto: corpo.mensagem?.trim() || null,
      tipo: anexo?.tipo,
      midia: anexo?.midia,
      nome: corpo.nome ?? null,
      origem: "simulador",
      simularFalhaDaIa: corpo.simular_falha_ia === true,
      ...(corpo.anuncio
        ? { anuncio: { titulo: corpo.anuncio.titulo ?? null, texto: corpo.anuncio.texto ?? null, tipo: "ad", id: null, url: null }, campanha: corpo.anuncio.titulo ?? null }
        : {}),
    });
    return json({
      respostas: resultado?.respostas ?? [],
      ia_ativa: lead.ia_ativa,
      lead: {
        status: lead.status,
        temperatura: lead.temperatura,
        interesse: lead.interesse,
        imovel: lead.imovel_codigo,
        ficha: lead.ficha,
        resumo: lead.resumo,
      },
      ferramentas: resultado?.ferramentas ?? [],
      parada: resultado?.parada ?? null,
      chamadas: resultado?.chamadas ?? 0,
      uso: resultado?.uso ?? null,
    });
  } catch (erro) {
    console.error(erro);
    return json({ erro: erro instanceof Error ? erro.message : String(erro) }, 500);
  }
});
