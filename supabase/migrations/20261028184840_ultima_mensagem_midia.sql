-- Prévia da última mensagem na lista de leads também para fotos, áudios e
-- documentos. O áudio chega sem texto e ganha a transcrição segundos depois,
-- por isso o gatilho também roda quando o conteúdo muda.

create or replace function interno.registrar_ultima_mensagem() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  rotulo text := case new.tipo
    when 'audio' then '🎤 Áudio'
    when 'image' then '📷 Foto'
    when 'video' then '🎬 Vídeo'
    when 'document' then '📄 Documento'
  end;
begin
  if new.autor <> 'sistema' then
    update public.leads
    set ultima_mensagem = left(case
          when rotulo is null then new.conteudo
          else rotulo || coalesce(': ' || nullif(new.conteudo, ''), '')
        end, 160),
        ultima_mensagem_autor = new.autor,
        ultima_mensagem_em = new.criado_em
    where id = new.lead_id
      -- Mídia que termina de chegar depois de outra mensagem não volta a ser a última.
      and (tg_op = 'INSERT' or ultima_mensagem_em is null or ultima_mensagem_em <= new.criado_em);
  end if;
  return new;
end;
$$;

drop trigger mensagens_ultima_do_lead on public.mensagens;
create trigger mensagens_ultima_do_lead
  after insert or update of conteudo on public.mensagens
  for each row execute function interno.registrar_ultima_mensagem();

-- O único áudio anterior a esta mudança tinha um aviso no lugar do conteúdo.
update public.mensagens set conteudo = null
where tipo = 'audio' and midia_url is null and conteudo like '[O cliente enviou um áudio%';
