-- http: leitura síncrona do XML do Univen dentro do banco.
-- pg_cron: rotinas agendadas (sincronização do estoque, prazos do rodízio).
create extension if not exists http with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;
