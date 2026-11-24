-- Google Agenda (opção A, OAuth): cada pessoa conecta a própria conta Google no
-- Perfil e o sistema cria, atualiza e apaga eventos na agenda principal dela:
--   * demandas: na agenda do responsável;
--   * visitas: na agenda do corretor responsável pela visita.
-- Quem faz as chamadas ao Google é a função google-agenda; o banco só avisa
-- (pg_net) quando uma demanda ou visita muda.
--
-- Os tokens ficam em tabelas sem nenhuma regra de leitura: só a chave de servidor
-- (a função) lê. O painel vê a situação da conexão por minha_conexao_google().

create table if not exists public.google_conexoes (
  corretor_id uuid primary key references public.corretores (id) on delete cascade,
  email text,
  refresh_token text not null,
  access_token text,
  expira_em timestamptz,
  conectado_em timestamptz not null default now(),
  erro text
);
alter table public.google_conexoes enable row level security;

-- Pedido de conexão em andamento (o "state" do OAuth), vale 15 minutos.
create table if not exists public.google_estados (
  estado text primary key,
  corretor_id uuid not null references public.corretores (id) on delete cascade,
  criado_em timestamptz not null default now()
);
alter table public.google_estados enable row level security;

-- Que evento do Google corresponde a cada demanda ou visita, por pessoa.
create table if not exists public.google_eventos (
  origem text not null check (origem in ('demanda', 'visita')),
  origem_id uuid not null,
  corretor_id uuid not null references public.corretores (id) on delete cascade,
  evento_id text not null,
  atualizado_em timestamptz not null default now(),
  primary key (origem, origem_id, corretor_id)
);
alter table public.google_eventos enable row level security;

create or replace function public.minha_conexao_google()
 returns jsonb
 language sql
 stable security definer
 set search_path to ''
as $$
  select case when g.corretor_id is null then jsonb_build_object('conectado', false)
    else jsonb_build_object('conectado', true, 'email', g.email, 'conectado_em', g.conectado_em, 'erro', g.erro) end
  from (select 1) x
  left join public.google_conexoes g on g.corretor_id = interno.meu_corretor_id();
$$;
revoke all on function public.minha_conexao_google() from public, anon;
grant execute on function public.minha_conexao_google() to authenticated;

-- Avisa a função que uma demanda ou visita mudou (ela confere quem tem agenda conectada).
create or replace function interno.sincronizar_google()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_id uuid := coalesce(new.id, old.id);
begin
  -- Ninguém conectado: nada a fazer.
  if not exists (select 1 from public.google_conexoes) then
    return null;
  end if;
  perform net.http_post(
    url := 'https://nlbonjxmzmwsyuirxnzu.supabase.co/functions/v1/google-agenda',
    body := jsonb_build_object('acao', 'sincronizar', 'origem', tg_argv[0], 'id', v_id),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-avisos-chave', (select decrypted_secret from vault.decrypted_secrets where name = 'avisos_chave')
    ),
    timeout_milliseconds := 15000
  );
  return null;
end;
$$;

drop trigger if exists demandas_google on public.demandas;
create trigger demandas_google
  after insert or update or delete on public.demandas
  for each row execute function interno.sincronizar_google('demanda');

drop trigger if exists visitas_google on public.visitas;
create trigger visitas_google
  after insert or update on public.visitas
  for each row execute function interno.sincronizar_google('visita');
