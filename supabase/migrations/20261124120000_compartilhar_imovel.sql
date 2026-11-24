-- Compartilhar imóvel com o cliente.
--   * Página pública leve em lfg.jojodigitals.com/imovel/<REF>?c=<slug do corretor>
--     (gerada pelo site, vps/site/gerar.py). O botão de WhatsApp vai para o número
--     oficial com o código "REF/slug" no fim da mensagem.
--   * Lead que chega com esse código e ainda não tem corretor vai direto para
--     quem compartilhou (sem rodízio e sem a IA), com origem "compartilhamento".
--   * Conta compartilhamentos (painel) e aberturas/cliques da página pública;
--     o gestor e o administrativo veem os números na ficha do imóvel.

alter table public.leads add column if not exists indicado_por uuid references public.corretores (id) on delete set null;
comment on column public.leads.indicado_por is 'Corretor que compartilhou o imóvel pelo qual o cliente chegou (link de compartilhamento).';

-- Cada toque em Compartilhar no painel.
create table if not exists public.compartilhamentos (
  id bigint generated always as identity primary key,
  imovel_codigo text not null references public.imoveis (codigo) on delete cascade,
  corretor_id uuid references public.corretores (id) on delete set null,
  canal text not null check (canal in ('whatsapp', 'whatsapp_cliente', 'nativo', 'copiar')),
  lead_id uuid references public.leads (id) on delete set null,
  criado_em timestamptz not null default now()
);
create index if not exists compartilhamentos_imovel on public.compartilhamentos (imovel_codigo, criado_em desc);
alter table public.compartilhamentos enable row level security;
drop policy if exists "Gestão vê os compartilhamentos" on public.compartilhamentos;
create policy "Gestão vê os compartilhamentos" on public.compartilhamentos for select to authenticated
  using (interno.sou_gestor() or corretor_id = interno.meu_corretor_id());

-- Aberturas da página pública e cliques no WhatsApp dela.
create table if not exists public.imovel_acessos (
  id bigint generated always as identity primary key,
  imovel_codigo text not null references public.imoveis (codigo) on delete cascade,
  corretor_id uuid references public.corretores (id) on delete set null,
  tipo text not null check (tipo in ('abriu', 'whatsapp')),
  visitante text check (visitante is null or visitante ~ '^[A-Za-z0-9-]{1,40}$'),
  criado_em timestamptz not null default now()
);
create index if not exists imovel_acessos_imovel on public.imovel_acessos (imovel_codigo, criado_em desc);
create index if not exists imovel_acessos_visitante on public.imovel_acessos (visitante, criado_em desc) where visitante is not null;
alter table public.imovel_acessos enable row level security;
drop policy if exists "Gestão vê os acessos" on public.imovel_acessos;
create policy "Gestão vê os acessos" on public.imovel_acessos for select to authenticated
  using (interno.sou_gestor() or corretor_id = interno.meu_corretor_id());

create or replace function public.registrar_compartilhamento(p_imovel text, p_canal text, p_lead_id uuid default null)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_eu uuid := interno.meu_corretor_id();
begin
  if v_eu is null then
    raise exception 'Sem acesso';
  end if;
  if p_canal not in ('whatsapp', 'whatsapp_cliente', 'nativo', 'copiar') then
    raise exception 'Canal inválido';
  end if;
  if not exists (select 1 from public.imoveis where codigo = p_imovel) then
    raise exception 'Imóvel não encontrado';
  end if;
  insert into public.compartilhamentos (imovel_codigo, corretor_id, canal, lead_id)
  values (p_imovel, v_eu, p_canal, case when p_lead_id is not null and interno.posso_ver_lead(p_lead_id) then p_lead_id end);
end;
$$;
revoke all on function public.registrar_compartilhamento(text, text, uuid) from public, anon;
grant execute on function public.registrar_compartilhamento(text, text, uuid) to authenticated;

-- Página pública: registra abertura e clique (sem login). Limite por visitante
-- para não inflar os números.
create or replace function public.registrar_acesso_imovel(p_referencia text, p_corretor text default null, p_tipo text default 'abriu', p_visitante text default null)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_codigo text;
  v_corretor uuid;
  v_visitante text := nullif(left(regexp_replace(coalesce(p_visitante, ''), '[^A-Za-z0-9-]', '', 'g'), 40), '');
begin
  if p_tipo not in ('abriu', 'whatsapp') then
    return;
  end if;
  select i.codigo into v_codigo from public.imoveis i where upper(i.referencia) = upper(trim(p_referencia)) and i.ativo limit 1;
  if v_codigo is null then
    return;
  end if;
  if v_visitante is not null and (
    select count(*) from public.imovel_acessos a where a.visitante = v_visitante and a.criado_em > now() - interval '1 hour'
  ) >= 60 then
    return;
  end if;
  -- A mesma pessoa abrindo a mesma página de novo em 30 minutos conta uma vez.
  if p_tipo = 'abriu' and v_visitante is not null and exists (
    select 1 from public.imovel_acessos a
    where a.visitante = v_visitante and a.imovel_codigo = v_codigo and a.tipo = 'abriu' and a.criado_em > now() - interval '30 minutes'
  ) then
    return;
  end if;
  select c.id into v_corretor from public.corretores c
  where c.ativo and c.slug is not null and c.slug = lower(trim(coalesce(p_corretor, ''))) limit 1;
  insert into public.imovel_acessos (imovel_codigo, corretor_id, tipo, visitante)
  values (v_codigo, v_corretor, p_tipo, v_visitante);
end;
$$;
revoke all on function public.registrar_acesso_imovel(text, text, text, text) from public;
grant execute on function public.registrar_acesso_imovel(text, text, text, text) to anon, authenticated;

-- Números de um imóvel para a gestão: total e por corretor.
create or replace function public.estatisticas_compartilhamento(p_imovel text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to ''
as $$
begin
  if not interno.sou_gestor() then
    raise exception 'Só o gestor e o administrativo veem os números de compartilhamento';
  end if;
  return jsonb_build_object(
    'compartilhamentos', (select count(*) from public.compartilhamentos where imovel_codigo = p_imovel),
    'aberturas', (select count(*) from public.imovel_acessos where imovel_codigo = p_imovel and tipo = 'abriu'),
    'cliques', (select count(*) from public.imovel_acessos where imovel_codigo = p_imovel and tipo = 'whatsapp'),
    'leads', (select count(*) from public.leads l where l.origem = 'compartilhamento' and l.imovel_codigo = p_imovel),
    'por_corretor', coalesce((
      select jsonb_agg(jsonb_build_object('nome', x.nome, 'compartilhamentos', x.comp, 'aberturas', x.abr, 'cliques', x.cli) order by x.comp desc, x.abr desc)
      from (
        select c.nome,
          (select count(*) from public.compartilhamentos s where s.imovel_codigo = p_imovel and s.corretor_id = c.id) comp,
          (select count(*) from public.imovel_acessos a where a.imovel_codigo = p_imovel and a.corretor_id = c.id and a.tipo = 'abriu') abr,
          (select count(*) from public.imovel_acessos a where a.imovel_codigo = p_imovel and a.corretor_id = c.id and a.tipo = 'whatsapp') cli
        from public.corretores c
      ) x
      where x.comp + x.abr + x.cli > 0
    ), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.estatisticas_compartilhamento(text) from public, anon;
grant execute on function public.estatisticas_compartilhamento(text) to authenticated;

-- Cliente que chegou pelo link: grava a origem e, se ainda não tem corretor,
-- entrega direto a quem compartilhou. Chamada pelo atendimento (chave de servidor).
create or replace function public.lead_por_compartilhamento(p_lead_id uuid, p_referencia text, p_corretor text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_lead public.leads;
  v_corretor public.corretores;
  v_codigo text;
begin
  select * into v_lead from public.leads where id = p_lead_id for update;
  if v_lead.id is null then
    return jsonb_build_object('situacao', 'sem_lead');
  end if;
  select i.codigo into v_codigo from public.imoveis i where upper(i.referencia) = upper(trim(p_referencia)) limit 1;
  select * into v_corretor from public.corretores c
  where c.ativo and c.papel::text <> 'administrativo' and c.slug is not null and c.slug = lower(trim(coalesce(p_corretor, ''))) limit 1;

  -- Cliente que já está com um corretor (ou com oferta aberta) não muda de mão.
  if v_lead.corretor_id is not null
     or exists (select 1 from public.atribuicoes a where a.lead_id = p_lead_id and a.status = 'pendente')
     or (v_lead.status = 'aguardando_corretor' and v_lead.bolsao_desde is not null) then
    update public.leads set imovel_codigo = coalesce(imovel_codigo, v_codigo) where id = p_lead_id;
    return jsonb_build_object('situacao', 'ja_tem_corretor');
  end if;

  update public.leads set
    origem = 'compartilhamento',
    campanha = coalesce(campanha, 'Compartilhamento' || coalesce(' de ' || split_part(v_corretor.nome, ' ', 1), '')),
    imovel_codigo = coalesce(v_codigo, imovel_codigo),
    indicado_por = v_corretor.id
  where id = p_lead_id;

  if v_corretor.id is null then
    return jsonb_build_object('situacao', 'sem_corretor');
  end if;

  update public.atribuicoes set status = 'cancelada', respondida_em = now() where lead_id = p_lead_id and status = 'pendente';
  update public.leads set corretor_id = v_corretor.id, status = 'com_corretor', ia_ativa = false, bolsao_desde = null
  where id = p_lead_id;
  insert into public.mensagens (lead_id, autor, conteudo)
  values (p_lead_id, 'sistema', format('Cliente chegou pelo link de compartilhamento de %s%s e foi direto para %s.',
    v_corretor.nome, coalesce(' (imóvel ' || p_referencia || ')', ''), split_part(v_corretor.nome, ' ', 1)));
  return jsonb_build_object('situacao', 'atribuido', 'corretor_id', v_corretor.id);
end;
$$;
revoke all on function public.lead_por_compartilhamento(uuid, text, text) from public, anon, authenticated;
grant execute on function public.lead_por_compartilhamento(uuid, text, text) to service_role;

-- Site: localização aproximada (2 casas decimais, cerca de 1 km) para a página pública.
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
        'nome', r.nome, 'papel', r.papel::text, 'creci', r.creci, 'foto_url', r.foto_url,
        'slug', case when r.papel::text <> 'administrativo' then r.slug end,
        'whatsapp', case when r.papel::text <> 'administrativo' then r.whatsapp end
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
        'lat', round(nullif(i.latitude, 0)::numeric, 2), 'lng', round(nullif(i.longitude, 0)::numeric, 2),
        'corretor', (
          select jsonb_build_object('nome', r.nome, 'creci', r.creci, 'foto_url', r.foto_url, 'slug', r.slug)
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
