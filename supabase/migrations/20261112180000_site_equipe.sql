-- Site: equipe com foto na página inicial e o corretor responsável (captador)
-- na página de cada imóvel. Só nome, papel, CRECI e foto: nada de telefone.
-- O captador vem do Univen pelo nome; casa com corretores.nome_no_univen ou nome.
create or replace function public.site_dados()
 returns jsonb
 language sql
 stable security definer
 set search_path to ''
as $function$
  select jsonb_build_object(
    'config', (select c.valor from public.configuracoes c where c.chave = 'site'),
    'empresa', (select c.valor - 'api' from public.configuracoes c where c.chave = 'empresa'),
    'equipe', coalesce((
      select jsonb_agg(jsonb_build_object(
        'nome', r.nome, 'papel', r.papel::text, 'creci', r.creci, 'foto_url', r.foto_url
      ) order by (r.papel::text = 'gestor') desc, r.nome)
      from public.corretores r
      where r.ativo
    ), '[]'::jsonb),
    'imoveis', coalesce((
      select jsonb_agg(jsonb_build_object(
        'codigo', i.codigo, 'referencia', i.referencia, 'tipo', i.tipo, 'titulo', i.titulo, 'descricao', i.descricao,
        'venda', i.venda, 'locacao', i.locacao, 'valor_venda', i.valor_venda, 'valor_locacao', i.valor_locacao,
        'valor_condominio', i.valor_condominio, 'valor_iptu', i.valor_iptu,
        'dormitorios', i.dormitorios, 'suites', i.suites, 'banheiros', i.banheiros, 'vagas', i.vagas,
        'area_construida', i.area_construida, 'area_terreno', i.area_terreno, 'area_util', i.area_util,
        'bairro', i.bairro, 'cidade', i.cidade, 'uf', i.uf, 'link_site', i.link_site,
        'foto_principal', i.foto_principal, 'foto_mini', i.foto_mini, 'fotos', to_jsonb(i.fotos),
        'aceita_financiamento', i.aceita_financiamento = 1, 'aceita_pet', i.aceita_pet, 'mobiliado', i.mobiliado,
        'origem', i.origem, 'captador', i.captador,
        'corretor', (
          select jsonb_build_object('nome', r.nome, 'creci', r.creci, 'foto_url', r.foto_url)
          from public.corretores r
          where r.ativo and i.captador is not null
            and (lower(r.nome_no_univen) = lower(i.captador) or lower(r.nome) = lower(i.captador))
          order by (lower(r.nome_no_univen) = lower(i.captador)) desc nulls last
          limit 1
        ),
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
$function$;
