// Follow-up da Thais quando o cliente para de responder: 5 mensagens-modelo
// (uma por etapa), usadas quando já passaram 23 horas da última mensagem do
// cliente. Dentro da janela, sai o texto da configuração como texto livre.
// O texto aprovado pela Meta é fixo: se o gestor mudar o texto no painel, só o
// envio livre muda.

export const TEXTOS_FOLLOWUP = [
  "Ainda não tive sua resposta. Quando quiser, estou aqui para te ajudar.",
  "O dia deve estar bem corrido, eu entendo. Mas sigo à disposição para te atender.",
  "Caso prefira conversar outro dia, é só me avisar qual o melhor momento para falarmos, ok?",
  "Não tive resposta. Talvez não seja o melhor momento para conversar.",
  "Como não conseguimos prosseguir, estou finalizando seu atendimento. Se precisar, a LFG Imóveis está à disposição.",
];

export const nomeDoModeloFollowup = (n: number) => `thais_followup_${n}`;

// A Meta classifica retomada de conversa como Marketing.
export const MODELOS_FOLLOWUP = TEXTOS_FOLLOWUP.map((texto, i) => ({
  name: nomeDoModeloFollowup(i + 1),
  language: "pt_BR",
  category: "MARKETING",
  components: [{ type: "BODY", text: texto }],
}));

// Janela de texto livre: 23 horas (1 hora de folga sobre as 24 da Meta).
export const JANELA_LIVRE_FOLLOWUP_MS = 23 * 3600 * 1000;
