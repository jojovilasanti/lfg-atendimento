// Imagens públicas do site (bucket "site"): banners, fotos e plantas dos
// empreendimentos. Até 5 MB por imagem, em JPG, PNG ou WebP.
import { exigir, supabase } from "./supabase.js";

export const LIMITE_IMAGEM_DO_SITE = 5 * 1024 * 1024;
const TIPOS = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

export async function enviarImagemDoSite(arquivo, pasta) {
  if (!TIPOS[arquivo.type]) throw new Error(`${arquivo.name}: envie a imagem em JPG, PNG ou WebP.`);
  if (arquivo.size > LIMITE_IMAGEM_DO_SITE) throw new Error(`${arquivo.name}: a imagem precisa ter até 5 MB.`);
  const caminho = `${pasta}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${TIPOS[arquivo.type]}`;
  exigir(await supabase.storage.from("site").upload(caminho, arquivo, { contentType: arquivo.type }));
  return supabase.storage.from("site").getPublicUrl(caminho).data.publicUrl;
}
