-- Notificações do sistema (Web Push) para o corretor: quando o cliente de um
-- lead dele escreve e quando um lead é oferecido a ele. Chegam no celular ou no
-- computador mesmo com o painel fechado ou minimizado.

-- Cada navegador em que a pessoa ativou as notificações.
create table public.push_inscricoes (
  id uuid primary key default gen_random_uuid(),
  corretor_id uuid not null references public.corretores(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  aparelho text,
  criado_em timestamptz not null default now()
);
create index push_inscricoes_corretor_idx on public.push_inscricoes (corretor_id);
alter table public.push_inscricoes enable row level security;
create policy "Cada um vê as próprias notificações" on public.push_inscricoes
  for select to authenticated using (corretor_id = (select interno.meu_corretor_id()));

-- O mesmo navegador pode ter sido de outra pessoa (aparelho compartilhado):
-- a inscrição passa para quem ativou por último.
create function public.registrar_notificacoes(p_endpoint text, p_p256dh text, p_auth text, p_aparelho text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_eu uuid := interno.meu_corretor_id();
begin
  if v_eu is null then
    raise exception 'Entre no painel para ativar as notificações';
  end if;
  insert into public.push_inscricoes (corretor_id, endpoint, p256dh, auth, aparelho)
  values (v_eu, p_endpoint, p_p256dh, p_auth, left(p_aparelho, 200))
  on conflict (endpoint) do update
    set corretor_id = excluded.corretor_id, p256dh = excluded.p256dh, auth = excluded.auth, aparelho = excluded.aparelho, criado_em = now();
end;
$$;

create function public.cancelar_notificacoes(p_endpoint text)
returns void
language sql security definer set search_path = ''
as $$
  delete from public.push_inscricoes where endpoint = p_endpoint and corretor_id = interno.meu_corretor_id();
$$;

revoke execute on function public.registrar_notificacoes(text, text, text, text) from public, anon;
revoke execute on function public.cancelar_notificacoes(text) from public, anon;
grant execute on function public.registrar_notificacoes(text, text, text, text) to authenticated;
grant execute on function public.cancelar_notificacoes(text) to authenticated;

-- Chaves VAPID do envio: são geradas pela função "painel" na primeira vez que
-- alguém ativa. A pública vai para o navegador; a privada fica no Vault.
create function public.guardar_chaves_push(p_publica text, p_privada text)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_publica text;
begin
  select valor #>> '{}' into v_publica from public.configuracoes where chave = 'push_chave_publica';
  if v_publica is not null then
    return v_publica;
  end if;
  perform vault.create_secret(p_privada, 'push_chave_privada', 'Chave privada VAPID das notificações do painel');
  insert into public.configuracoes (chave, valor, descricao)
  values ('push_chave_publica', to_jsonb(p_publica), 'Chave pública VAPID das notificações do painel.');
  return p_publica;
end;
$$;

create function public.chave_privada_push()
returns text
language sql stable security definer set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'push_chave_privada';
$$;

revoke execute on function public.guardar_chaves_push(text, text) from public, anon, authenticated;
revoke execute on function public.chave_privada_push() from public, anon, authenticated;
grant execute on function public.guardar_chaves_push(text, text) to service_role;
grant execute on function public.chave_privada_push() to service_role;

-- Mensagem do cliente: avisa o corretor do lead e quem está com a oferta aberta,
-- se alguém deles ativou as notificações.
create function interno.notificar_resposta_do_cliente() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.push_inscricoes p
    where p.corretor_id in (
      select l.corretor_id from public.leads l where l.id = new.lead_id
      union
      select a.corretor_id from public.atribuicoes a where a.lead_id = new.lead_id and a.status = 'pendente'
    )
  ) then
    return new;
  end if;
  perform net.http_post(
    url := 'https://nlbonjxmzmwsyuirxnzu.supabase.co/functions/v1/avisos',
    body := jsonb_build_object('notificar_mensagem_id', new.id),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-avisos-chave', (select decrypted_secret from vault.decrypted_secrets where name = 'avisos_chave')
    ),
    timeout_milliseconds := 15000
  );
  return new;
end;
$$;

create trigger mensagens_notificar_corretor
after insert on public.mensagens
for each row when (new.autor = 'cliente')
execute function interno.notificar_resposta_do_cliente();
