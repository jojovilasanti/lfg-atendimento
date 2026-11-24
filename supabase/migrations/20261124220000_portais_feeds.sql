-- Portais (gestor): feeds XML gerados pelo próprio sistema, um por portal.
--   * portais: um por portal, com situação, último resultado e token secreto do
--     endereço do feed (bucket público "feeds", pasta <token>/).
--   * portal_atualizacoes: histórico (quando, quem ou automática, quantos, resultado).
--   * portal_problemas: imóveis que ficaram de fora na última atualização e por quê.
--   * imoveis_ajustes_portal: CEP e título para os portais, guardados à parte
--     (a leitura do Univen não apaga). O CEP pode vir da consulta automática.
--   * A função "feeds" gera os arquivos: pelo botão Atualizar agora
--     (atualizar_portais) e a cada hora (cron atualizar-portais).

create table if not exists public.portais (
  id text primary key,
  nome text not null,
  descricao text,
  formato text check (formato is null or formato in ('vrsync')),
  ativo boolean not null default false,
  token text not null default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  arquivo text not null,
  config jsonb not null default '{}'::jsonb,
  ordem integer not null default 0,
  ultima_atualizacao timestamptz,
  ultimo_resultado text check (ultimo_resultado is null or ultimo_resultado in ('ok', 'erro')),
  ultima_mensagem text,
  enviados integer,
  com_problema integer,
  atualizando_desde timestamptz,
  avisado_em timestamptz
);
alter table public.portais enable row level security;
drop policy if exists "Gestor vê os portais" on public.portais;
create policy "Gestor vê os portais" on public.portais for select to authenticated using ((select interno.sou_gestor_pleno()));

insert into public.portais (id, nome, descricao, formato, arquivo, config, ordem) values
  ('grupo_olx', 'Grupo OLX', 'ZAP Imóveis, Viva Real e OLX', 'vrsync', 'grupo-olx.xml', '{"codigo": "referencia", "publicacao": "STANDARD"}', 1),
  ('chaves_na_mao', 'Chaves na Mão', 'Aguardando a especificação do feed do portal', null, 'chaves-na-mao.xml', '{}', 2),
  ('imovelweb', 'Imovelweb', 'Aguardando a especificação do feed do portal', null, 'imovelweb.xml', '{}', 3)
on conflict (id) do nothing;

create table if not exists public.portal_atualizacoes (
  id bigint generated always as identity primary key,
  portal_id text not null references public.portais (id) on delete cascade,
  iniciada_em timestamptz not null default now(),
  terminada_em timestamptz,
  quem uuid references public.corretores (id) on delete set null,
  automatica boolean not null default false,
  enviados integer,
  com_problema integer,
  resultado text check (resultado is null or resultado in ('ok', 'erro')),
  mensagem text
);
create index if not exists portal_atualizacoes_portal on public.portal_atualizacoes (portal_id, iniciada_em desc);
alter table public.portal_atualizacoes enable row level security;
drop policy if exists "Gestor vê o histórico dos portais" on public.portal_atualizacoes;
create policy "Gestor vê o histórico dos portais" on public.portal_atualizacoes for select to authenticated using ((select interno.sou_gestor_pleno()));

create table if not exists public.portal_problemas (
  portal_id text not null references public.portais (id) on delete cascade,
  imovel_codigo text not null,
  motivos text[] not null,
  atualizado_em timestamptz not null default now(),
  primary key (portal_id, imovel_codigo)
);
alter table public.portal_problemas enable row level security;
drop policy if exists "Gestor vê os problemas dos portais" on public.portal_problemas;
create policy "Gestor vê os problemas dos portais" on public.portal_problemas for select to authenticated using ((select interno.sou_gestor_pleno()));

create table if not exists public.imoveis_ajustes_portal (
  imovel_codigo text primary key,
  cep text check (cep is null or cep ~ '^[0-9]{5}-[0-9]{3}$'),
  titulo text check (titulo is null or length(titulo) between 10 and 100),
  cep_automatico boolean not null default false,
  cep_tentado_em timestamptz,
  atualizado_em timestamptz not null default now(),
  atualizado_por uuid references public.corretores (id) on delete set null
);
alter table public.imoveis_ajustes_portal enable row level security;
drop policy if exists "Equipe vê os ajustes para portais" on public.imoveis_ajustes_portal;
create policy "Equipe vê os ajustes para portais" on public.imoveis_ajustes_portal for select to authenticated using (true);

-- Arquivos dos feeds: públicos (o endereço tem o token), gravados só pela função.
insert into storage.buckets (id, name, public) values ('feeds', 'feeds', true) on conflict (id) do nothing;

create or replace function public.ligar_portal(p_id text, p_ativo boolean)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
begin
  if not interno.sou_gestor_pleno() then
    raise exception 'Só o gestor mexe nos portais';
  end if;
  if p_ativo and not exists (select 1 from public.portais where id = p_id and formato is not null) then
    raise exception 'Este portal ainda não tem integração: falta a especificação do feed';
  end if;
  update public.portais set ativo = coalesce(p_ativo, false) where id = p_id;
end;
$$;
revoke all on function public.ligar_portal(text, boolean) from public, anon;
grant execute on function public.ligar_portal(text, boolean) to authenticated;

-- Chama a função que gera os feeds (botão ou cron).
create or replace function interno.chamar_feeds(p_portal text, p_quem uuid, p_automatica boolean)
 returns void
 language sql
 security definer
 set search_path to ''
as $$
  select net.http_post(
    url := 'https://nlbonjxmzmwsyuirxnzu.supabase.co/functions/v1/feeds',
    body := jsonb_build_object('portal', p_portal, 'quem', p_quem, 'automatica', p_automatica),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-avisos-chave', (select decrypted_secret from vault.decrypted_secrets where name = 'avisos_chave')
    ),
    timeout_milliseconds := 120000
  );
$$;

-- Atualizar agora: um portal ou todos os ligados. Trava enquanto roda.
create or replace function public.atualizar_portais(p_portal text default null)
 returns integer
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_n integer;
begin
  if not interno.sou_gestor_pleno() then
    raise exception 'Só o gestor atualiza os portais';
  end if;
  if exists (
    select 1 from public.portais
    where ativo and atualizando_desde > now() - interval '5 minutes' and (p_portal is null or id = p_portal)
  ) then
    raise exception 'A atualização já está rodando. Aguarde terminar.';
  end if;
  update public.portais set atualizando_desde = now()
  where ativo and formato is not null and (p_portal is null or id = p_portal);
  get diagnostics v_n = row_count;
  if v_n = 0 then
    raise exception 'Ligue o portal antes de atualizar';
  end if;
  perform interno.chamar_feeds(p_portal, interno.meu_corretor_id(), false);
  return v_n;
end;
$$;
revoke all on function public.atualizar_portais(text) from public, anon;
grant execute on function public.atualizar_portais(text) to authenticated;

create or replace function interno.atualizar_portais_automatico()
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
begin
  if not exists (select 1 from public.portais where ativo and formato is not null) then
    return;
  end if;
  update public.portais set atualizando_desde = now()
  where ativo and formato is not null and (atualizando_desde is null or atualizando_desde < now() - interval '5 minutes');
  perform interno.chamar_feeds(null, null, true);
end;
$$;

-- CEP e título para os portais: gestor, administrativo ou o captador do imóvel.
create or replace function public.salvar_ajuste_portal(p_codigo text, p_cep text, p_titulo text)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_imovel public.imoveis;
  v_cep text := nullif(regexp_replace(coalesce(p_cep, ''), '\D', '', 'g'), '');
  v_titulo text := nullif(trim(regexp_replace(coalesce(p_titulo, ''), '\s+', ' ', 'g')), '');
begin
  select * into v_imovel from public.imoveis where codigo = p_codigo;
  if v_imovel.codigo is null then
    raise exception 'Imóvel não encontrado';
  end if;
  if not (interno.sou_gestor() or interno.corretor_do_captador(v_imovel.captador) = interno.meu_corretor_id()) then
    raise exception 'Só o gestor, o administrativo ou o captador do imóvel mudam estes dados';
  end if;
  if v_cep is not null and length(v_cep) <> 8 then
    raise exception 'CEP com 8 números, por exemplo 79032-295';
  end if;
  if v_titulo is not null and length(v_titulo) not between 10 and 100 then
    raise exception 'O título para os portais precisa ter de 10 a 100 letras';
  end if;
  insert into public.imoveis_ajustes_portal (imovel_codigo, cep, titulo, cep_automatico, atualizado_em, atualizado_por)
  values (p_codigo, case when v_cep is not null then left(v_cep, 5) || '-' || right(v_cep, 3) end, v_titulo, false, now(), interno.meu_corretor_id())
  on conflict (imovel_codigo) do update set
    cep = excluded.cep, titulo = excluded.titulo, cep_automatico = false,
    atualizado_em = now(), atualizado_por = excluded.atualizado_por;
end;
$$;
revoke all on function public.salvar_ajuste_portal(text, text, text) from public, anon;
grant execute on function public.salvar_ajuste_portal(text, text, text) to authenticated;

-- Mandar a correção ao corretor: vira uma demanda para o captador.
create or replace function public.encaminhar_correcao_portal(p_codigo text, p_motivos text)
 returns uuid
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_imovel public.imoveis;
  v_responsavel uuid;
  v_id uuid;
begin
  if not interno.sou_gestor_pleno() then
    raise exception 'Só o gestor encaminha correções dos portais';
  end if;
  select * into v_imovel from public.imoveis where codigo = p_codigo;
  if v_imovel.codigo is null then
    raise exception 'Imóvel não encontrado';
  end if;
  v_responsavel := interno.corretor_do_captador(v_imovel.captador);
  if v_responsavel is null then
    raise exception 'Este imóvel não tem captador na equipe. Corrija você mesmo ou escolha alguém em Demandas.';
  end if;
  insert into public.demandas (titulo, descricao, responsavel_id, prazo, criada_por)
  values (
    left('Corrigir o imóvel ' || coalesce(v_imovel.referencia, p_codigo) || ' para os portais', 160),
    left('O imóvel não subiu para os portais: ' || coalesce(nullif(trim(p_motivos), ''), 'confira o cadastro') || '.'
      || E'\nAbra o imóvel no sistema (Imóveis → ' || coalesce(v_imovel.referencia, p_codigo) || ') e complete em "Ajustes para portais" ou no Univen.', 4000),
    v_responsavel, now() + interval '2 days', interno.meu_corretor_id()
  )
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.encaminhar_correcao_portal(text, text) from public, anon;
grant execute on function public.encaminhar_correcao_portal(text, text) to authenticated;

-- A cada hora: gera de novo os feeds dos portais ligados.
select cron.unschedule('atualizar-portais') where exists (select 1 from cron.job where jobname = 'atualizar-portais');
select cron.schedule('atualizar-portais', '7 * * * *', 'select interno.atualizar_portais_automatico()');
