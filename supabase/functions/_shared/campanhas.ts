// Campanhas da Thais (ex.: loteamento Atmosphere): base de conhecimento por
// campanha, editada pelo gestor no painel. O lead é reconhecido pelas palavras
// da campanha no anúncio ou na mensagem.
import { banco } from "./banco.ts";

// Campanhas da Thais (Configurações → Campanhas da Thais), guardadas por 1 minuto.
export type CampanhaIa = { id: string; nome: string; origem: string; palavras: string[]; base: string; perguntas: string[]; proibido: string; exemplo: string };
let campanhasGuardadas: { lista: CampanhaIa[]; ate: number } | null = null;
export async function campanhasAtivas(): Promise<CampanhaIa[]> {
  if (campanhasGuardadas && campanhasGuardadas.ate > Date.now()) return campanhasGuardadas.lista;
  const { data, error } = await banco.from("campanhas_ia").select("id, nome, origem, palavras, base, perguntas, proibido, exemplo").eq("ativo", true);
  if (error) {
    console.warn("Campanhas não lidas", error.message);
    return campanhasGuardadas?.lista ?? [];
  }
  campanhasGuardadas = { lista: (data ?? []) as CampanhaIa[], ate: Date.now() + 60_000 };
  return campanhasGuardadas.lista;
}
const semAcento = (texto: string) => texto.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

// A campanha cujas palavras aparecem no anúncio ou na mensagem do cliente.
export async function campanhaDaConversa(textos: (string | null | undefined)[]): Promise<CampanhaIa | null> {
  const junto = semAcento(textos.filter(Boolean).join(" "));
  if (!junto.trim()) return null;
  return (await campanhasAtivas()).find((c) => c.palavras.some((p) => junto.includes(semAcento(p)))) ?? null;
}
