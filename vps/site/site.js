// Site da imobiliária: a busca da página inicial e os filtros das listas.
// Sem JavaScript o site continua funcionando, com todos os imóveis à vista.
(() => {
  const POR_PAGINA = 24;

  // Página inicial: "Comprar" e "Alugar" mudam para onde a busca leva.
  document.documentElement.classList.add("js");
  const semMovimento = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Menu do celular: abre por cima da página e fecha com Esc, toque num link ou fora.
  const topo = document.querySelector("[data-topo]");
  const botaoMenu = document.querySelector("[data-menu]");
  if (topo && botaoMenu) {
    // O menu aberto tem fundo escuro: a logo colorida dá lugar à branca.
    const logo = topo.querySelector("[data-logo-branca]");
    const logoOriginal = logo?.getAttribute("src");
    const trocarLogo = () => {
      if (!logo) return;
      const escuro = topo.classList.contains("menu-aberto") || topo.classList.contains("sobre-capa");
      logo.src = escuro ? logo.dataset.logoBranca : logoOriginal;
    };
    const abrir = (aberto) => {
      topo.classList.toggle("menu-aberto", aberto);
      trocarLogo();
      document.body.classList.toggle("sem-rolagem", aberto);
      botaoMenu.setAttribute("aria-expanded", String(aberto));
      botaoMenu.querySelector(".invisivel").textContent = aberto ? "Fechar o menu" : "Abrir o menu";
    };
    botaoMenu.addEventListener("click", () => abrir(!topo.classList.contains("menu-aberto")));
    topo.querySelector(".menu-principal")?.addEventListener("click", (evento) => {
      if (evento.target.closest("a")) abrir(false);
    });
    document.addEventListener("keydown", (evento) => {
      if (evento.key === "Escape" && topo.classList.contains("menu-aberto")) {
        abrir(false);
        botaoMenu.focus();
      }
    });
    matchMedia("(min-width: 901px)").addEventListener?.("change", (m) => m.matches && abrir(false));
  }

  // Topo da página inicial: fica transparente sobre a foto e ganha fundo ao rolar.
  if (topo?.classList.contains("sobre-capa")) {
    const marcar = () => topo.classList.toggle("rolou", scrollY > 40);
    addEventListener("scroll", marcar, { passive: true });
    marcar();
  }

  // Título da capa surgindo palavra por palavra.
  const revelar = document.querySelector("[data-revelar]");
  if (revelar && !semMovimento) {
    const palavras = revelar.textContent.trim().split(/\s+/);
    revelar.textContent = "";
    palavras.forEach((palavra, n) => {
      const span = document.createElement("span");
      span.className = "palavra";
      span.style.animationDelay = `${120 + n * 80}ms`;
      span.textContent = palavra;
      revelar.append(span, n < palavras.length - 1 ? " " : "");
    });
  }

  // Blocos que sobem ao aparecer na tela e números que contam até o valor.
  const contar = (el) => {
    const alvo = Number(el.dataset.contar) || 0;
    if (semMovimento || alvo < 2) return;
    const inicio = performance.now();
    const passo = (agora) => {
      const p = Math.min((agora - inicio) / 1200, 1);
      el.textContent = Math.round(alvo * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(passo);
    };
    el.textContent = "0";
    requestAnimationFrame(passo);
  };
  if ("IntersectionObserver" in window) {
    const observador = new IntersectionObserver((itens) => {
      for (const item of itens) {
        if (!item.isIntersecting) continue;
        observador.unobserve(item.target);
        if (item.target.dataset.contar) contar(item.target);
        else item.target.classList.add("visivel");
      }
    }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" });
    document.querySelectorAll(".grade-imoveis .sobe").forEach((el, n) => (el.style.transitionDelay = `${(n % 3) * 90}ms`));
    document.querySelectorAll(".sobe, [data-contar]").forEach((el) => observador.observe(el));
  } else {
    document.querySelectorAll(".sobe").forEach((el) => el.classList.add("visivel"));
  }

  const busca = document.querySelector("[data-busca]");
  if (busca) {
    const valores = busca.dataset.valores ? JSON.parse(busca.dataset.valores) : null;
    busca.addEventListener("change", (evento) => {
      if (evento.target.name !== "finalidade") return;
      busca.action = evento.target.value;
      // Valores de compra e de aluguel são bem diferentes: troca a lista do "Até".
      const tipoValor = evento.target.dataset.tipoValor;
      if (valores && busca.elements.valor && valores[tipoValor]) busca.elements.valor.innerHTML = valores[tipoValor];
    });
    busca.addEventListener("submit", () => {
      for (const campo of busca.querySelectorAll("[name=finalidade]")) campo.disabled = true;
      for (const campo of [busca.elements.tipo, busca.elements.bairro, busca.elements.valor]) if (campo && !campo.value) campo.disabled = true;
      setTimeout(() => {
        for (const campo of busca.querySelectorAll("[disabled]")) campo.disabled = false;
      });
    });
  }

  // Clique no WhatsApp de um imóvel: avisa o corretor responsável. O código do
  // navegador é anônimo e só serve para não avisar duas vezes a mesma pessoa.
  // A chave é a pública do projeto (a mesma do gerador): só registra o clique.
  const API = "https://nlbonjxmzmwsyuirxnzu.supabase.co/rest/v1/rpc/registrar_clique_whatsapp";
  const CHAVE_PUBLICA = "sb_publishable_oKbJ2oePBC6Lc916feMfSQ_qlsizS69";
  const visitante = () => {
    try {
      let codigo = localStorage.getItem("lfg-visitante");
      if (!codigo) {
        codigo = crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        localStorage.setItem("lfg-visitante", codigo);
      }
      return codigo;
    } catch {
      return null;
    }
  };
  document.addEventListener("click", (evento) => {
    const link = evento.target.closest?.("[data-clique]");
    if (!link) return;
    try {
      fetch(API, {
        method: "POST",
        keepalive: true,
        headers: { "Content-Type": "application/json", apikey: CHAVE_PUBLICA },
        body: JSON.stringify({ p_referencia: link.dataset.clique, p_visitante: visitante() }),
      }).catch(() => {});
    } catch {
      // o WhatsApp abre do mesmo jeito
    }
  });

  // Fotos do imóvel: as setas só aparecem com JavaScript; no celular, é só deslizar.
  const galeria = document.querySelector("[data-galeria]");
  if (galeria && galeria.children.length > 1) {
    for (const seta of document.querySelectorAll("[data-seta]")) {
      seta.hidden = false;
      seta.addEventListener("click", () => {
        const foto = galeria.firstElementChild;
        galeria.scrollBy({ left: Number(seta.dataset.seta) * (foto.clientWidth + 8), behavior: "smooth" });
      });
    }
  }

  // Descrição longa começa recolhida; o botão abre e fecha.
  const descricao = document.querySelector("[data-descricao]");
  const lerMais = document.querySelector("[data-ler-mais]");
  if (descricao && lerMais) {
    lerMais.hidden = false;
    lerMais.addEventListener("click", () => {
      const aberta = descricao.classList.toggle("fechada") === false;
      lerMais.setAttribute("aria-expanded", String(aberta));
      lerMais.textContent = aberta ? "Mostrar menos" : "Ler a descrição completa";
    });
  }

  // Foto em tela cheia: abre por cima da página, inteira, com setas, teclado e deslizar.
  if (galeria && typeof HTMLDialogElement === "function") {
    const quadros = [...galeria.querySelectorAll(".foto-galeria")];
    const caixa = document.createElement("dialog");
    caixa.className = "tela-cheia";
    caixa.setAttribute("aria-label", "Fotos do imóvel em tela cheia");
    caixa.innerHTML = `
      <div class="tela-cheia-palco"><span class="tela-cheia-foto"></span></div>
      <p class="tela-cheia-contagem" aria-live="polite"></p>
      <button class="tela-cheia-fechar" type="button" aria-label="Fechar">✕</button>
      <button class="seta anterior" type="button" aria-label="Foto anterior">‹</button>
      <button class="seta proxima" type="button" aria-label="Próxima foto">›</button>`;
    document.body.append(caixa);
    const lugar = caixa.querySelector(".tela-cheia-foto");
    const contagem = caixa.querySelector(".tela-cheia-contagem");
    const [anterior, proxima] = caixa.querySelectorAll(".seta");
    let atual = 0;

    const mostrar = (n) => {
      atual = (n + quadros.length) % quadros.length;
      const original = quadros[atual];
      const foto = original.querySelector("img:not(.marca-dagua)");
      const marca = original.querySelector(".marca-dagua");
      lugar.replaceChildren();
      const grande = document.createElement("img");
      grande.src = foto.currentSrc || foto.src;
      grande.alt = foto.alt;
      lugar.append(grande);
      if (marca) lugar.append(marca.cloneNode());
      contagem.textContent = `${atual + 1} de ${quadros.length}`;
      // Deixa a próxima já carregada.
      const seguinte = quadros[(atual + 1) % quadros.length]?.querySelector("img:not(.marca-dagua)");
      if (seguinte) new Image().src = seguinte.currentSrc || seguinte.src;
    };
    const abrir = (n) => {
      mostrar(n);
      caixa.showModal();
      document.documentElement.classList.add("sem-rolagem");
    };
    caixa.addEventListener("close", () => {
      document.documentElement.classList.remove("sem-rolagem");
      quadros[atual]?.scrollIntoView({ block: "nearest", inline: "start" });
    });

    anterior.hidden = proxima.hidden = quadros.length < 2;
    anterior.addEventListener("click", () => mostrar(atual - 1));
    proxima.addEventListener("click", () => mostrar(atual + 1));
    caixa.querySelector(".tela-cheia-fechar").addEventListener("click", () => caixa.close());
    // Clique fora da foto fecha.
    caixa.addEventListener("click", (evento) => {
      if (evento.target === caixa || evento.target.classList.contains("tela-cheia-palco")) caixa.close();
    });
    caixa.addEventListener("keydown", (evento) => {
      if (evento.key === "ArrowLeft") mostrar(atual - 1);
      if (evento.key === "ArrowRight") mostrar(atual + 1);
    });
    let inicioX = null;
    caixa.addEventListener("touchstart", (evento) => { inicioX = evento.touches[0].clientX; }, { passive: true });
    caixa.addEventListener("touchend", (evento) => {
      if (inicioX === null) return;
      const distancia = evento.changedTouches[0].clientX - inicioX;
      inicioX = null;
      if (Math.abs(distancia) > 40) mostrar(atual + (distancia < 0 ? 1 : -1));
    });

    quadros.forEach((quadro, n) => {
      quadro.tabIndex = 0;
      quadro.setAttribute("role", "button");
      quadro.setAttribute("aria-label", `Ampliar foto ${n + 1} de ${quadros.length}`);
      quadro.addEventListener("click", () => abrir(n));
      quadro.addEventListener("keydown", (evento) => {
        if (evento.key === "Enter" || evento.key === " ") {
          evento.preventDefault();
          abrir(n);
        }
      });
    });
    const botaoAmpliar = document.querySelector("[data-ampliar]");
    if (botaoAmpliar && quadros.length) {
      botaoAmpliar.hidden = false;
      // Abre na foto que está à vista na galeria.
      botaoAmpliar.addEventListener("click", () => {
        const largura = quadros[0].clientWidth + 8;
        abrir(Math.round(galeria.scrollLeft / largura));
      });
    }
  }

  // Equipe em carrossel: 4 por vez (2 no celular), anda 2 a cada 5 s, em loop.
  // O loop usa três cópias da fileira: quando passa do meio, volta uma volta inteira
  // sem animação, e o salto não aparece.
  for (const carrossel of document.querySelectorAll("[data-carrossel]")) {
    const janela = carrossel.querySelector(".carrossel-janela");
    const trilho = carrossel.querySelector(".carrossel-trilho");
    const originais = [...trilho.children];
    const total = originais.length;
    const PASSO = 2;
    const INTERVALO_MS = 5000;
    const celular = window.matchMedia("(max-width: 640px)");
    const semAnimacao = window.matchMedia("(prefers-reduced-motion: reduce)");
    const copiar = () => originais.map((item) => {
      const copia = item.cloneNode(true);
      copia.setAttribute("aria-hidden", "true");
      copia.classList.add("copia");
      return copia;
    });
    trilho.prepend(...copiar());
    trilho.append(...copiar());
    carrossel.classList.add("ativo");
    for (const seta of carrossel.querySelectorAll("[data-carrossel-seta]")) seta.hidden = false;

    let posicao = total;
    let relogio = null;
    let parado = false;

    const deslocamento = () => {
      const primeiro = trilho.children[0];
      const vao = parseFloat(getComputedStyle(trilho).columnGap) || 0;
      return primeiro.getBoundingClientRect().width + vao;
    };
    const mostrar = (animar) => {
      trilho.style.transition = animar && !semAnimacao.matches ? "" : "none";
      trilho.style.transform = `translateX(${-posicao * deslocamento()}px)`;
    };
    const acertarVolta = () => {
      if (posicao >= total * 2) posicao -= total;
      else if (posicao < total) posicao += total;
      else return;
      mostrar(false);
    };
    const andar = (sentido) => {
      acertarVolta();
      // Força o navegador a aplicar a posição sem animação antes de animar de novo.
      void trilho.offsetWidth;
      posicao += sentido * PASSO;
      mostrar(true);
    };
    trilho.addEventListener("transitionend", acertarVolta);

    const parar = () => {
      clearInterval(relogio);
      relogio = null;
    };
    const tocar = () => {
      parar();
      if (!parado && !document.hidden && !semAnimacao.matches) relogio = setInterval(() => andar(1), INTERVALO_MS);
    };

    for (const seta of carrossel.querySelectorAll("[data-carrossel-seta]")) {
      seta.addEventListener("click", () => {
        andar(Number(seta.dataset.carrosselSeta));
        tocar();
      });
    }
    // Mouse em cima ou teclado nas setas: pausa.
    carrossel.addEventListener("mouseenter", () => { parado = true; parar(); });
    carrossel.addEventListener("mouseleave", () => { parado = false; tocar(); });
    carrossel.addEventListener("focusin", () => { parado = true; parar(); });
    carrossel.addEventListener("focusout", (evento) => {
      if (!carrossel.contains(evento.relatedTarget)) { parado = false; tocar(); }
    });
    document.addEventListener("visibilitychange", tocar);

    // Arrastar com o dedo: a fileira acompanha e, ao soltar, anda 2 para o lado.
    let inicioX = null;
    let arrasto = 0;
    janela.addEventListener("touchstart", (evento) => {
      acertarVolta();
      inicioX = evento.touches[0].clientX;
      arrasto = 0;
      parar();
      trilho.style.transition = "none";
    }, { passive: true });
    janela.addEventListener("touchmove", (evento) => {
      if (inicioX === null) return;
      arrasto = evento.touches[0].clientX - inicioX;
      trilho.style.transform = `translateX(${-posicao * deslocamento() + arrasto}px)`;
    }, { passive: true });
    janela.addEventListener("touchend", () => {
      if (inicioX === null) return;
      inicioX = null;
      if (Math.abs(arrasto) > 40) {
        posicao += arrasto < 0 ? PASSO : -PASSO;
        mostrar(true);
      } else {
        mostrar(true);
      }
      tocar();
    });

    const reposicionar = () => mostrar(false);
    window.addEventListener("resize", reposicionar);
    celular.addEventListener?.("change", reposicionar);
    mostrar(false);
    tocar();
  }

  // Banners da página inicial: sem JavaScript é uma faixa que desliza de lado.
  // Com ele, passa sozinho a cada 6 s (para com o mouse em cima, com o teclado
  // nos controles e quando a pessoa prefere menos animação) e ganha setas e pontos.
  const banners = document.querySelector("[data-banners]");
  if (banners) {
    const trilho = banners.querySelector(".banners-trilho");
    const slides = [...trilho.children];
    const pontos = [...banners.querySelectorAll("[data-banner-ponto]")];
    const semAnimacao = window.matchMedia("(prefers-reduced-motion: reduce)");
    let atual = 0;
    let relogio = null;
    let parado = false;
    const ir = (n, suave = true) => {
      atual = (n + slides.length) % slides.length;
      trilho.scrollTo({ left: slides[atual].offsetLeft, behavior: suave && !semAnimacao.matches ? "smooth" : "auto" });
    };
    const marcar = () => {
      atual = Math.round(trilho.scrollLeft / (trilho.clientWidth || 1));
      pontos.forEach((ponto, n) => ponto.setAttribute("aria-current", n === atual ? "true" : "false"));
    };
    const parar = () => { clearInterval(relogio); relogio = null; };
    const tocar = () => {
      parar();
      if (slides.length > 1 && !parado && !document.hidden && !semAnimacao.matches) relogio = setInterval(() => ir(atual + 1), 6000);
    };
    if (slides.length > 1) {
      for (const seta of banners.querySelectorAll("[data-banner-seta]")) {
        seta.hidden = false;
        seta.addEventListener("click", () => { ir(atual + Number(seta.dataset.bannerSeta)); tocar(); });
      }
      banners.querySelector(".banners-pontos").hidden = false;
      pontos.forEach((ponto, n) => ponto.addEventListener("click", () => { ir(n); tocar(); }));
      let espera = null;
      trilho.addEventListener("scroll", () => { clearTimeout(espera); espera = setTimeout(marcar, 80); }, { passive: true });
      trilho.addEventListener("keydown", (evento) => {
        if (evento.key === "ArrowLeft") { evento.preventDefault(); ir(atual - 1); }
        if (evento.key === "ArrowRight") { evento.preventDefault(); ir(atual + 1); }
      });
      banners.addEventListener("mouseenter", () => { parado = true; parar(); });
      banners.addEventListener("mouseleave", () => { parado = false; tocar(); });
      banners.addEventListener("focusin", () => { parado = true; parar(); });
      banners.addEventListener("focusout", (evento) => { if (!banners.contains(evento.relatedTarget)) { parado = false; tocar(); } });
      trilho.addEventListener("touchstart", parar, { passive: true });
      trilho.addEventListener("touchend", () => setTimeout(tocar, 4000), { passive: true });
      document.addEventListener("visibilitychange", tocar);
      window.addEventListener("resize", () => ir(atual, false));
      marcar();
      tocar();
    }
  }

  // Lista de empreendimentos: filtros por tipo, bairro e status.
  const listaEmp = document.querySelector("[data-lista-emp]");
  if (listaEmp) {
    const filtrosEmp = listaEmp.querySelector("[data-filtros-emp]");
    const cartoesEmp = [...listaEmp.querySelectorAll("[data-grade] .cartao")];
    const contagemEmp = listaEmp.querySelector("[data-contagem]");
    const vazioEmp = listaEmp.querySelector("[data-vazio]");
    const nomes = ["tipo", "bairro", "status"];
    const parametrosEmp = new URLSearchParams(location.search);
    for (const nome of nomes) {
      const valor = parametrosEmp.get(nome);
      if (valor && filtrosEmp.elements[nome]) filtrosEmp.elements[nome].value = valor;
    }
    const aplicarEmp = () => {
      let achados = 0;
      for (const cartao of cartoesEmp) {
        const passa = nomes.every((nome) => !filtrosEmp.elements[nome].value || cartao.dataset[nome] === filtrosEmp.elements[nome].value);
        cartao.hidden = !passa;
        if (passa) achados += 1;
      }
      contagemEmp.textContent = `${achados} ${achados === 1 ? "empreendimento" : "empreendimentos"}`;
      vazioEmp.hidden = achados > 0;
    };
    filtrosEmp.addEventListener("input", () => {
      aplicarEmp();
      const novos = new URLSearchParams();
      for (const nome of nomes) if (filtrosEmp.elements[nome].value) novos.set(nome, filtrosEmp.elements[nome].value);
      history.replaceState(null, "", novos.toString() ? `?${novos}` : location.pathname);
    });
    filtrosEmp.addEventListener("submit", (evento) => evento.preventDefault());
    aplicarEmp();
  }

  // Formulário "Quero receber mais informações": vira lead no sistema e segue
  // a distribuição normal. O campo "empresa" é invisível: só robôs preenchem.
  const pedido = document.querySelector("[data-pedido]");
  if (pedido) {
    const situacao = pedido.querySelector("[data-pedido-status]");
    const enviarPedido = pedido.querySelector("button[type=submit]");
    pedido.addEventListener("submit", async (evento) => {
      evento.preventDefault();
      const campos = pedido.elements;
      const nome = campos.nome.value.trim();
      const telefone = campos.telefone.value.replace(/\D/g, "");
      situacao.className = "pedido-status";
      if (nome.length < 2) { situacao.textContent = "Informe seu nome."; situacao.classList.add("erro"); campos.nome.focus(); return; }
      if (telefone.length < 10 || telefone.length > 13) { situacao.textContent = "Informe o WhatsApp com DDD, por exemplo (67) 99999-0000."; situacao.classList.add("erro"); campos.telefone.focus(); return; }
      if (campos.empresa.value) { situacao.textContent = "Recebemos seu pedido."; return; }
      enviarPedido.disabled = true;
      situacao.textContent = "Enviando…";
      try {
        const resposta = await fetch("https://nlbonjxmzmwsyuirxnzu.supabase.co/rest/v1/rpc/pedir_informacoes_site", {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: CHAVE_PUBLICA },
          body: JSON.stringify({
            p_empreendimento: pedido.dataset.pedido, p_nome: nome, p_telefone: telefone,
            p_email: campos.email.value.trim() || null, p_mensagem: campos.mensagem.value.trim() || null, p_visitante: visitante(),
          }),
        });
        const corpo = await resposta.json().catch(() => ({}));
        if (!resposta.ok) throw new Error(corpo.message || "Não foi possível enviar agora.");
        pedido.reset();
        situacao.textContent = "Pronto! Recebemos seu pedido. Um corretor vai falar com você pelo WhatsApp.";
        situacao.classList.add("ok");
      } catch (erro) {
        situacao.textContent = /WhatsApp/.test(erro.message) ? erro.message : `${erro.message} Se preferir, fale com a gente pelo WhatsApp.`;
        situacao.classList.add("erro");
      } finally {
        enviarPedido.disabled = false;
      }
    });
  }

  const lista = document.querySelector("[data-lista]");
  if (!lista) return;
  const filtros = lista.querySelector("[data-filtros]");
  const cartoes = [...lista.querySelectorAll("[data-grade] .cartao")];
  const contagem = lista.querySelector("[data-contagem]");
  const vazio = lista.querySelector("[data-vazio]");
  const mais = lista.querySelector("[data-mais]");
  const grade = lista.querySelector("[data-grade]");
  const ordenar = lista.querySelector("[data-ordenar]");
  const abrirFiltros = lista.querySelector("[data-abrir-filtros]");
  const quantosFiltros = lista.querySelector("[data-quantos-filtros]");
  let limite = POR_PAGINA;

  // Ordem: mais recentes (a do banco), menor ou maior valor. "Consulte" vai para o fim.
  function reordenar() {
    const modo = ordenar?.value || "recentes";
    const valor = (c) => Number(c.dataset.valor) || (modo === "maior" ? -1 : Infinity);
    const ordem = [...cartoes].sort((a, b) =>
      modo === "menor" ? valor(a) - valor(b) : modo === "maior" ? valor(b) - valor(a) : Number(a.dataset.ordem) - Number(b.dataset.ordem));
    grade.append(...ordem);
    cartoes.splice(0, cartoes.length, ...ordem);
  }

  // No celular os filtros ficam recolhidos atrás de um botão, para os imóveis aparecerem logo.
  if (abrirFiltros) {
    abrirFiltros.hidden = false;
    abrirFiltros.addEventListener("click", () => {
      const aberto = filtros.classList.toggle("aberto");
      abrirFiltros.setAttribute("aria-expanded", String(aberto));
    });
  }
  const marcarFiltros = () => {
    if (!quantosFiltros) return;
    const n = ["tipo", "bairro", "valor", "quartos"].filter((nome) => filtros.elements[nome].value).length;
    quantosFiltros.textContent = n ? ` (${n})` : "";
  };

  const parametros = new URLSearchParams(location.search);
  for (const nome of ["tipo", "bairro", "valor", "quartos"]) {
    const valor = parametros.get(nome);
    if (valor && filtros.elements[nome]) filtros.elements[nome].value = valor;
  }
  if (ordenar && parametros.get("ordem")) ordenar.value = parametros.get("ordem");

  function aplicar() {
    const tipo = filtros.elements.tipo.value;
    const bairro = filtros.elements.bairro.value;
    const valor = Number(filtros.elements.valor.value.replace(/\D/g, "")) || 0;
    const quartos = Number(filtros.elements.quartos.value) || 0;
    let achados = 0;
    for (const cartao of cartoes) {
      const passa =
        (!tipo || cartao.dataset.tipo === tipo) &&
        (!bairro || cartao.dataset.bairro === bairro) &&
        (!valor || (Number(cartao.dataset.valor) > 0 && Number(cartao.dataset.valor) <= valor)) &&
        (!quartos || Number(cartao.dataset.quartos) >= quartos);
      if (passa) achados += 1;
      cartao.hidden = !passa || achados > limite;
    }
    contagem.textContent = `${achados} ${achados === 1 ? "imóvel" : "imóveis"}`;
    vazio.hidden = achados > 0;
    mais.hidden = achados <= limite;
  }

  // Filtro na barra de endereço: dá para compartilhar a busca.
  function guardarNoEndereco() {
    const novos = new URLSearchParams();
    for (const nome of ["tipo", "bairro", "valor", "quartos"]) {
      if (filtros.elements[nome].value) novos.set(nome, filtros.elements[nome].value);
    }
    if (ordenar && ordenar.value !== "recentes") novos.set("ordem", ordenar.value);
    const texto = novos.toString();
    history.replaceState(null, "", texto ? `?${texto}` : location.pathname);
  }

  filtros.addEventListener("input", () => {
    limite = POR_PAGINA;
    aplicar();
    marcarFiltros();
    guardarNoEndereco();
  });
  ordenar?.addEventListener("change", () => {
    limite = POR_PAGINA;
    reordenar();
    aplicar();
    guardarNoEndereco();
  });
  filtros.addEventListener("submit", (evento) => evento.preventDefault());
  mais.addEventListener("click", () => {
    limite += POR_PAGINA;
    aplicar();
  });
  reordenar();
  aplicar();
  marcarFiltros();
})();
