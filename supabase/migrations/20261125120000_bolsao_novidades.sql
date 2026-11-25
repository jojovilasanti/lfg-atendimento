-- Aviso visual de lead novo no Bolsão (pedido de 25/11): sem push nem WhatsApp.
--   * bolsao_sinal: um registro só, que muda sempre que um lead entra ou sai do
--     Bolsão. Toda a equipe recebe a mudança em tempo real (o lead em si não é
--     visível ao corretor antes de assumir, então o aviso dos leads não chega).
--     Não carrega dado de cliente.
--   * bolsao_vistos: quando cada pessoa abriu o Bolsão pela última vez. Lead que
--     entrou depois disso é "novo" para ela. Fica fora do tempo real de propósito.
--   * bolsao_resumo(): quantos leads há no Bolsão e quantos são novos para mim.
--   * marcar_bolsao_visto(): grava agora e devolve o horário anterior (a tela usa
--     para pôr a etiqueta NOVO nos cards desta visita).
--   * Não clientes nunca contam nem aparecem no Bolsão.

create table if not exists public.bolsao_sinal (
  id integer primary key default 1 check (id = 1),
  mudou_em timestamptz not null default now()
);
insert into public.bolsao_sinal (id) values (1) on conflict (id) do nothing;
alter table public.bolsao_sinal enable row level security;
drop policy if exists "Equipe vê o sinal do bolsão" on public.bolsao_sinal;
create policy "Equipe vê o sinal do bolsão" on public.bolsao_sinal
  for select to authenticated using (interno.meu_corretor_id() is not null);
revoke all on public.bolsao_sinal from anon;
grant select on public.bolsao_sinal to authenticated;

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'bolsao_sinal') then
    alter publication supabase_realtime add table public.bolsao_sinal;
  end if;
end $$;

create table if not exists public.bolsao_vistos (
  corretor_id uuid primary key references public.corretores(id) on delete cascade,
  visto_em timestamptz not null default now()
);
alter table public.bolsao_vistos enable row level security;
revoke all on public.bolsao_vistos from anon, authenticated;

-- Está no Bolsão (mesma regra de leads_do_bolsao).
create or replace function interno.no_bolsao(p_status text, p_bolsao_desde timestamptz, p_categoria text, p_excluido_em timestamptz)
 returns boolean
 language sql
 stable
 set search_path to ''
as $$
  select p_status = 'aguardando_corretor' and p_bolsao_desde is not null and p_excluido_em is null
    and not interno.eh_nao_cliente(p_categoria);
$$;

create or replace function interno.avisar_mudanca_no_bolsao()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_antes boolean := tg_op <> 'INSERT' and interno.no_bolsao(old.status::text, old.bolsao_desde, old.categoria, old.excluido_em);
  v_depois boolean := tg_op <> 'DELETE' and interno.no_bolsao(new.status::text, new.bolsao_desde, new.categoria, new.excluido_em);
begin
  if v_antes or v_depois then
    update public.bolsao_sinal set mudou_em = clock_timestamp() where id = 1;
  end if;
  return null;
end;
$$;

drop trigger if exists leads_sinal_bolsao on public.leads;
create trigger leads_sinal_bolsao
  after insert or delete or update of status, bolsao_desde, categoria, excluido_em, corretor_id on public.leads
  for each row execute function interno.avisar_mudanca_no_bolsao();

create or replace function public.bolsao_resumo()
 returns jsonb
 language sql
 stable security definer
 set search_path to ''
as $$
  with eu as (select interno.meu_corretor_id() as id),
  visto as (select v.visto_em from public.bolsao_vistos v, eu where v.corretor_id = eu.id),
  lista as (
    select l.bolsao_desde from public.leads l
    where interno.no_bolsao(l.status::text, l.bolsao_desde, l.categoria, l.excluido_em)
  )
  select case when (select id from eu) is null then jsonb_build_object('total', 0, 'novos', 0)
    else jsonb_build_object(
      'total', (select count(*) from lista),
      'novos', (select count(*) from lista where lista.bolsao_desde > coalesce((select visto_em from visto), '-infinity'::timestamptz))
    ) end;
$$;
revoke all on function public.bolsao_resumo() from public, anon;
grant execute on function public.bolsao_resumo() to authenticated;

create or replace function public.marcar_bolsao_visto()
 returns timestamptz
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_eu uuid := interno.meu_corretor_id();
  v_antes timestamptz;
begin
  if v_eu is null then
    raise exception 'Só a equipe abre o Bolsão';
  end if;
  select visto_em into v_antes from public.bolsao_vistos where corretor_id = v_eu;
  insert into public.bolsao_vistos (corretor_id, visto_em) values (v_eu, clock_timestamp())
  on conflict (corretor_id) do update set visto_em = excluded.visto_em;
  return v_antes;
end;
$$;
revoke all on function public.marcar_bolsao_visto() from public, anon;
grant execute on function public.marcar_bolsao_visto() to authenticated;

-- A lista do Bolsão também deixa de fora não clientes e excluídos.
create or replace function public.leads_do_bolsao()
 returns table(id uuid, nome text, resumo text, interesse text, temperatura text, regiao text, orcamento numeric, imovel_codigo text, imovel_referencia text, imovel_bairro text, bolsao_desde timestamp with time zone)
 language sql
 stable security definer
 set search_path to ''
as $$
  select l.id, l.nome, l.resumo, l.interesse::text, l.temperatura::text, l.ficha ->> 'regiao',
    nullif(l.ficha ->> 'orcamento_max', '')::numeric, l.imovel_codigo, i.referencia, i.bairro, l.bolsao_desde
  from public.leads l
  left join public.imoveis i on i.codigo = l.imovel_codigo
  where interno.no_bolsao(l.status::text, l.bolsao_desde, l.categoria, l.excluido_em)
    and interno.meu_corretor_id() is not null
  order by l.bolsao_desde;
$$;
