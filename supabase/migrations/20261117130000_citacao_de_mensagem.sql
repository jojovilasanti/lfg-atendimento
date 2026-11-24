-- Resposta citando uma mensagem, como no WhatsApp: guarda o ID (wamid) da
-- mensagem citada, tanto quando o cliente cita quanto quando o corretor cita.
alter table public.mensagens add column cita_whatsapp_id text;

create index if not exists mensagens_whatsapp_id on public.mensagens (whatsapp_id) where whatsapp_id is not null;
