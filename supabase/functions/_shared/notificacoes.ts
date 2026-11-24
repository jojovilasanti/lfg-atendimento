// Notificações do sistema (Web Push) para a equipe: chegam no celular ou no
// computador mesmo com o painel fechado ou minimizado. As chaves VAPID ficam no
// banco: a pública em configuracoes, a privada no Vault.
import webpush from "npm:web-push@3.6.7";
import { banco, exigir } from "./banco.ts";

const ASSUNTO = "https://srv2083149.hstgr.cloud";

// O que o service worker do painel (painel/public/sw.js) mostra.
export type Notificacao = { titulo: string; texto: string; url: string; tag: string };

type Inscricao = { id: string; endpoint: string; p256dh: string; auth: string };

// Na primeira vez gera o par de chaves; depois devolve sempre a mesma pública.
export async function chavePublicaPush(): Promise<string> {
  const atual = exigir(
    await banco.from("configuracoes").select("valor").eq("chave", "push_chave_publica").maybeSingle(),
    "ler chave pública das notificações",
  ) as { valor: string } | null;
  if (atual?.valor) return atual.valor;
  const novas = webpush.generateVAPIDKeys();
  return exigir(
    await banco.rpc("guardar_chaves_push", { p_publica: novas.publicKey, p_privada: novas.privateKey }),
    "guardar chaves das notificações",
  ) as string;
}

// Manda para todos os aparelhos em que essas pessoas ativaram as notificações.
// Devolve quantos o serviço de push aceitou.
export async function notificar(corretores: string[], notificacao: Notificacao): Promise<number> {
  const destinos = [...new Set(corretores.filter(Boolean))];
  if (!destinos.length) return 0;
  const inscricoes = exigir(
    await banco.from("push_inscricoes").select("id, endpoint, p256dh, auth").in("corretor_id", destinos),
    "ler inscrições das notificações",
  ) as Inscricao[];
  if (!inscricoes.length) return 0;

  const vapidDetails = {
    subject: ASSUNTO,
    publicKey: await chavePublicaPush(),
    privateKey: exigir(await banco.rpc("chave_privada_push"), "ler chave privada das notificações") as string,
  };
  const corpo = JSON.stringify(notificacao);
  const aceitas = await Promise.all(inscricoes.map(async (inscricao) => {
    const pedido = webpush.generateRequestDetails(
      { endpoint: inscricao.endpoint, keys: { p256dh: inscricao.p256dh, auth: inscricao.auth } },
      corpo,
      { vapidDetails, TTL: 3600, urgency: "high" },
    );
    try {
      const resposta = await fetch(pedido.endpoint, {
        method: "POST",
        headers: Object.fromEntries(Object.entries(pedido.headers).map(([nome, valor]) => [nome, String(valor)])),
        body: new Uint8Array(pedido.body),
        signal: AbortSignal.timeout(10_000),
      });
      await resposta.body?.cancel();
      if (resposta.status === 404 || resposta.status === 410) {
        // O navegador desfez a inscrição (limpou os dados, desinstalou o app...).
        await banco.from("push_inscricoes").delete().eq("id", inscricao.id);
        return false;
      }
      if (!resposta.ok) console.warn(`Notificação recusada pelo serviço de push (HTTP ${resposta.status}).`);
      return resposta.ok;
    } catch (erro) {
      console.warn("Notificação não saiu", erro);
      return false;
    }
  }));
  return aceitas.filter(Boolean).length;
}
