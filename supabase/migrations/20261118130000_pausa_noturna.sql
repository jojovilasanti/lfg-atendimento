-- Pausa noturna do plantão (padrão 00:00 às 06:00, no fuso da empresa).
--
-- Durante a pausa:
--   * a Thais segue atendendo e o rodízio segue escolhendo o corretor;
--   * a oferta é criada, mas o aviso ao corretor fica guardado (aviso_pendente);
--   * nenhum prazo vence: nada é redistribuído nem marcado como perdido.
-- No fim da pausa (job de todo minuto):
--   * os avisos guardados saem e o prazo para assumir começa a contar dali;
--   * prazos que já corriam antes da pausa voltam com o tempo que faltava
--     (ficam congelados durante a pausa).
-- Desligar a pausa com avisos na fila solta tudo na hora.
-- Só o gestor liga, desliga ou muda o horário.

insert into public.configuracoes (chave, valor)
values ('pausa_noturna', '{"ativa": true, "inicio": "00:00", "fim": "06:00"}'::jsonb)
on conflict (chave) do nothing;

alter table public.atribuicoes add column if not exists aviso_pendente boolean not null default false;
comment on column public.atribuicoes.aviso_pendente is
  'Oferta criada na pausa noturna: o aviso ao corretor sai (e o prazo começa) quando a pausa termina.';

-- Quando a pausa começou (para congelar os prazos). Uma linha só.
create table if not exists interno.pausa_estado (
  id boolean primary key default true check (id),
  desde timestamptz
);
insert into interno.pausa_estado (id, desde) values (true, null) on conflict (id) do nothing;

-- A pausa vale neste instante? Atravessa a meia-noite quando o início é depois do fim.
create or replace function interno.em_pausa(p_quando timestamptz)
 returns boolean
 language sql
 stable security definer
 set search_path to ''
as $$
  select coalesce((
    select case
      when not coalesce((c.valor ->> 'ativa')::boolean, false) then false
      when (c.valor ->> 'inicio')::time = (c.valor ->> 'fim')::time then false
      when (c.valor ->> 'inicio')::time < (c.valor ->> 'fim')::time then
        (p_quando at time zone interno.fuso())::time >= (c.valor ->> 'inicio')::time
        and (p_quando at time zone interno.fuso())::time < (c.valor ->> 'fim')::time
      else
        (p_quando at time zone interno.fuso())::time >= (c.valor ->> 'inicio')::time
        or (p_quando at time zone interno.fuso())::time < (c.valor ->> 'fim')::time
    end
    from public.configuracoes c where c.chave = 'pausa_noturna'
  ), false);
$$;

-- Próximo fim da pausa depois deste instante.
create or replace function interno.fim_da_pausa(p_quando timestamptz)
 returns timestamptz
 language sql
 stable security definer
 set search_path to ''
as $$
  select case
    when ((p_quando at time zone interno.fuso())::date + (c.valor ->> 'fim')::time) at time zone interno.fuso() > p_quando
      then ((p_quando at time zone interno.fuso())::date + (c.valor ->> 'fim')::time) at time zone interno.fuso()
    else (((p_quando at time zone interno.fuso())::date + 1) + (c.valor ->> 'fim')::time) at time zone interno.fuso()
  end
  from public.configuracoes c where c.chave = 'pausa_noturna';
$$;

-- Toda oferta nova passa por aqui: na pausa, guarda o aviso e põe o prazo a
-- partir do fim da pausa (vale para o rodízio, o captador e a passagem pelo gestor).
create or replace function interno.oferta_na_pausa()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $$
begin
  if new.status = 'pendente' and interno.em_pausa(now()) then
    new.aviso_pendente := true;
    new.prazo_em := interno.fim_da_pausa(now())
      + make_interval(mins => coalesce((select (c.valor #>> '{}')::integer from public.configuracoes c where c.chave = 'prazo_rodizio_minutos'), 15));
  end if;
  return new;
end;
$$;

drop trigger if exists atribuicoes_oferta_na_pausa on public.atribuicoes;
create trigger atribuicoes_oferta_na_pausa
  before insert on public.atribuicoes
  for each row execute function interno.oferta_na_pausa();

-- O aviso ao corretor só sai na hora se não ficou guardado para depois da pausa.
drop trigger if exists atribuicoes_avisar_corretor on public.atribuicoes;
create trigger atribuicoes_avisar_corretor
  after insert on public.atribuicoes
  for each row when (new.status = 'pendente' and not new.aviso_pendente)
  execute function interno.avisar_corretor();

-- Fim da pausa (ou pausa desligada): descongela os prazos e solta os avisos.
create or replace function interno.retomar_depois_da_pausa()
 returns integer
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_desde timestamptz;
  v_parado interval;
  v_minutos integer := coalesce((select (c.valor #>> '{}')::integer from public.configuracoes c where c.chave = 'prazo_rodizio_minutos'), 15);
  v_oferta public.atribuicoes;
  v_total integer := 0;
begin
  if interno.em_pausa(now()) then
    return 0;
  end if;

  select desde into v_desde from interno.pausa_estado where id for update;
  if v_desde is not null then
    v_parado := now() - v_desde;
    -- Prazos que corriam quando a pausa começou: voltam com o tempo que faltava.
    update public.atribuicoes set prazo_em = prazo_em + v_parado
    where status = 'pendente' and not aviso_pendente and prazo_em > v_desde;
    update public.atribuicoes set prazo_resposta_em = prazo_resposta_em + v_parado
    where status = 'aceita' and prazo_resposta_em is not null and prazo_resposta_em > v_desde;
    update interno.pausa_estado set desde = null where id;
  end if;

  -- Avisos guardados: saem agora e o prazo para assumir começa agora.
  for v_oferta in
    update public.atribuicoes
    set aviso_pendente = false,
        prazo_em = case when status = 'pendente' then now() + make_interval(mins => v_minutos) else prazo_em end
    where aviso_pendente
    returning *
  loop
    if v_oferta.status = 'pendente' then
      perform net.http_post(
        url := 'https://nlbonjxmzmwsyuirxnzu.supabase.co/functions/v1/avisos',
        body := jsonb_build_object('atribuicao_id', v_oferta.id),
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-avisos-chave', (select decrypted_secret from vault.decrypted_secrets where name = 'avisos_chave')
        ),
        timeout_milliseconds := 15000
      );
      v_total := v_total + 1;
    end if;
  end loop;
  return v_total;
end;
$$;

-- Job de todo minuto: na pausa, só marca quando ela começou e não vence nada.
do $$
declare v_def text;
begin
  select pg_get_functiondef('interno.processar_prazos_rodizio'::regproc) into v_def;
  v_def := replace(v_def, 'begin
  for v_expirada in
    update public.atribuicoes set status = ''expirada'', perdeu_prazo = ''assumir''',
'begin
  -- Pausa noturna: nada vence nem é redistribuído; os prazos ficam congelados.
  if interno.em_pausa(now()) then
    update interno.pausa_estado set desde = coalesce(desde, now()) where id;
    return 0;
  end if;
  perform interno.retomar_depois_da_pausa();

  for v_expirada in
    update public.atribuicoes set status = ''expirada'', perdeu_prazo = ''assumir''');
  if v_def not like '%interno.em_pausa(now())%' then
    raise exception 'processar_prazos_rodizio: início não encontrado';
  end if;
  execute v_def;
end $$;

-- A oferta conta à IA se o aviso ficou para depois da pausa.
do $$
declare v_def text;
begin
  select pg_get_functiondef('public.oferecer_lead'::regproc) into v_def;
  v_def := replace(v_def, '''prazo_em'', v_pendente.prazo_em,
    ''motivo'', v_motivo
  );', '''prazo_em'', v_pendente.prazo_em,
    ''motivo'', v_motivo,
    ''aviso_pendente'', v_pendente.aviso_pendente,
    ''avisar_em'', case when v_pendente.aviso_pendente then interno.fim_da_pausa(now()) end
  );');
  if v_def not like '%''aviso_pendente'', v_pendente.aviso_pendente%' then
    raise exception 'oferecer_lead: retorno não encontrado';
  end if;
  execute v_def;
end $$;

-- Configuração: só o gestor muda (o administrativo também não).
drop policy if exists "Gestor altera as configurações" on public.configuracoes;
create policy "Gestor altera as configurações" on public.configuracoes for update to authenticated
  using ((select interno.sou_gestor_pleno()) or ((select interno.sou_gestor()) and chave not in ('site', 'disparos', 'pausa_noturna')))
  with check ((select interno.sou_gestor_pleno()) or ((select interno.sou_gestor()) and chave not in ('site', 'disparos', 'pausa_noturna')));

create or replace function public.salvar_pausa_noturna(p_ativa boolean, p_inicio text, p_fim text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_valor jsonb;
begin
  if not interno.sou_gestor_pleno() then
    raise exception 'Só o gestor muda a pausa noturna';
  end if;
  if coalesce(p_inicio, '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or coalesce(p_fim, '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    raise exception 'Informe o início e o fim no formato HH:MM';
  end if;
  if p_inicio = p_fim then
    raise exception 'O início e o fim da pausa precisam ser diferentes';
  end if;
  v_valor := jsonb_build_object('ativa', coalesce(p_ativa, false), 'inicio', p_inicio, 'fim', p_fim);
  insert into public.configuracoes (chave, valor) values ('pausa_noturna', v_valor)
  on conflict (chave) do update set valor = excluded.valor;
  -- Desligou (ou o novo horário já não cobre agora): solta a fila na hora.
  perform interno.retomar_depois_da_pausa();
  return v_valor;
end;
$$;
revoke all on function public.salvar_pausa_noturna(boolean, text, text) from public, anon;
grant execute on function public.salvar_pausa_noturna(boolean, text, text) to authenticated;

-- Painel: regras do rodízio trazem a pausa (para mostrar a quem é da gestão).
do $$
declare v_def text;
begin
  select pg_get_functiondef('public.regras_do_rodizio'::regproc) into v_def;
  v_def := replace(v_def, '''prazo_resposta_minutos'', coalesce((select (c.valor #>> ''{}'')::integer from public.configuracoes c where c.chave = ''prazo_resposta_minutos''), 5)
    )', '''prazo_resposta_minutos'', coalesce((select (c.valor #>> ''{}'')::integer from public.configuracoes c where c.chave = ''prazo_resposta_minutos''), 5),
      ''pausa_noturna'', (select c.valor from public.configuracoes c where c.chave = ''pausa_noturna''),
      ''em_pausa'', interno.em_pausa(now())
    )');
  if v_def not like '%''em_pausa'', interno.em_pausa(now())%' then
    raise exception 'regras_do_rodizio: trecho não encontrado';
  end if;
  execute v_def;
end $$;
