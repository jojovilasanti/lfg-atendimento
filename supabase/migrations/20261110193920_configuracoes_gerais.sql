-- Configurações gerais da empresa (só o gestor muda): nome, logo, fuso horário,
-- marca d'água, rodapé da descrição e a chave de API de imóveis.

insert into public.configuracoes (chave, valor) values ('empresa', jsonb_build_object(
  'nome', 'LFG Imóveis',
  'logo_url', null,
  'fuso', 'America/Campo_Grande',
  'marca', jsonb_build_object('ativa', true, 'imagem_url', null, 'tamanho', 42, 'posicao', 'centro', 'opacidade', 55),
  'rodape_descricao', '',
  'api', jsonb_build_object('mostrar_internos', false, 'mostrar_indisponiveis', false)
)) on conflict (chave) do nothing;

-- O corretor também lê a da empresa (nome, logo e fuso aparecem nas telas dele).
drop policy if exists "Gestor vê as configurações; corretor só as do dia a dia" on public.configuracoes;
create policy "Gestor vê as configurações; corretor só as do dia a dia" on public.configuracoes
  for select to authenticated using (
    (select interno.sou_gestor()) or chave in ('motivos_perda', 'prazo_rodizio_minutos', 'empresa')
  );

-- Fuso da empresa, com Campo Grande se ainda não tiver um válido.
create function interno.fuso() returns text
language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select c.valor ->> 'fuso' from public.configuracoes c
      where c.chave = 'empresa' and exists (select 1 from pg_catalog.pg_timezone_names t where t.name = c.valor ->> 'fuso')),
    'America/Campo_Grande');
$$;

create or replace function interno.no_horario_do_escritorio(p_quando timestamp with time zone)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.configuracoes c
    cross join lateral jsonb_array_elements(c.valor -> 'faixas') f
    where c.chave = 'horario_escritorio'
      and c.valor -> 'dias' @> to_jsonb(extract(isodow from p_quando at time zone interno.fuso())::int)
      and (p_quando at time zone interno.fuso())::time >= (f ->> 0)::time
      and (p_quando at time zone interno.fuso())::time < (f ->> 1)::time
  );
$$;

-- Para as funções do servidor (IA) e para a tela de entrada, que ainda não tem login.
create function public.fuso_da_empresa() returns text
language sql stable security definer set search_path = ''
as $$ select interno.fuso(); $$;

create function public.empresa_publica() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('nome', coalesce(c.valor ->> 'nome', 'LFG Imóveis'), 'logo_url', c.valor ->> 'logo_url', 'fuso', interno.fuso())
  from public.configuracoes c where c.chave = 'empresa';
$$;

-- Só o gestor salva. A chave de API não passa por aqui.
create function public.salvar_empresa(p_valor jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_nome text := regexp_replace(trim(coalesce(p_valor ->> 'nome', '')), '\s+', ' ', 'g');
  v_fuso text := p_valor ->> 'fuso';
  v_marca jsonb := coalesce(p_valor -> 'marca', '{}'::jsonb);
  v_valor jsonb;
begin
  if not interno.sou_gestor() then
    raise exception 'Só o gestor muda as configurações gerais';
  end if;
  if length(v_nome) < 2 then
    raise exception 'Informe o nome da empresa';
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names t where t.name = v_fuso) then
    raise exception 'Fuso horário inválido';
  end if;
  if coalesce(v_marca ->> 'posicao', 'centro') not in ('centro', 'superior_esquerdo', 'superior_direito', 'inferior_esquerdo', 'inferior_direito') then
    raise exception 'Posição da marca d''água inválida';
  end if;
  v_valor := jsonb_build_object(
    'nome', v_nome,
    'logo_url', nullif(trim(coalesce(p_valor ->> 'logo_url', '')), ''),
    'fuso', v_fuso,
    'marca', jsonb_build_object(
      'ativa', coalesce((v_marca ->> 'ativa')::boolean, true),
      'imagem_url', nullif(trim(coalesce(v_marca ->> 'imagem_url', '')), ''),
      'tamanho', least(80, greatest(10, coalesce((v_marca ->> 'tamanho')::int, 42))),
      'posicao', coalesce(v_marca ->> 'posicao', 'centro'),
      'opacidade', least(100, greatest(10, coalesce((v_marca ->> 'opacidade')::int, 55)))
    ),
    'rodape_descricao', left(coalesce(p_valor ->> 'rodape_descricao', ''), 1000),
    'api', jsonb_build_object(
      'mostrar_internos', coalesce((p_valor -> 'api' ->> 'mostrar_internos')::boolean, false),
      'mostrar_indisponiveis', coalesce((p_valor -> 'api' ->> 'mostrar_indisponiveis')::boolean, false)
    )
  );
  insert into public.configuracoes (chave, valor) values ('empresa', v_valor)
  on conflict (chave) do update set valor = excluded.valor;
  return v_valor;
end;
$$;

-- Chave de API: só o resumo (hash) fica guardado; a chave aparece uma vez, na hora.
create function public.gerar_chave_api() returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_chave text := 'lfg_' || encode(extensions.gen_random_bytes(24), 'hex');
begin
  if not interno.sou_gestor() then
    raise exception 'Só o gestor gera a chave de API';
  end if;
  insert into public.chaves_acesso (nome, hash_sha256) values ('api_imoveis', encode(extensions.digest(v_chave, 'sha256'), 'hex'))
  on conflict (nome) do update set hash_sha256 = excluded.hash_sha256, criada_em = now();
  return v_chave;
end;
$$;

create function public.desligar_chave_api() returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not interno.sou_gestor() then
    raise exception 'Só o gestor desliga a chave de API';
  end if;
  delete from public.chaves_acesso where nome = 'api_imoveis';
end;
$$;

create function public.situacao_chave_api() returns timestamptz
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not interno.sou_gestor() then
    raise exception 'Só o gestor vê a chave de API';
  end if;
  return (select criada_em from public.chaves_acesso where nome = 'api_imoveis');
end;
$$;

-- Imóveis para quem tem a chave (chamado só pela função api-imoveis, do servidor).
create function public.api_imoveis(p_chave text) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_api jsonb := coalesce((select c.valor -> 'api' from public.configuracoes c where c.chave = 'empresa'), '{}'::jsonb);
  v_internos boolean := coalesce((v_api ->> 'mostrar_internos')::boolean, false);
  v_indisponiveis boolean := coalesce((v_api ->> 'mostrar_indisponiveis')::boolean, false);
begin
  if p_chave is null or not exists (
    select 1 from public.chaves_acesso a
    where a.nome = 'api_imoveis' and a.hash_sha256 = encode(extensions.digest(p_chave, 'sha256'), 'hex')
  ) then
    return null;
  end if;
  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'codigo', i.codigo, 'referencia', i.referencia, 'tipo', i.tipo, 'finalidade', i.finalidade,
        'disponivel', i.ativo, 'titulo', i.titulo, 'descricao', i.descricao,
        'venda', i.venda, 'locacao', i.locacao, 'valor_venda', i.valor_venda, 'valor_locacao', i.valor_locacao,
        'valor_condominio', i.valor_condominio, 'valor_iptu', i.valor_iptu,
        'dormitorios', i.dormitorios, 'suites', i.suites, 'banheiros', i.banheiros, 'vagas', i.vagas,
        'area_construida', i.area_construida, 'area_util', i.area_util, 'area_terreno', i.area_terreno,
        'bairro', i.bairro, 'cidade', i.cidade, 'uf', i.uf,
        'fotos', to_jsonb(i.fotos), 'caracteristicas', i.caracteristicas,
        'aceita_financiamento', i.aceita_financiamento = 1, 'aceita_pet', i.aceita_pet, 'mobiliado', i.mobiliado,
        'atualizado_em', coalesce(i.atualizado_univen::timestamptz, i.sincronizado_em)
      ) || case when v_internos then jsonb_build_object(
        'endereco', i.endereco, 'numero', i.numero, 'complemento', i.complemento, 'cep', i.cep,
        'latitude', i.latitude, 'longitude', i.longitude, 'captador', i.captador, 'situacao', i.situacao,
        'ocupacao', i.ocupacao, 'taxa_administracao', i.taxa_administracao
      ) else '{}'::jsonb end
      order by i.codigo)
    from public.imoveis i
    where (i.ativo or v_indisponiveis) and coalesce(i.situacao, '') <> 'rascunho'
  ), '[]'::jsonb);
end;
$$;

-- O site também recebe os dados da empresa, a origem e o captador de cada imóvel.
create or replace function public.site_dados()
returns jsonb
language sql stable security definer set search_path = ''
as $function$
  select jsonb_build_object(
    'config', (select c.valor from public.configuracoes c where c.chave = 'site'),
    'empresa', (select c.valor - 'api' from public.configuracoes c where c.chave = 'empresa'),
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

-- Logo e imagem da marca d'água vão para a pasta "empresa" do bucket público "site",
-- que só o gestor grava (regra "Gestor envia imagens do site").

revoke all on function public.fuso_da_empresa(), public.empresa_publica(), public.salvar_empresa(jsonb), public.gerar_chave_api(),
  public.desligar_chave_api(), public.situacao_chave_api(), public.api_imoveis(text) from public, anon, authenticated;
grant execute on function public.empresa_publica() to anon, authenticated;
grant execute on function public.salvar_empresa(jsonb), public.gerar_chave_api(), public.desligar_chave_api(), public.situacao_chave_api() to authenticated;
grant execute on function public.fuso_da_empresa(), public.api_imoveis(text) to service_role;
revoke all on function interno.fuso() from public, anon;
grant execute on function interno.fuso() to authenticated, service_role;
