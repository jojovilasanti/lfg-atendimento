-- Aviso ao corretor pelo WhatsApp. Cada lead oferecido no rodízio dispara, na
-- hora, a mensagem-modelo "novo_lead" para o WhatsApp do corretor (função
-- "avisos"), com os botões Assumir e Não posso agora. O toque no botão volta
-- pelo webhook do WhatsApp e cai em responder_oferta.

create extension if not exists pg_net with schema extensions;

alter table public.atribuicoes
  add column aviso_whatsapp_id text,
  add column aviso_status text;
comment on column public.atribuicoes.aviso_status is 'Aviso no WhatsApp do corretor: enviado, delivered, read, "falhou: ...", sem_whatsapp ou simulado.';
create index atribuicoes_aviso_idx on public.atribuicoes (aviso_whatsapp_id) where aviso_whatsapp_id is not null;

-- Chave com que o banco chama a função "avisos": o valor fica no Vault e o
-- hash em chaves_acesso, como as outras chaves internas.
do $$
declare
  v_chave text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  perform vault.create_secret(v_chave, 'avisos_chave', 'Chave do banco para chamar a função avisos');
  insert into public.chaves_acesso (nome, hash_sha256) values ('avisos', encode(extensions.digest(v_chave, 'sha256'), 'hex'));
end;
$$;

-- O pedido sai só depois que a oferta é gravada (o pg_net envia após o commit).
create function interno.avisar_corretor() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform net.http_post(
    url := 'https://nlbonjxmzmwsyuirxnzu.supabase.co/functions/v1/avisos',
    body := jsonb_build_object('atribuicao_id', new.id),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-avisos-chave', (select decrypted_secret from vault.decrypted_secrets where name = 'avisos_chave')
    ),
    timeout_milliseconds := 15000
  );
  return new;
end;
$$;

create trigger atribuicoes_avisar_corretor
  after insert on public.atribuicoes
  for each row when (new.status = 'pendente')
  execute function interno.avisar_corretor();

-- Toque do corretor nos botões do aviso. Só o servidor chama, com as formas do
-- número que a Meta mandou (com e sem o 9); a oferta precisa ser desse corretor.
create function public.responder_oferta(p_atribuicao_id uuid, p_whatsapp text[], p_aceitar boolean)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_atribuicao public.atribuicoes;
  v_corretor public.corretores;
  v_lead public.leads;
  v_proxima jsonb;
begin
  select * into v_atribuicao from public.atribuicoes where id = p_atribuicao_id for update;
  select * into v_corretor from public.corretores
  where id = v_atribuicao.corretor_id and whatsapp = any (p_whatsapp);
  if v_atribuicao.id is null or v_corretor.id is null then
    return jsonb_build_object('situacao', 'nao_encontrada');
  end if;
  if v_atribuicao.status <> 'pendente' then
    return jsonb_build_object('situacao', 'indisponivel', 'status', v_atribuicao.status);
  end if;

  if p_aceitar then
    v_lead := interno.aceitar_atribuicao(p_atribuicao_id, v_corretor.id);
    return jsonb_build_object(
      'situacao', 'aceita',
      'corretor_nome', v_corretor.nome,
      'lead_id', v_lead.id,
      'lead_nome', v_lead.nome,
      'lead_whatsapp', v_lead.whatsapp,
      'resumo', v_lead.resumo
    );
  end if;

  update public.atribuicoes set status = 'recusada', respondida_em = now() where id = p_atribuicao_id;
  v_proxima := public.oferecer_lead(v_atribuicao.lead_id);
  return jsonb_build_object('situacao', 'recusada', 'proxima', v_proxima ->> 'situacao');
end;
$$;

revoke execute on function public.responder_oferta(uuid, text[], boolean) from public, anon, authenticated;
grant execute on function public.responder_oferta(uuid, text[], boolean) to service_role;
