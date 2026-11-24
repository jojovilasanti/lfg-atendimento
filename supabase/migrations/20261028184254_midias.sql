-- Fotos, áudios e PDFs que os clientes mandam pelo WhatsApp.
-- Os arquivos ficam no bucket privado "midias" do Storage, numa pasta por
-- cliente: <whatsapp do cliente>/<id da mídia na Meta>.<extensão>.

alter table public.mensagens add column midia_tipo text;
comment on column public.mensagens.midia_url is 'Caminho do arquivo no bucket "midias": <whatsapp>/<id da mídia>.<extensão>.';
comment on column public.mensagens.midia_tipo is 'Tipo do arquivo (MIME), ex.: image/jpeg, audio/ogg, application/pdf.';

insert into storage.buckets (id, name, public, file_size_limit)
values ('midias', 'midias', false, 20971520)
on conflict (id) do nothing;

-- A equipe vê as mídias só dos leads que ela pode ver; quem grava é o servidor.
create policy "Equipe vê as mídias dos leads permitidos" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'midias'
    and exists (
      select 1 from public.leads l
      where l.whatsapp = (storage.foldername(name))[1] and interno.posso_ver_lead(l.id)
    )
  );

-- Token do serviço de transcrição na VPS: gerado aqui e guardado no Vault, de
-- onde só o servidor (service role) lê. A VPS guarda apenas o hash SHA-256.
-- Rodar esta migração de novo gera outro token: atualize o hash na VPS.
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'transcricao_token', 'Token do serviço de transcrição de áudios na VPS');

create function public.segredo_transcricao() returns text
language sql stable security definer set search_path = ''
as $$ select decrypted_secret from vault.decrypted_secrets where name = 'transcricao_token' $$;

revoke execute on function public.segredo_transcricao() from public, anon, authenticated;
grant execute on function public.segredo_transcricao() to service_role;
