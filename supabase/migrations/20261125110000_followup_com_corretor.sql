-- Follow-up quando o corretor já assumiu o lead (pedido de 24/11):
--   * O sistema acompanha os leads "com corretor" (fora os finalizados, perdidos
--     e não clientes). O relógio conta desde a última mensagem nossa (corretor
--     ou Thais).
--   * Com 20 h (alerta_horas): o corretor recebe uma notificação no app.
--   * Com 24 h (followup_horas), só no horário comercial: a Thais manda um
--     follow-up. Se o cliente falou nas últimas 23 h, ela escreve lendo a
--     conversa (texto livre); se não, sai a mensagem-modelo aprovada pela Meta.
--     A IA continua pausada: se o cliente responder, quem atende é o corretor.
--   * No máximo "maximo" follow-ups seguidos sem resposta; depois, o gestor é
--     avisado e não sai mais nada automático.
--   * Quem envia é a função followup-corretor (cron a cada 5 minutos).
--   * Só o gestor liga, desliga e muda os prazos.

insert into public.configuracoes (chave, valor)
values ('followup_corretor', jsonb_build_object(
  'ativo', false, 'alerta_horas', 20, 'followup_horas', 24, 'maximo', 3, 'modelo', 'retomar_conversa'
))
on conflict (chave) do nothing;

alter table public.leads add column if not exists monitor_alerta_ref timestamptz;
alter table public.leads add column if not exists monitor_esgotado_ref timestamptz;
alter table public.leads add column if not exists monitor_tentativa_em timestamptz;
comment on column public.leads.monitor_alerta_ref is 'Follow-up com corretor: a última mensagem nossa pela qual o corretor já foi avisado (20 h).';

-- O que fazer agora em cada lead com corretor: alerta (20 h), followup (24 h,
-- no horário comercial) ou esgotado (já foram os follow-ups e ninguém respondeu).
create or replace function public.monitor_corretor_pendentes(p_incluir_testes boolean default false)
 returns table (lead_id uuid, acao text, corretor_id uuid, nome text, whatsapp text, referencia timestamptz, horas numeric, ultima_do_cliente timestamptz, seguidos integer)
 language plpgsql
 stable security definer
 set search_path to ''
as $$
declare
  v_cfg jsonb := coalesce((select c.valor from public.configuracoes c where c.chave = 'followup_corretor'), '{}'::jsonb);
  v_alerta interval := make_interval(mins => round(coalesce((v_cfg ->> 'alerta_horas')::numeric, 20) * 60)::integer);
  v_followup interval := make_interval(mins => round(coalesce((v_cfg ->> 'followup_horas')::numeric, 24) * 60)::integer);
  v_maximo integer := coalesce((v_cfg ->> 'maximo')::integer, 3);
  v_comercial boolean := interno.no_comercial(now());
begin
  if not coalesce((v_cfg ->> 'ativo')::boolean, false) and not p_incluir_testes then
    return;
  end if;
  return query
  with base as (
    select l.id, l.corretor_id, l.nome, l.whatsapp, l.monitor_alerta_ref, l.monitor_esgotado_ref, l.monitor_tentativa_em,
      greatest(
        (select max(m.criado_em) from public.mensagens m where m.lead_id = l.id and m.autor in ('corretor', 'ia')),
        (select max(a.respondida_em) from public.atribuicoes a where a.lead_id = l.id and a.status = 'aceita'),
        l.status_desde
      ) as ref,
      (select max(m.criado_em) from public.mensagens m where m.lead_id = l.id and m.autor = 'cliente') as do_cliente
    from public.leads l
    where l.status = 'com_corretor' and l.corretor_id is not null and l.excluido_em is null
      and not interno.eh_nao_cliente(l.categoria) and not l.ia_ativa
      and (p_incluir_testes or l.whatsapp not like 'sim-%')
  ),
  contagem as (
    select b.*,
      -- Follow-ups seguidos desde a última mensagem do cliente ou do corretor.
      (select count(*) from public.mensagens m
        where m.lead_id = b.id and m.tipo = 'followup_corretor'
          and m.criado_em > coalesce((select max(x.criado_em) from public.mensagens x
            where x.lead_id = b.id and (x.autor in ('cliente', 'corretor') or (x.autor = 'ia' and x.tipo is distinct from 'followup_corretor'))), '-infinity'::timestamptz)
      )::integer as seguidos
    from base b
    where b.ref is not null
  )
  select k.id,
    case
      when k.seguidos >= v_maximo then 'esgotado'
      when now() - k.ref >= v_followup and v_comercial
        and (k.monitor_tentativa_em is null or k.monitor_tentativa_em < now() - interval '6 hours' or k.monitor_tentativa_em < k.ref) then 'followup'
      else 'alerta'
    end,
    k.corretor_id, k.nome, k.whatsapp, k.ref,
    round(extract(epoch from (now() - k.ref)) / 3600, 1), k.do_cliente, k.seguidos
  from contagem k
  where (k.seguidos >= v_maximo and k.monitor_esgotado_ref is distinct from k.ref)
     or (k.seguidos < v_maximo and now() - k.ref >= v_followup and v_comercial
         and (k.monitor_tentativa_em is null or k.monitor_tentativa_em < now() - interval '6 hours' or k.monitor_tentativa_em < k.ref))
     or (k.seguidos < v_maximo and now() - k.ref >= v_alerta and k.monitor_alerta_ref is distinct from k.ref);
end;
$$;
revoke all on function public.monitor_corretor_pendentes(boolean) from public, anon, authenticated;

create or replace function public.salvar_followup_corretor(p_ativo boolean, p_alerta_horas numeric, p_followup_horas numeric, p_maximo integer)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_valor jsonb;
begin
  if not interno.sou_gestor_pleno() then
    raise exception 'Só o gestor muda o acompanhamento dos leads com corretor';
  end if;
  if p_alerta_horas is null or p_followup_horas is null or p_alerta_horas < 1 or p_followup_horas > 72 or p_alerta_horas >= p_followup_horas then
    raise exception 'O aviso ao corretor vem antes do follow-up: aviso de 1 h em diante, follow-up até 72 h';
  end if;
  if p_maximo is null or p_maximo not between 1 and 10 then
    raise exception 'De 1 a 10 follow-ups seguidos';
  end if;
  v_valor := coalesce((select valor from public.configuracoes where chave = 'followup_corretor'), '{}'::jsonb)
    || jsonb_build_object('ativo', coalesce(p_ativo, false), 'alerta_horas', p_alerta_horas, 'followup_horas', p_followup_horas, 'maximo', p_maximo);
  insert into public.configuracoes (chave, valor) values ('followup_corretor', v_valor)
  on conflict (chave) do update set valor = excluded.valor;
  return v_valor;
end;
$$;
revoke all on function public.salvar_followup_corretor(boolean, numeric, numeric, integer) from public, anon;
grant execute on function public.salvar_followup_corretor(boolean, numeric, numeric, integer) to authenticated;

-- Cron: só chama a função quando há algo a fazer.
create or replace function interno.chamar_followup_corretor()
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
begin
  if not exists (select 1 from public.monitor_corretor_pendentes(false)) then
    return;
  end if;
  perform net.http_post(
    url := 'https://nlbonjxmzmwsyuirxnzu.supabase.co/functions/v1/followup-corretor',
    body := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-avisos-chave', (select decrypted_secret from vault.decrypted_secrets where name = 'avisos_chave')
    ),
    timeout_milliseconds := 120000
  );
end;
$$;

select cron.unschedule('followup-corretor') where exists (select 1 from cron.job where jobname = 'followup-corretor');
select cron.schedule('followup-corretor', '*/5 * * * *', 'select interno.chamar_followup_corretor()');
