// Ferramenta interna para o número oficial na Meta.
//
// POST /functions/v1/whatsapp-numero
// Cabeçalho: x-simulador-chave
// Corpo: { "acao": "situacao" }
//        { "acao": "registrar", "pin": "123456" }      liga o número à Cloud API
//        { "acao": "assinar_avisos", "conta_id": "..." } conta do WhatsApp manda avisos ao app
//        { "acao": "criar_modelo_aviso", "conta_id": "..." } manda o modelo "novo_lead" para aprovação
//        { "acao": "criar_modelos_visita", "conta_id": "..." } manda os 3 modelos da agenda de visitas
//        { "acao": "criar_modelos_followup", "conta_id": "..." } manda os 5 modelos do follow-up da Thais
//        { "acao": "criar_modelo_retomar", "conta_id": "..." } manda o modelo "retomar_conversa" (follow-up com corretor)
//        { "acao": "modelos", "conta_id": "..." }  modelos da conta e a situação de cada um
//        { "acao": "conta", "conta_id": "..." }    conta do WhatsApp (moeda e revisão da Meta)
import { chaveInternaValida, json } from "../_shared/acesso.ts";
import { MODELO_NOVO_LEAD } from "../_shared/rodizio.ts";
import { MODELO_RETOMAR_CONVERSA, MODELOS_FOLLOWUP } from "../_shared/followup.ts";
import { MODELOS_DE_VISITA } from "../_shared/visitas.ts";
import { assinarAvisosDaConta, consultarConta, consultarNumero, criarModelo, listarModelos, registrarNumero } from "../_shared/whatsapp.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ erro: "Use POST." }, 405);
  if (!(await chaveInternaValida(req))) return json({ erro: "Chave inválida." }, 401);

  const corpo = await req.json().catch(() => ({})) as { acao?: string; pin?: string; conta_id?: string };
  try {
    switch (corpo.acao) {
      case "situacao":
        return json(await consultarNumero());
      case "registrar":
        if (!/^[0-9]{6}$/.test(corpo.pin ?? "")) return json({ erro: "O PIN precisa ter 6 dígitos." }, 400);
        return json(await registrarNumero(corpo.pin!));
      case "assinar_avisos":
      case "criar_modelo_aviso":
      case "criar_modelos_visita":
      case "criar_modelos_followup":
      case "criar_modelo_retomar":
      case "modelos":
      case "conta": {
        if (!/^[0-9]+$/.test(corpo.conta_id ?? "")) return json({ erro: "Informe o ID da conta do WhatsApp (só números)." }, 400);
        if (corpo.acao === "assinar_avisos") return json(await assinarAvisosDaConta(corpo.conta_id!));
        if (corpo.acao === "criar_modelo_aviso") return json(await criarModelo(corpo.conta_id!, MODELO_NOVO_LEAD));
        if (corpo.acao === "criar_modelo_retomar") return json(await criarModelo(corpo.conta_id!, MODELO_RETOMAR_CONVERSA));
        if (corpo.acao === "criar_modelos_visita" || corpo.acao === "criar_modelos_followup") {
          const resultado: Record<string, unknown> = {};
          for (const modelo of corpo.acao === "criar_modelos_visita" ? MODELOS_DE_VISITA : MODELOS_FOLLOWUP) {
            resultado[modelo.name] = await criarModelo(corpo.conta_id!, modelo).catch((e) => ({ erro: e instanceof Error ? e.message : String(e) }));
          }
          return json(resultado);
        }
        if (corpo.acao === "conta") return json(await consultarConta(corpo.conta_id!));
        return json(await listarModelos(corpo.conta_id!));
      }
      default:
        return json({ erro: "Ação desconhecida. Use situacao, registrar, assinar_avisos, criar_modelo_aviso, criar_modelos_visita, criar_modelos_followup, criar_modelo_retomar, modelos ou conta." }, 400);
    }
  } catch (erro) {
    return json({ erro: erro instanceof Error ? erro.message : String(erro) }, 502);
  }
});
