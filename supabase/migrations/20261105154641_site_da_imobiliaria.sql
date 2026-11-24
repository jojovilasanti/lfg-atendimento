-- Site da imobiliária. O estoque vem da tabela imoveis; textos, contatos e imagens
-- ficam em configuracoes (chave "site") e o gestor edita no painel. O gerador na
-- VPS (vps/site) lê tudo por public.site_dados e publica páginas estáticas.

insert into public.configuracoes (chave, valor, descricao) values (
  'site',
  $json${
    "nome": "LFG Imóveis",
    "creci": "CRECI 11683 J",
    "titulo": "O imóvel certo em Campo Grande começa aqui",
    "subtitulo": "Casas, apartamentos, terrenos e imóveis comerciais para comprar ou alugar em Campo Grande e região.",
    "sobre": "Fundada em 2012 em Fortaleza (CE), a LFG Imóveis expandiu para Campo Grande (MS), onde se consolidou. São mais de 10 anos de mercado.\n\nTrabalhamos com imóveis residenciais, comerciais e rurais, para quem busca o primeiro imóvel e para investidores. Acreditamos em atendimento personalizado e confiança: transparência, seriedade, qualidade e eficiência em cada negócio.",
    "servicos": ["Compra e venda", "Locação", "Consultoria imobiliária para investir", "Assessoria de financiamento"],
    "whatsapp": "5567998206049",
    "telefones": ["(67) 3381-6057", "(67) 99263-5050"],
    "email": "",
    "endereco": "Av. Nelly Martins, 1180, Carandá Bosque, Campo Grande (MS), CEP 79032-295",
    "horario": "Segunda a sexta, das 8h às 11h e das 13h às 17h",
    "instagram": "",
    "facebook": "",
    "logo_url": "",
    "banner_url": "",
    "destaques": [],
    "endereco_site": "",
    "indexar": false
  }$json$::jsonb,
  'Textos, contatos e imagens do site da imobiliária.'
);

-- Logo e banner do site: públicos para ler, só o gestor envia.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('site', 'site', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "Equipe vê as imagens do site" on storage.objects
  for select to authenticated using (bucket_id = 'site');
create policy "Gestor envia imagens do site" on storage.objects
  for insert to authenticated with check (bucket_id = 'site' and (select interno.sou_gestor()));
create policy "Gestor troca imagens do site" on storage.objects
  for update to authenticated using (bucket_id = 'site' and (select interno.sou_gestor()));
create policy "Gestor apaga imagens do site" on storage.objects
  for delete to authenticated using (bucket_id = 'site' and (select interno.sou_gestor()));

-- Só o que pode aparecer no site: sem captador, rua, número nem coordenadas.
create function public.site_dados() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'config', (select c.valor from public.configuracoes c where c.chave = 'site'),
    'imoveis', coalesce((
      select jsonb_agg(jsonb_build_object(
        'codigo', i.codigo, 'referencia', i.referencia, 'tipo', i.tipo, 'titulo', i.titulo, 'descricao', i.descricao,
        'venda', i.venda, 'locacao', i.locacao, 'valor_venda', i.valor_venda, 'valor_locacao', i.valor_locacao,
        'valor_condominio', i.valor_condominio, 'valor_iptu', i.valor_iptu,
        'dormitorios', i.dormitorios, 'suites', i.suites, 'banheiros', i.banheiros, 'vagas', i.vagas,
        'area_construida', i.area_construida, 'area_terreno', i.area_terreno, 'area_util', i.area_util,
        'bairro', i.bairro, 'cidade', i.cidade, 'uf', i.uf, 'link_site', i.link_site,
        'foto_principal', i.foto_principal, 'fotos', to_jsonb(i.fotos),
        'aceita_financiamento', i.aceita_financiamento = 1, 'aceita_pet', i.aceita_pet, 'mobiliado', i.mobiliado,
        'comodidades', (
          select coalesce(jsonb_agg(k.key), '[]'::jsonb)
          from jsonb_each_text(i.caracteristicas) k
          where k.value = '1' and k.key in (
            'Piscina', 'Arealazer', 'Varandagourmet', 'Gourmet', 'Portaria24horas', 'Quintal', 'Varanda', 'Arcondicionado',
            'Armariocozinha', 'Lavanderia', 'Suitemaster', 'Murado', 'Portaoeletronico', 'Alarme', 'Interforne', 'Salafesta',
            'Porcelanato', 'Copa', 'Banheiroauxiliar'
          )
        ),
        'atualizado', i.atualizado_univen
      ) order by i.atualizado_univen desc nulls last, i.codigo)
      from public.imoveis i
      where i.ativo
    ), '[]'::jsonb)
  );
$$;

revoke execute on function public.site_dados() from public;
grant execute on function public.site_dados() to anon, authenticated, service_role;
