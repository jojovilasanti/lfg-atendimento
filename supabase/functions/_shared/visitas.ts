// Alertas da agenda de visitas no WhatsApp do administrativo e dos gestores:
// três mensagens-modelo (UTILITY), uma por evento. Enquanto a Meta não aprova
// um modelo, o alerta tenta o texto livre (só chega se a pessoa falou com o
// número oficial nas últimas 24 horas).

const RODAPE = "Detalhes na Agenda de visitas do painel da LFG.";

// {{1}} imóvel, {{2}} endereço, {{3}} data e horário, {{4}} cliente (nome e
// telefone), {{5}} corretor responsável, {{6}} tipo de visita.
export const MODELO_VISITA_AGENDADA = {
  name: "visita_agendada",
  language: "pt_BR",
  category: "UTILITY",
  components: [{
    type: "BODY",
    text:
      "📅 Nova visita agendada na LFG Imóveis.\n\n" +
      "Imóvel: {{1}}\nEndereço: {{2}}\nData: {{3}}\nCliente: {{4}}\nCorretor: {{5}}\nTipo de visita: {{6}}\n\n" + RODAPE,
    example: { body_text: [["AP00123 · Apartamento no Centro", "Rua 14 de Julho, 1200, Centro", "sexta, 20/11 às 10:00", "Ana Souza, (67) 99999-0000", "Mariana", "acompanhada (com corretor)"]] },
  }],
};

// {{1}} imóvel, {{2}} endereço, {{3}} novo horário, {{4}} horário anterior,
// {{5}} cliente, {{6}} corretor, {{7}} tipo de visita.
export const MODELO_VISITA_REMARCADA = {
  name: "visita_remarcada",
  language: "pt_BR",
  category: "UTILITY",
  components: [{
    type: "BODY",
    text:
      "🔁 Visita remarcada na LFG Imóveis.\n\n" +
      "Imóvel: {{1}}\nEndereço: {{2}}\nNovo horário: {{3}}\nHorário anterior: {{4}}\nCliente: {{5}}\nCorretor: {{6}}\nTipo de visita: {{7}}\n\n" + RODAPE,
    example: { body_text: [["AP00123 · Apartamento no Centro", "Rua 14 de Julho, 1200, Centro", "sábado, 21/11 às 09:00", "sexta, 20/11 às 10:00", "Ana Souza, (67) 99999-0000", "Mariana", "sozinha (cliente vai sem corretor)"]] },
  }],
};

// {{1}} imóvel, {{2}} endereço, {{3}} horário, {{4}} cliente, {{5}} corretor,
// {{6}} quem cancelou e o motivo.
export const MODELO_VISITA_CANCELADA = {
  name: "visita_cancelada",
  language: "pt_BR",
  category: "UTILITY",
  components: [{
    type: "BODY",
    text:
      "❌ Visita cancelada na LFG Imóveis.\n\n" +
      "Imóvel: {{1}}\nEndereço: {{2}}\nHorário: {{3}}\nCliente: {{4}}\nCorretor: {{5}}\nCancelada por: {{6}}\n\n" + RODAPE,
    example: { body_text: [["AP00123 · Apartamento no Centro", "Rua 14 de Julho, 1200, Centro", "sexta, 20/11 às 10:00", "Ana Souza, (67) 99999-0000", "Mariana", "Joacyr (cliente desistiu)"]] },
  }],
};

export const MODELOS_DE_VISITA = [MODELO_VISITA_AGENDADA, MODELO_VISITA_REMARCADA, MODELO_VISITA_CANCELADA];

export const TIPO_DE_VISITA: Record<string, string> = {
  acompanhada: "acompanhada (com corretor)",
  sozinha: "sozinha (cliente vai sem corretor)",
};

// "sexta, 20/11 às 10:00" no fuso da empresa.
export function quandoDaVisita(iso: string, fuso = "America/Campo_Grande"): string {
  const d = new Date(iso);
  const dia = d.toLocaleDateString("pt-BR", { timeZone: fuso, weekday: "long" }).replace("-feira", "");
  const data = d.toLocaleDateString("pt-BR", { timeZone: fuso, day: "2-digit", month: "2-digit" });
  const hora = d.toLocaleTimeString("pt-BR", { timeZone: fuso, hour: "2-digit", minute: "2-digit" });
  return `${dia}, ${data} às ${hora}`;
}
