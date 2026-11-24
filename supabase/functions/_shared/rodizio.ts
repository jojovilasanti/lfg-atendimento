// Aviso de lead no WhatsApp do corretor: a mensagem-modelo "novo_lead"
// (aprovada pela Meta) e as respostas aos botões Assumir e Não posso agora.
// O lead vai primeiro ao captador do imóvel de interesse e, depois, ao rodízio.
import { telefoneLegivel } from "./telefone.ts";

export const ENDERECO_PAINEL = "https://lfg.jojodigitals.com";

// Variáveis: {{1}} nome do corretor, {{2}} origem ("do seu imóvel CA00720" ou
// "do rodízio de plantão"), {{3}} cliente, {{4}} resumo, {{5}} minutos para
// assumir. Os botões seguem a ordem: 0 = Assumir, 1 = Não posso agora.
export const MODELO_NOVO_LEAD = {
  name: "novo_lead",
  language: "pt_BR",
  category: "UTILITY",
  components: [
    {
      type: "BODY",
      text:
        "Olá, {{1}}! Você recebeu um novo lead {{2}} na LFG Imóveis.\n\n" +
        "Cliente: {{3}}\nResumo: {{4}}\n\n" +
        "Você tem {{5}} minutos para assumir. Depois disso, o lead passa para o rodízio de plantão.",
      example: {
        body_text: [[
          "Mariana",
          "do seu imóvel CA00720",
          "Ana Souza",
          "Quer comprar casa de 3 quartos no Rita Vieira, até R$ 500 mil, com financiamento.",
          "5",
        ]],
      },
    },
    {
      type: "BUTTONS",
      buttons: [
        { type: "QUICK_REPLY", text: "Assumir" },
        { type: "QUICK_REPLY", text: "Não posso agora" },
      ],
    },
  ],
};

// Código de cada botão no aviso: "assumir:<id da oferta>" ou "recusar:<id>".
export const botoesDaOferta = (atribuicaoId: string) => [`assumir:${atribuicaoId}`, `recusar:${atribuicaoId}`];
export const BOTAO_DA_OFERTA = /^(assumir|recusar):([0-9a-f-]{36})$/;

// A Meta não aceita quebra de linha nem espaços seguidos nas variáveis.
export function variavelDoModelo(texto: string, limite: number): string {
  const limpo = texto.replace(/\s+/g, " ").trim();
  return limpo.length > limite ? `${limpo.slice(0, limite - 1)}…` : limpo;
}

export type RespostaDaOferta = {
  situacao: "aceita" | "recusada" | "indisponivel" | "nao_encontrada";
  status?: string;
  proxima?: string;
  corretor_nome?: string;
  lead_id?: string;
  lead_nome?: string | null;
  lead_whatsapp?: string;
  resumo?: string | null;
};

// Texto que o corretor recebe depois de tocar no botão.
export function textoDaResposta(r: RespostaDaOferta): string {
  switch (r.situacao) {
    case "aceita":
      return [
        `Lead é seu, ${r.corretor_nome?.split(" ")[0] ?? "corretor"}! ✅`,
        "",
        `*Cliente:* ${r.lead_nome ?? "sem nome"} · ${telefoneLegivel(r.lead_whatsapp ?? "")}`,
        ...(r.resumo ? [`*Resumo:* ${r.resumo}`] : []),
        "",
        "A IA parou de responder esse cliente. Continue a conversa pelo painel, que fala pelo número oficial da LFG:",
        `${ENDERECO_PAINEL}/#leads/${r.lead_id}`,
      ].join("\n");
    case "recusada":
      return r.proxima === "oferecido"
        ? "Tudo certo, o lead foi passado para o próximo corretor de plantão."
        : "Tudo certo. Não há outro corretor de plantão agora; o lead fica aguardando no painel.";
    case "indisponivel":
      if (r.status === "aceita") return "Esse lead você já assumiu. Ele está no painel.";
      if (r.status === "expirada") return "O prazo desse lead acabou e ele passou para o próximo corretor.";
      return "Esse lead não está mais disponível para você.";
    default:
      return "Não encontrei esse lead para o seu número.";
  }
}
