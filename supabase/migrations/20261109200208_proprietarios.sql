-- Proprietários dos imóveis do cadastro próprio. Ficam fora da tabela imoveis,
-- que a equipe toda lê: só o gestor, quem cadastrou e o captador do imóvel veem.
-- A Thais e o site não leem estas tabelas.
create table public.proprietarios (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  telefone text not null,
  email text,
  observacoes text,
  criado_por uuid references public.corretores(id) on delete set null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  constraint proprietarios_telefone_unico unique (telefone)
);

create table public.imovel_proprietarios (
  imovel_codigo text not null references public.imoveis(codigo) on delete cascade,
  proprietario_id uuid not null references public.proprietarios(id) on delete cascade,
  criado_em timestamptz not null default now(),
  primary key (imovel_codigo, proprietario_id)
);
create index imovel_proprietarios_proprietario on public.imovel_proprietarios (proprietario_id);

alter table public.proprietarios enable row level security;
alter table public.imovel_proprietarios enable row level security;
revoke all on public.proprietarios, public.imovel_proprietarios from anon;

create function interno.posso_editar_imovel(p_codigo text) returns boolean
language sql stable security definer set search_path = ''
as $$
  select interno.sou_gestor() or exists (
    select 1 from public.imoveis i
    where i.codigo = p_codigo and interno.corretor_do_captador(i.captador) = interno.meu_corretor_id()
  );
$$;

create function interno.posso_ver_proprietario(p_id uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select interno.sou_gestor()
    or exists (select 1 from public.proprietarios p where p.id = p_id and p.criado_por = interno.meu_corretor_id())
    or exists (
      select 1 from public.imovel_proprietarios ip
      where ip.proprietario_id = p_id and interno.posso_editar_imovel(ip.imovel_codigo)
    );
$$;

revoke all on function interno.posso_editar_imovel(text), interno.posso_ver_proprietario(uuid) from public, anon;
grant execute on function interno.posso_editar_imovel(text), interno.posso_ver_proprietario(uuid) to authenticated;

-- Só leitura pela API; gravar é pelas funções abaixo, que conferem quem pode.
create policy "Gestor, quem cadastrou e o captador veem o proprietário" on public.proprietarios
  for select to authenticated using ((select interno.posso_ver_proprietario(id)));
create policy "Quem edita o imóvel vê quem é o proprietário" on public.imovel_proprietarios
  for select to authenticated using ((select interno.posso_editar_imovel(imovel_codigo)));

-- Cadastra (p_id nulo) ou corrige o proprietário e liga ao imóvel. Telefone que
-- já existe (com ou sem o 9) é o mesmo proprietário: só ganha o vínculo.
create function public.salvar_proprietario(
  p_codigo text, p_id uuid, p_nome text, p_telefone text, p_email text default null, p_observacoes text default null
) returns public.proprietarios
language plpgsql security definer set search_path = ''
as $$
declare
  v_eu uuid := interno.meu_corretor_id();
  v_imovel public.imoveis;
  v_nome text := regexp_replace(trim(coalesce(p_nome, '')), '\s+', ' ', 'g');
  v_telefone text := interno.normalizar_whatsapp(p_telefone);
  v_email text := nullif(lower(trim(coalesce(p_email, ''))), '');
  v_proprietario public.proprietarios;
begin
  if v_eu is null then
    raise exception 'Entre no painel para cadastrar proprietários';
  end if;
  select * into v_imovel from public.imoveis where codigo = p_codigo;
  if not found or v_imovel.origem <> 'proprio' then
    raise exception 'Imóvel do cadastro próprio não encontrado';
  end if;
  if not interno.posso_editar_imovel(p_codigo) then
    raise exception 'Só o captador do imóvel ou o gestor cadastram o proprietário';
  end if;
  if v_nome !~ '^\S{2,}( \S+)+$' then
    raise exception 'Informe o nome completo do proprietário (nome e sobrenome)';
  end if;
  if v_telefone is null then
    raise exception 'Informe o telefone do proprietário com DDD, por exemplo (67) 99999-9999';
  end if;
  if v_email is not null and v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    raise exception 'Esse e-mail não parece válido';
  end if;

  if p_id is not null then
    if not interno.posso_ver_proprietario(p_id) then
      raise exception 'Proprietário não encontrado';
    end if;
    if exists (select 1 from public.proprietarios p where p.telefone = any(interno.variantes_whatsapp(v_telefone)) and p.id <> p_id) then
      raise exception 'Esse telefone já é de outro proprietário cadastrado';
    end if;
    update public.proprietarios p set
      nome = v_nome, telefone = v_telefone, email = v_email,
      observacoes = nullif(trim(coalesce(p_observacoes, '')), ''), atualizado_em = now()
    where p.id = p_id
    returning * into v_proprietario;
  else
    select * into v_proprietario from public.proprietarios p
    where p.telefone = any(interno.variantes_whatsapp(v_telefone)) limit 1;
    if not found then
      insert into public.proprietarios (nome, telefone, email, observacoes, criado_por)
      values (v_nome, v_telefone, v_email, nullif(trim(coalesce(p_observacoes, '')), ''), v_eu)
      returning * into v_proprietario;
    end if;
  end if;

  insert into public.imovel_proprietarios (imovel_codigo, proprietario_id)
  values (p_codigo, v_proprietario.id)
  on conflict do nothing;
  return v_proprietario;
end;
$$;

-- Antes de cadastrar: o telefone já é de algum proprietário? Devolve só o nome.
create function public.proprietario_pelo_telefone(p_telefone text)
returns table (id uuid, nome text)
language sql stable security definer set search_path = ''
as $$
  select p.id, p.nome
  from public.proprietarios p
  where interno.meu_corretor_id() is not null
    and interno.normalizar_whatsapp(p_telefone) is not null
    and p.telefone = any(interno.variantes_whatsapp(interno.normalizar_whatsapp(p_telefone)))
  limit 1;
$$;

-- Imóvel fora do rascunho não fica sem proprietário.
create function public.desvincular_proprietario(p_codigo text, p_proprietario_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_imovel public.imoveis;
begin
  select * into v_imovel from public.imoveis where codigo = p_codigo for update;
  if not found or not interno.posso_editar_imovel(p_codigo) then
    raise exception 'Só o captador do imóvel ou o gestor mudam o proprietário';
  end if;
  if v_imovel.situacao <> 'rascunho'
     and not exists (
       select 1 from public.imovel_proprietarios ip
       where ip.imovel_codigo = p_codigo and ip.proprietario_id <> p_proprietario_id
     ) then
    raise exception 'O imóvel publicado precisa de pelo menos um proprietário. Cadastre o novo antes de tirar este';
  end if;
  delete from public.imovel_proprietarios where imovel_codigo = p_codigo and proprietario_id = p_proprietario_id;
end;
$$;

revoke all on function public.salvar_proprietario(text, uuid, text, text, text, text), public.proprietario_pelo_telefone(text),
  public.desvincular_proprietario(text, uuid) from public, anon;
grant execute on function public.salvar_proprietario(text, uuid, text, text, text, text), public.proprietario_pelo_telefone(text),
  public.desvincular_proprietario(text, uuid) to authenticated;

-- Para sair do rascunho: proprietário vinculado e as áreas preenchidas (terreno
-- e área pedem a área do terreno; os outros tipos, área construída e área útil).
create or replace function public.salvar_imovel(p_codigo text, p_dados jsonb)
returns public.imoveis
language plpgsql security definer set search_path = ''
as $$
declare
  v_eu uuid := interno.meu_corretor_id();
  v_gestor boolean := interno.sou_gestor();
  v_atual public.imoveis;
  v_imovel public.imoveis;
  v_codigo text := p_codigo;
  v_situacao text := coalesce(nullif(p_dados ->> 'situacao', ''), 'rascunho');
  v_venda boolean := coalesce((p_dados ->> 'venda')::boolean, false);
  v_locacao boolean := coalesce((p_dados ->> 'locacao')::boolean, false);
  v_valor_venda numeric := nullif(p_dados ->> 'valor_venda', '')::numeric;
  v_valor_locacao numeric := nullif(p_dados ->> 'valor_locacao', '')::numeric;
  v_tipo text := nullif(upper(trim(p_dados ->> 'tipo')), '');
  v_bairro text := nullif(trim(p_dados ->> 'bairro'), '');
  v_cidade text := nullif(trim(p_dados ->> 'cidade'), '');
  v_uf text := nullif(upper(trim(p_dados ->> 'uf')), '');
  v_fotos text[] := array(select jsonb_array_elements_text(coalesce(p_dados -> 'fotos', '[]'::jsonb)));
  v_prefixo text := upper(trim(coalesce(p_dados ->> 'prefixo', '')));
  v_area_construida numeric := nullif(p_dados ->> 'area_construida', '')::numeric;
  v_area_util numeric := nullif(p_dados ->> 'area_util', '')::numeric;
  v_area_terreno numeric := nullif(p_dados ->> 'area_terreno', '')::numeric;
  v_referencia text;
  v_captador text;
  v_base text;
begin
  if v_eu is null then
    raise exception 'Entre no painel para cadastrar imóveis';
  end if;
  if v_situacao not in ('rascunho', 'disponivel', 'reservado', 'vendido', 'alugado', 'inativo') then
    raise exception 'Situação inválida';
  end if;
  if v_tipo is null then
    raise exception 'Escolha o tipo do imóvel';
  end if;

  if v_codigo is not null then
    select * into v_atual from public.imoveis where codigo = v_codigo for update;
    if not found then
      raise exception 'Imóvel não encontrado';
    end if;
    if v_atual.origem <> 'proprio' then
      raise exception 'Este imóvel vem do Univen: edite por lá até a troca dos portais';
    end if;
    if not (v_gestor or interno.corretor_do_captador(v_atual.captador) = v_eu) then
      raise exception 'Só o captador do imóvel ou o gestor podem editar';
    end if;
  end if;

  if v_situacao <> 'rascunho' then
    if v_codigo is null or not exists (select 1 from public.imovel_proprietarios ip where ip.imovel_codigo = v_codigo) then
      raise exception 'Para publicar, vincule o proprietário (nome completo e telefone)';
    end if;
    if v_tipo = 'TERRENO' then
      if coalesce(v_area_terreno, 0) <= 0 then
        raise exception 'Para publicar, informe a área do terreno';
      end if;
    elsif coalesce(v_area_construida, 0) <= 0 or coalesce(v_area_util, 0) <= 0 then
      raise exception 'Para publicar, informe a área construída e a área útil';
    end if;
  end if;

  if v_situacao = 'disponivel' then
    if v_bairro is null or v_cidade is null or v_uf is null then
      raise exception 'Para publicar, preencha bairro, cidade e estado';
    end if;
    if not ((v_venda and coalesce(v_valor_venda, 0) > 0) or (v_locacao and coalesce(v_valor_locacao, 0) > 0)) then
      raise exception 'Para publicar, informe o valor de venda ou de aluguel';
    end if;
    if cardinality(v_fotos) = 0 then
      raise exception 'Para publicar, envie pelo menos uma foto';
    end if;
  end if;

  -- O gestor escolhe o captador; o corretor é captador do que cadastra.
  select coalesce(c.nome_no_univen, c.nome) into v_captador
  from public.corretores c
  where c.ativo and c.id = case
    when v_gestor and nullif(p_dados ->> 'captador_id', '') is not null then (p_dados ->> 'captador_id')::uuid
    when v_atual.codigo is null then v_eu
  end;
  v_captador := coalesce(v_captador, v_atual.captador);

  if v_codigo is null then
    if v_prefixo !~ '^[A-Z]{2}$' then
      raise exception 'Tipo de imóvel sem prefixo de referência';
    end if;
    perform pg_advisory_xact_lock(hashtext('imoveis_referencia'));
    select v_prefixo || lpad((coalesce(max(substring(i.referencia from 3)::integer), 0) + 1)::text, 5, '0') into v_referencia
    from public.imoveis i
    where i.referencia ~ ('^' || v_prefixo || '[0-9]{5}$');
    v_codigo := nextval('interno.imoveis_proprios_seq')::text;
    insert into public.imoveis (codigo, referencia, origem, situacao, tipo, captador)
    values (v_codigo, v_referencia, 'proprio', 'rascunho', v_tipo, v_captador);
  else
    v_referencia := v_atual.referencia;
  end if;

  select nullif(rtrim(c.valor ->> 'endereco_site', '/'), '') into v_base from public.configuracoes c where c.chave = 'site';

  update public.imoveis i set
    situacao = v_situacao,
    tipo = v_tipo,
    finalidade = nullif(p_dados ->> 'finalidade', ''),
    captador = v_captador,
    venda = v_venda,
    locacao = v_locacao,
    valor_venda = case when v_venda then v_valor_venda end,
    valor_locacao = case when v_locacao then v_valor_locacao end,
    valor_condominio = nullif(p_dados ->> 'valor_condominio', '')::numeric,
    valor_iptu = nullif(p_dados ->> 'valor_iptu', '')::numeric,
    taxa_administracao = nullif(p_dados ->> 'taxa_administracao', '')::numeric,
    dormitorios = nullif(p_dados ->> 'dormitorios', '')::integer,
    suites = nullif(p_dados ->> 'suites', '')::integer,
    banheiros = nullif(p_dados ->> 'banheiros', '')::integer,
    vagas = nullif(p_dados ->> 'vagas', '')::integer,
    area_construida = v_area_construida,
    area_util = v_area_util,
    area_terreno = v_area_terreno,
    medida_frente = nullif(p_dados ->> 'medida_frente', '')::numeric,
    medida_fundo = nullif(p_dados ->> 'medida_fundo', '')::numeric,
    cep = nullif(trim(p_dados ->> 'cep'), ''),
    endereco = nullif(trim(p_dados ->> 'endereco'), ''),
    numero = nullif(trim(p_dados ->> 'numero'), ''),
    complemento = nullif(trim(p_dados ->> 'complemento'), ''),
    bairro = v_bairro,
    cidade = v_cidade,
    uf = v_uf,
    titulo = nullif(trim(p_dados ->> 'titulo'), ''),
    descricao = nullif(trim(p_dados ->> 'descricao'), ''),
    fotos = v_fotos,
    foto_principal = v_fotos[1],
    foto_mini = nullif(p_dados ->> 'foto_mini', ''),
    mobilia = nullif(p_dados ->> 'mobilia', ''),
    mobiliado = (p_dados ->> 'mobilia') = 'mobiliado',
    ocupacao = nullif(p_dados ->> 'ocupacao', ''),
    aceita_pet = coalesce((p_dados ->> 'aceita_pet')::boolean, false),
    aceita_financiamento = case when coalesce((p_dados ->> 'aceita_financiamento')::boolean, false) then 1 else 0 end,
    caracteristicas = coalesce(p_dados -> 'caracteristicas', '{}'::jsonb),
    link_site = case when v_base is not null then v_base || '/imovel/' || v_referencia || '/' end,
    atualizado_univen = current_date,
    sincronizado_em = now()
  where i.codigo = v_codigo
  returning * into v_imovel;
  return v_imovel;
end;
$$;
