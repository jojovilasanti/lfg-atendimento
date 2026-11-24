-- Clique no WhatsApp de um imóvel: cada clique fica registrado no imóvel e o
-- corretor responsável (o captador) recebe um aviso. Sem captador, avisa os gestores.
-- Hoje só o site registra; os portais entram depois, pela integração de leads.
create table public.cliques_whatsapp (
  id bigint generated always as identity primary key,
  imovel_codigo text not null references public.imoveis (codigo) on delete cascade,
  -- Quem foi avisado: o captador. Nulo quando o imóvel não tem corretor (avisa os gestores).
  corretor_id uuid references public.corretores (id) on delete set null,
  origem text not null default 'site' check (origem ~ '^[a-z_]{2,20}$'),
  -- Código anônimo do navegador, só para não avisar duas vezes a mesma pessoa.
  visitante text,
  -- Quando o portal mandar os dados do cliente.
  nome text,
  telefone text,
  lead_id uuid references public.leads (id) on delete set null,
  avisado boolean not null default false,
  criado_em timestamptz not null default now()
);

create index cliques_whatsapp_imovel on public.cliques_whatsapp (imovel_codigo, criado_em desc);
create index cliques_whatsapp_corretor on public.cliques_whatsapp (corretor_id, criado_em desc);
create index cliques_whatsapp_visitante on public.cliques_whatsapp (visitante, criado_em desc);

alter table public.cliques_whatsapp enable row level security;

-- O gestor vê tudo; o corretor, os cliques dos imóveis dele.
create policy "Gestor vê todos os cliques, corretor os seus" on public.cliques_whatsapp
  for select to authenticated
  using ((select interno.sou_gestor()) or corretor_id = (select interno.meu_corretor_id()));

grant select on public.cliques_whatsapp to authenticated;

-- Chamada pelo site (chave pública). Grava o clique e, se for o primeiro da mesma
-- pessoa nesse imóvel em 10 minutos, pede o aviso à função avisos.
create or replace function public.registrar_clique_whatsapp(p_referencia text, p_visitante text default null)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_imovel public.imoveis;
  v_visitante text := nullif(left(regexp_replace(coalesce(p_visitante, ''), '[^A-Za-z0-9-]', '', 'g'), 40), '');
  v_avisar boolean;
  v_id bigint;
begin
  select * into v_imovel
  from public.imoveis
  where upper(referencia) = upper(trim(p_referencia)) and ativo
  limit 1;
  if not found then
    return;
  end if;

  -- Freio contra abuso: o mesmo navegador registra no máximo 30 cliques por hora.
  if v_visitante is not null and (
    select count(*) from public.cliques_whatsapp c
    where c.visitante = v_visitante and c.criado_em > now() - interval '1 hour'
  ) >= 30 then
    return;
  end if;

  v_avisar := v_visitante is null or not exists (
    select 1 from public.cliques_whatsapp c
    where c.visitante = v_visitante and c.imovel_codigo = v_imovel.codigo and c.avisado
      and c.criado_em > now() - interval '10 minutes'
  );

  insert into public.cliques_whatsapp (imovel_codigo, corretor_id, origem, visitante, avisado)
  values (v_imovel.codigo, interno.corretor_do_captador(v_imovel.captador), 'site', v_visitante, v_avisar)
  returning id into v_id;

  if v_avisar then
    perform net.http_post(
      url := 'https://nlbonjxmzmwsyuirxnzu.supabase.co/functions/v1/avisos',
      body := jsonb_build_object('clique_id', v_id),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-avisos-chave', (select decrypted_secret from vault.decrypted_secrets where name = 'avisos_chave')
      ),
      timeout_milliseconds := 15000
    );
  end if;
end;
$function$;

revoke all on function public.registrar_clique_whatsapp(text, text) from public;
grant execute on function public.registrar_clique_whatsapp(text, text) to anon, authenticated;
