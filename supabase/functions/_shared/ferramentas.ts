import type Anthropic from "npm:@anthropic-ai/sdk@1.3.0";
import { banco, exigir, type Lead } from "./banco.ts";

// Tipos de imóvel que existem no Univen da LFG.
const TIPOS = ["CASA", "APARTAMENTO", "TERRENO", "CHACARA", "COMERCIAL", "BARRACAO", "GALPAO"];

export const FERRAMENTAS: Anthropic.Beta.BetaTool[] = [
  {
    name: "buscar_imoveis",
    description:
      "Busca imóveis ativos (disponíveis) no estoque da LFG, que espelha o Univen. Use para recomendar opções a partir do que o cliente quer. " +
      "Com região, traz o bairro ou a cidade pedida e a vizinhança num raio de 2,5 km. Com valor máximo, inclui opções até 15% acima e marca acima_do_orcamento. " +
      "Retorna no máximo 5 imóveis, com referência, valor, quartos, link do site e foto principal. Se vier vazio, tente de novo com menos filtros.",
    input_schema: {
      type: "object",
      properties: {
        finalidade: { type: "string", enum: ["venda", "locacao"], description: "venda para quem quer comprar; locacao para quem quer alugar." },
        tipo: { type: "string", enum: TIPOS, description: "Tipo de imóvel. Casa térrea ou sobrado = CASA; apê = APARTAMENTO; lote ou área = TERRENO; sala, salão ou ponto = COMERCIAL." },
        regiao: { type: "string", description: "Bairro ou cidade, do jeito que o cliente falou. Ex.: Rita Vieira, Centro, Terenos." },
        valor_maximo: { type: "number", description: "Orçamento máximo em reais (aluguel mensal na locação)." },
        valor_minimo: { type: "number", description: "Valor mínimo em reais, se o cliente indicar." },
        quartos_minimo: { type: "integer", description: "Quantidade mínima de quartos." },
        aceita_pet: { type: "boolean", description: "true quando o cliente precisa que o imóvel aceite animais." },
      },
      required: ["finalidade"],
    },
  },
  {
    name: "consultar_imovel",
    description:
      "Consulta um imóvel específico e confere na hora, no Univen, se a situação dele é Ativo (disponível). " +
      "Use sempre que o cliente perguntar por um imóvel específico e antes de confirmar que um imóvel está disponível. " +
      "Retorna os dados completos (valores, quartos, áreas, características, link, descrição) e o campo disponivel: true, false ou null (não foi possível verificar).",
    input_schema: {
      type: "object",
      properties: {
        busca: { type: "string", description: "Referência (ex.: CA00742), código do Univen (ex.: 79096099) ou o link do anúncio/site que o cliente enviou." },
      },
      required: ["busca"],
    },
  },
  {
    name: "atualizar_lead",
    description:
      "Registra na ficha do lead o que você aprendeu sobre o cliente. Chame sempre que descobrir algo novo. Quando for a única ferramenta da resposta, escreva antes o texto da mensagem ao cliente e chame esta ferramenta logo depois, na mesma resposta. " +
      "Envie só os campos que mudaram; os demais são mantidos.",
    input_schema: {
      type: "object",
      properties: {
        nome: { type: "string", description: "Nome do cliente." },
        interesse: { type: "string", enum: ["compra", "locacao", "administrativo", "outro"] },
        temperatura: { type: "string", enum: ["quente", "morno", "frio"] },
        imovel: { type: "string", description: "Referência ou código do imóvel de maior interesse." },
        resumo: { type: "string", description: "Resumo curto e atualizado do que o cliente procura. Sempre em português do Brasil, mesmo se a conversa for em inglês." },
        ficha: {
          type: "object",
          description: "Respostas da qualificação.",
          properties: {
            regiao: { type: "string", description: "Bairros ou regiões de interesse." },
            tipo_imovel: { type: "string" },
            orcamento_max: { type: "number", description: "Em reais." },
            orcamento_min: { type: "number", description: "Em reais." },
            quartos: { type: "integer" },
            forma_pagamento: { type: "string", description: "À vista, financiamento, FGTS, consórcio, permuta..." },
            urgencia: { type: "string", description: "Quando pretende se mudar ou fechar." },
            pet: { type: "boolean" },
            observacoes: { type: "string", description: "Outros requisitos ou informações úteis ao corretor." },
            respostas_campanha: {
              type: "object",
              description: "Só para clientes de uma campanha (vem no contexto): respostas da qualificação da campanha, com a pergunta resumida como chave (ex.: objetivo, construir_logo, financiar_construcao, tamanho_lote, pagamento).",
              additionalProperties: { type: "string" },
            },
            imovel_do_cliente: {
              type: "string",
              description: "Só quando o cliente é dono e quer anunciar o imóvel dele com a LFG: se quer vender ou alugar, tipo, bairro e cidade, valor pretendido e o que mais ele contar.",
            },
          },
        },
      },
    },
  },
  {
    name: "classificar_contato",
    description:
      "Triagem: diz se o contato é cliente da imobiliária ou não. Chame assim que tiver certeza, e sempre antes de passar_para_corretor. " +
      "cliente = quer comprar, alugar, vender ou anunciar imóvel (ou é cliente que já aluga/comprou com a LFG). " +
      "empresa = empresa ou prestador oferecendo produto ou serviço (marketing, sistemas, fotografia, material de construção, consórcio, crédito...). " +
      "outros = vaga de emprego, corretor de outra imobiliária propondo parceria, engano ou spam. " +
      "Empresa e outros saem do atendimento e vão para a lista Não clientes, sem corretor.",
    input_schema: {
      type: "object",
      properties: {
        categoria: { type: "string", enum: ["cliente", "empresa", "outros"] },
        motivo: { type: "string", description: "Em poucas palavras, o que a pessoa quer (ex.: 'agência oferecendo tráfego pago'). Em português." },
      },
      required: ["categoria"],
    },
  },
  {
    name: "passar_para_corretor",
    description:
      "Passa o atendimento para um corretor da LFG. Se o cliente tem um imóvel de interesse, o lead vai ao captador desse imóvel; sem imóvel, ao corretor de plantão do rodízio. " +
      "Por isso, registre antes com atualizar_lead (campo imovel) o imóvel que o cliente mais quer. O corretor recebe o resumo e tem um prazo para assumir; se não assumir, o lead vai para o rodízio. " +
      "Retorna a situação (oferecido, ja_oferecido, com_corretor ou sem_corretor_disponivel) e, das 22h às 8h, fora_do_horario: true (sem rodízio; o corretor responsável fala com o cliente quando o horário comercial começar).",
    input_schema: {
      type: "object",
      properties: {
        motivo: {
          type: "string",
          enum: ["pediu_atendente", "quer_visitar", "quer_negociar", "lead_quente", "ficha_completa", "seguro_fianca", "sem_opcoes", "quer_anunciar", "administrativo", "reclamacao", "duvida_especifica", "nao_verificado", "outro"],
        },
        resumo: { type: "string", description: "Resumo para o corretor: quem é, o que procura, imóveis de interesse, orçamento, pagamento, urgência e próximo passo. Sempre em português do Brasil; se a conversa foi em inglês, diga isso no resumo (o corretor precisa saber o idioma do cliente)." },
      },
      required: ["motivo", "resumo"],
    },
  },
];

type Entrada = Record<string, unknown>;

function texto(valor: unknown): string | null {
  return typeof valor === "string" && valor.trim() ? valor.trim() : null;
}

function numero(valor: unknown): number | null {
  return typeof valor === "number" && Number.isFinite(valor) ? valor : null;
}

export async function executarFerramenta(nome: string, entrada: Entrada, lead: Lead): Promise<unknown> {
  switch (nome) {
    case "buscar_imoveis": {
      const finalidade = entrada.finalidade === "locacao" ? "locacao" : "venda";
      const imoveis = exigir(
        await banco.rpc("ia_buscar_imoveis", {
          p_finalidade: finalidade,
          p_tipo: texto(entrada.tipo),
          p_regiao: texto(entrada.regiao),
          p_valor_max: numero(entrada.valor_maximo),
          p_valor_min: numero(entrada.valor_minimo),
          p_dormitorios_min: numero(entrada.quartos_minimo),
          p_aceita_pet: typeof entrada.aceita_pet === "boolean" ? entrada.aceita_pet : null,
          p_limite: 5,
        }),
        "buscar imóveis",
      );
      return { finalidade, total: (imoveis as unknown[]).length, imoveis };
    }

    case "consultar_imovel": {
      const busca = texto(entrada.busca);
      if (!busca) throw new Error("Informe a referência, o código ou o link do imóvel.");
      const imovel = exigir(await banco.rpc("ia_consultar_imovel", { p_busca: busca }), "consultar imóvel");
      const dados = imovel as { encontrado: boolean; codigo?: string };
      if (dados.encontrado && dados.codigo) {
        exigir(await banco.rpc("ia_atualizar_lead", { p_lead_id: lead.id, p_imovel: dados.codigo }), "registrar imóvel de interesse");
      }
      return imovel;
    }

    case "atualizar_lead": {
      // As respostas da campanha somam às já registradas, em vez de trocar.
      const ficha = typeof entrada.ficha === "object" && entrada.ficha !== null ? { ...(entrada.ficha as Record<string, unknown>) } : {};
      if (typeof ficha.respostas_campanha === "object" && ficha.respostas_campanha !== null) {
        const { data } = await banco.from("leads").select("ficha").eq("id", lead.id).single();
        const antes = ((data?.ficha ?? {}) as Record<string, unknown>).respostas_campanha;
        ficha.respostas_campanha = { ...(typeof antes === "object" && antes ? antes : {}), ...(ficha.respostas_campanha as Record<string, unknown>) };
      }
      entrada = { ...entrada, ficha };
      const atualizado = exigir(
        await banco.rpc("ia_atualizar_lead", {
          p_lead_id: lead.id,
          p_ficha: typeof entrada.ficha === "object" && entrada.ficha !== null ? entrada.ficha : {},
          p_nome: texto(entrada.nome),
          p_interesse: texto(entrada.interesse),
          p_temperatura: texto(entrada.temperatura),
          p_resumo: texto(entrada.resumo),
          p_imovel: texto(entrada.imovel),
        }),
        "atualizar lead",
      ) as Lead;
      return { ok: true, ficha: atualizado.ficha, interesse: atualizado.interesse, temperatura: atualizado.temperatura };
    }

    case "classificar_contato": {
      const categoria = texto(entrada.categoria) ?? "";
      const resultado = exigir(
        await banco.rpc("ia_classificar_contato", { p_lead_id: lead.id, p_categoria: categoria, p_motivo: texto(entrada.motivo) }),
        "classificar contato",
      ) as Record<string, unknown>;
      lead.categoria = (resultado.categoria as string) ?? lead.categoria;
      return resultado.lista === "nao_clientes"
        ? { ...resultado, proximo_passo: "Responda numa mensagem curta e educada que vai repassar ao setor responsável. Não faça mais perguntas nem passe ao corretor." }
        : resultado;
    }

    case "passar_para_corretor": {
      const motivo = texto(entrada.motivo) ?? "outro";
      // Quem chega ao corretor sem triagem é tratado como cliente.
      if (!lead.categoria) {
        await banco.rpc("ia_classificar_contato", { p_lead_id: lead.id, p_categoria: "cliente", p_motivo: null });
        lead.categoria = "cliente";
      }
      const resumo = texto(entrada.resumo);
      if (resumo) {
        exigir(await banco.rpc("ia_atualizar_lead", { p_lead_id: lead.id, p_resumo: resumo }), "salvar resumo");
      }
      const oferta = exigir(await banco.rpc("oferecer_lead", { p_lead_id: lead.id }), "oferecer lead") as Record<string, unknown>;
      exigir(
        await banco.from("mensagens").insert({
          lead_id: lead.id,
          autor: "sistema",
          conteudo: `IA passou o atendimento (${motivo}): ${oferta.situacao}${oferta.corretor_nome ? ` para ${oferta.corretor_nome}` : ""}`,
        }),
        "registrar passagem",
      );
      // O WhatsApp e o nome do corretor não vão para a IA. Das 22h às 8h não há
      // rodízio: a IA avisa o cliente do horário dos corretores.
      const periodo = exigir(await banco.rpc("periodo_de_atendimento"), "ler período") as { periodo: string } | null;
      return {
        // Sem o nome do corretor: a IA nunca diz ao cliente quem vai atender.
        situacao: oferta.situacao,
        ...(periodo?.periodo === "fora" ? { fora_do_horario: true } : {}),
      };
    }

    default:
      throw new Error(`Ferramenta desconhecida: ${nome}`);
  }
}
