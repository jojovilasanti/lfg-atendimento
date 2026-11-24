// Feed no formato VRSync (Grupo OLX: ZAP Imóveis, Viva Real e OLX): conferência
// de cada imóvel e montagem do XML. Sem dependências, para dar para testar fora.
export type Portal = {
  id: string; nome: string; formato: string | null; ativo: boolean; token: string; arquivo: string;
  config: { codigo?: string; publicacao?: string }; ultima_atualizacao: string | null; ultimo_resultado: string | null; avisado_em: string | null;
};
export type Imovel = {
  codigo: string; referencia: string | null; tipo: string | null; categoria: string | null; venda: boolean; locacao: boolean;
  valor_venda: number | null; valor_locacao: number | null; valor_condominio: number | null; valor_iptu: number | null;
  dormitorios: number | null; suites: number | null; banheiros: number | null; vagas: number | null;
  area_construida: number | null; area_terreno: number | null; area_util: number | null;
  endereco: string | null; numero: string | null; complemento: string | null; bairro: string | null; cidade: string | null; uf: string | null;
  cep: string | null; latitude: number | null; longitude: number | null; titulo: string | null; descricao: string | null;
  link_site: string | null; fotos: string[] | null; aceita_pet: boolean | null; mobiliado: boolean | null;
  caracteristicas: Record<string, string> | null; captador: string | null;
};
export type Ajuste = { imovel_codigo: string; cep: string | null; titulo: string | null; cep_tentado_em: string | null };


// --- Tradução para o VRSync -------------------------------------------------

const NOMES_DOS_TIPOS: Record<string, string> = {
  CASA: "Casa", APARTAMENTO: "Apartamento", TERRENO: "Terreno", CHACARA: "Chácara", COMERCIAL: "Imóvel comercial",
  BARRACAO: "Barracão", GALPAO: "Galpão", "TWO STORY HOUSE": "Sobrado",
};

export function tipoVrsync(i: Imovel): string {
  const tipo = (i.tipo ?? "").toUpperCase();
  const categoria = (i.categoria ?? "").toUpperCase();
  if (tipo === "APARTAMENTO") return "Residential / Apartment";
  if (tipo === "TWO STORY HOUSE" || (tipo === "CASA" && categoria === "SOBRADO")) return "Residential / Sobrado";
  if (tipo === "CASA" && categoria === "KITNET") return "Residential / Kitnet";
  if (tipo === "CASA") return "Residential / Home";
  if (tipo === "TERRENO") return "Residential / Land Lot";
  if (tipo === "CHACARA") return "Residential / Farm Ranch";
  if (tipo === "GALPAO" || tipo === "BARRACAO") return "Commercial / Industrial";
  return "Commercial / Business";
}
// Terreno, chácara e galpão usam a área do terreno; os outros, a área construída.
const USA_AREA_DO_TERRENO = new Set(["Residential / Land Lot", "Residential / Farm Ranch", "Commercial / Industrial"]);
const PEDE_QUARTOS = new Set(["Residential / Apartment", "Residential / Home", "Residential / Sobrado", "Residential / Farm Ranch"]);
const PEDE_BANHEIROS = new Set(["Residential / Apartment", "Residential / Home", "Residential / Sobrado", "Residential / Farm Ranch", "Residential / Kitnet"]);

const CARACTERISTICAS: Record<string, string> = {
  Piscina: "Pool", Piscinainfantil: "Childrens Pool", Piscinaprivativa: "Private Pool", Arealazer: "Recreation Area",
  Varandagourmet: "Gourmet Balcony", Gourmet: "Gourmet Area", Quintal: "Backyard", Varanda: "Balcony", Arcondicionado: "Cooling",
  Armariocozinha: "Kitchen Cabinets", Lavanderia: "Laundry", Areaservico: "Service Room", Murado: "Fenced Yard", Cerca: "Fence",
  Portaoeletronico: "Electronic Gate", Alarme: "Alarm System", Interforne: "Intercom", Salafesta: "Party Room", Porcelanato: "Porcelain",
  Copa: "Copa", Banheiroauxiliar: "Service Bathroom", Elevador: "Elevator", Playground: "Playground", Sauna: "Sauna",
  Quadrapoliesportiva: "Sports Court", Quadra: "Sports Court", Salajogos: "Game room", Salaginastica: "Gym", Portaria24horas: "Concierge 24h",
  Lareira: "Fireplace", Moveisplanejados: "Planned Furniture", Escritorio: "Home Office", Jardim: "Garden Area", Hidro: "Whirlpool",
  Deck: "Deck", Poco: "Well", Pisoelevado: "Raised Floor", Laminado: "Laminated Floor", Zelador: "Caretaker", Guarita: "Armored Security Cabin",
  Vistapano: "Panoramic View", Biciletario: "Bicycles Place", Pavimentacao: "Paved Street", Wireless: "Internet Connection",
};

export const somenteDigitos = (texto: string | null | undefined) => String(texto ?? "").replace(/\D/g, "");
const inteiro = (valor: number | string | null | undefined) => {
  const n = Number(valor);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};
const cdata = (texto: string) => `<![CDATA[${String(texto).replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;
const esc = (texto: unknown) => String(texto ?? "").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
const semTags = (texto: string) => texto.replace(/<[^>]*>/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

export function tituloDoImovel(i: Imovel, ajuste?: Ajuste): string {
  if (ajuste?.titulo) return ajuste.titulo;
  const proprio = (i.titulo ?? "").replace(/\s+/g, " ").trim();
  if (proprio.length >= 10 && proprio.length <= 100) return proprio;
  const tipo = NOMES_DOS_TIPOS[(i.tipo ?? "").toUpperCase()] ?? "Imóvel";
  const quartos = inteiro(i.dormitorios) ? ` com ${inteiro(i.dormitorios)} quarto${inteiro(i.dormitorios) > 1 ? "s" : ""}` : "";
  const onde = i.bairro ? ` no ${i.bairro}` : i.cidade ? ` em ${i.cidade}` : "";
  const acao = i.venda && i.locacao ? " à venda ou para alugar" : i.locacao ? " para alugar" : " à venda";
  let titulo = `${tipo}${quartos}${acao}${onde}`;
  if (titulo.length > 100) titulo = `${tipo}${quartos}${onde}`.slice(0, 100);
  return titulo.length >= 10 ? titulo : `${titulo} - ${i.referencia ?? i.codigo}`.slice(0, 100);
}

// Mesmo endereço da página no site (igual ao gerador do site).
export function paginaNoSite(i: Imovel, base: string): string {
  try {
    const partes = decodeURIComponent(new URL(i.link_site ?? "").pathname).split("/").filter(Boolean);
    if (partes.length >= 2 && partes.every((p) => /^[\w.-]+$/.test(p) && p !== "." && p !== "..")) {
      return `${base}/${partes.map(encodeURIComponent).join("/")}/`;
    }
  } catch { /* sem link do Univen */ }
  return `${base}/imovel/${String(i.referencia ?? i.codigo).replace(/[^A-Za-z0-9-]/g, "")}/`;
}

export type Contato = { nome: string; email: string; telefone: string; site: string };

// Confere o imóvel e devolve o <Listing> ou os motivos de ficar de fora.
export function listingVrsync(i: Imovel, ajuste: Ajuste | undefined, portal: Portal, contato: Contato): { xml?: string; motivos: string[] } {
  const motivos: string[] = [];
  const tipo = tipoVrsync(i);
  const cep = ajuste?.cep ?? (somenteDigitos(i.cep).length === 8 ? `${somenteDigitos(i.cep).slice(0, 5)}-${somenteDigitos(i.cep).slice(5)}` : null);
  if (!cep) motivos.push("sem CEP");
  const fotos = (i.fotos ?? []).filter((f) => /^https:\/\//.test(f) && /\.jpe?g(\?|$)/i.test(f));
  if (fotos.length < 5) motivos.push(`${fotos.length} foto${fotos.length === 1 ? "" : "s"} em JPG (o mínimo é 5)`);
  let descricao = semTags(i.descricao ?? "");
  if (descricao.length < 50) motivos.push("descrição com menos de 50 letras");
  if (descricao.length > 3000) descricao = `${descricao.slice(0, 2996).replace(/\s+\S*$/, "")} ...`;
  const venda = inteiro(i.valor_venda);
  const aluguel = inteiro(i.valor_locacao);
  if (i.venda && !venda) motivos.push("sem preço de venda");
  if (i.locacao && !aluguel) motivos.push("sem valor do aluguel");
  if (!i.venda && !i.locacao) motivos.push("sem finalidade (venda ou aluguel)");
  const areaTerreno = inteiro(i.area_terreno);
  const areaConstruida = inteiro(i.area_util) || inteiro(i.area_construida);
  if (USA_AREA_DO_TERRENO.has(tipo) ? !areaTerreno && !areaConstruida : !areaConstruida && !areaTerreno) motivos.push("sem área");
  if (PEDE_QUARTOS.has(tipo) && i.dormitorios == null) motivos.push("sem quantidade de quartos");
  if (PEDE_BANHEIROS.has(tipo) && i.banheiros == null) motivos.push("sem quantidade de banheiros");
  if (!i.bairro || !i.cidade || !i.uf) motivos.push("sem bairro, cidade ou estado");
  if (motivos.length) return { motivos };

  const codigo = portal.config.codigo === "codigo" ? i.codigo : (i.referencia ?? i.codigo);
  const transacao = i.venda && i.locacao ? "Sale/Rent" : i.locacao ? "For Rent" : "For Sale";
  const recursos = new Set<string>();
  for (const [chave, valor] of Object.entries(i.caracteristicas ?? {})) if (valor === "1" && CARACTERISTICAS[chave]) recursos.add(CARACTERISTICAS[chave]);
  if (i.mobiliado) recursos.add("Furnished");
  if (i.aceita_pet) recursos.add("Pets Allowed");
  const usaTerreno = USA_AREA_DO_TERRENO.has(tipo);
  const quartos = tipo === "Residential / Kitnet" ? 0 : i.dormitorios;
  const lat = Number(i.latitude), lng = Number(i.longitude);
  const temPonto = Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0;

  const xml = `<Listing>
<ListingID>${esc(String(codigo).slice(0, 50))}</ListingID>
<Title>${cdata(tituloDoImovel(i, ajuste))}</Title>
<TransactionType>${transacao}</TransactionType>
<PublicationType>${esc(portal.config.publicacao || "STANDARD")}</PublicationType>
<DetailViewUrl>${esc(paginaNoSite(i, contato.site))}</DetailViewUrl>
<Media>
${fotos.slice(0, 50).map((f, n) => `<Item medium="image" caption="img${n + 1}"${n === 0 ? ' primary="true"' : ""}>${esc(f)}</Item>`).join("\n")}
</Media>
<Details>
<UsageType>${tipo.startsWith("Residential") ? "Residential" : "Commercial"}</UsageType>
<PropertyType>${esc(tipo)}</PropertyType>
<Description>${cdata(descricao)}</Description>
${i.venda ? `<ListPrice currency="BRL">${venda}</ListPrice>` : ""}
${i.locacao ? `<RentalPrice currency="BRL" period="Monthly">${aluguel}</RentalPrice>` : ""}
${inteiro(i.valor_condominio) ? `<PropertyAdministrationFee currency="BRL">${inteiro(i.valor_condominio)}</PropertyAdministrationFee>` : ""}
${inteiro(i.valor_iptu) ? `<Iptu currency="BRL" period="Yearly">${inteiro(i.valor_iptu)}</Iptu>` : ""}
${usaTerreno ? `<LotArea unit="square metres">${areaTerreno || areaConstruida}</LotArea>` : `<LivingArea unit="square metres">${areaConstruida || areaTerreno}</LivingArea>`}
${!usaTerreno && areaTerreno ? `<LotArea unit="square metres">${areaTerreno}</LotArea>` : ""}
${usaTerreno && areaConstruida && tipo !== "Residential / Land Lot" ? `<LivingArea unit="square metres">${areaConstruida}</LivingArea>` : ""}
${quartos != null && tipo !== "Residential / Land Lot" ? `<Bedrooms>${Math.max(0, Math.round(Number(quartos)))}</Bedrooms>` : ""}
${i.banheiros != null && tipo !== "Residential / Land Lot" ? `<Bathrooms>${Math.max(0, Math.round(Number(i.banheiros)))}</Bathrooms>` : ""}
${inteiro(i.suites) ? `<Suites>${inteiro(i.suites)}</Suites>` : ""}
${inteiro(i.vagas) ? `<Garage type="Parking Space">${inteiro(i.vagas)}</Garage>` : ""}
${recursos.size ? `<Features>\n${[...recursos].map((r) => `<Feature>${esc(r)}</Feature>`).join("\n")}\n</Features>` : ""}
</Details>
<Location displayAddress="Street">
<Country abbreviation="BR">Brasil</Country>
<State abbreviation="${esc((i.uf ?? "").toUpperCase())}">${esc((i.uf ?? "").toUpperCase())}</State>
<City>${cdata(i.cidade ?? "")}</City>
<Neighborhood>${cdata(i.bairro ?? "")}</Neighborhood>
${i.endereco ? `<Address>${cdata(i.endereco)}</Address>` : ""}
${somenteDigitos(i.numero) ? `<StreetNumber>${esc(somenteDigitos(i.numero))}</StreetNumber>` : ""}
${i.complemento ? `<Complement>${cdata(i.complemento)}</Complement>` : ""}
<PostalCode>${esc(cep)}</PostalCode>
${temPonto ? `<Latitude>${lat}</Latitude>\n<Longitude>${lng}</Longitude>` : ""}
</Location>
<ContactInfo>
<Name>${cdata(contato.nome)}</Name>
<Email>${esc(contato.email)}</Email>
${contato.site ? `<Website>${esc(contato.site)}</Website>` : ""}
${contato.telefone ? `<Telephone>${esc(contato.telefone)}</Telephone>` : ""}
</ContactInfo>
</Listing>`.replace(/\n{2,}/g, "\n");
  return { xml, motivos };
}

export function feedVrsync(listings: string[], contato: Contato): string {
  const agora = new Date().toLocaleString("sv-SE", { timeZone: "America/Campo_Grande" }).replace(" ", "T");
  return `<?xml version="1.0" encoding="UTF-8"?>
<ListingDataFeed xmlns="http://www.vivareal.com/schemas/1.0/VRSync" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.vivareal.com/schemas/1.0/VRSync http://xml.vivareal.com/vrsync.xsd">
<Header>
<Provider>${cdata(`${contato.nome} (sistema próprio)`)}</Provider>
<Email>${esc(contato.email)}</Email>
<ContactName>${cdata(contato.nome)}</ContactName>
<PublishDate>${agora}</PublishDate>
${contato.telefone ? `<Telephone>${esc(contato.telefone)}</Telephone>` : ""}
</Header>
<Listings>
${listings.join("\n")}
</Listings>
</ListingDataFeed>
`;
}
