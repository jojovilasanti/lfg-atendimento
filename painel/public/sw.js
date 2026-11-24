// Service worker do painel da LFG: mostra as notificações que o servidor manda
// (cliente respondeu, lead novo para o corretor), mesmo com o painel fechado ou
// minimizado, e abre o lead ao tocar.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (evento) => evento.waitUntil(self.clients.claim()));

self.addEventListener("push", (evento) => {
  let dados = {};
  try {
    dados = evento.data ? evento.data.json() : {};
  } catch {
    dados = { texto: evento.data ? evento.data.text() : "" };
  }
  evento.waitUntil(
    self.registration.showNotification(dados.titulo || "LFG Imóveis", {
      body: dados.texto || "",
      tag: dados.tag,
      renotify: Boolean(dados.tag),
      icon: "/icone-app-192.png",
      badge: "/icone-notificacao.png",
      data: { url: dados.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (evento) => {
  evento.notification.close();
  const destino = new URL(evento.notification.data?.url || "/", self.location.origin).href;
  evento.waitUntil((async () => {
    const janelas = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const aberta = janelas.find((janela) => new URL(janela.url).origin === self.location.origin);
    if (aberta) {
      // O painel já aberto só troca de tela (o endereço do lead fica no "#").
      aberta.postMessage({ abrir: destino });
      return aberta.focus();
    }
    return self.clients.openWindow(destino);
  })());
});
