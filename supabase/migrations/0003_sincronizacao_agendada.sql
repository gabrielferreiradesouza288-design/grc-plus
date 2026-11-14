-- GRC + · Rede de segurança: a cada hora (no minuto 7) confere na API
-- se algum webhook se perdeu e grava o que estiver faltando.
create extension if not exists pg_cron;

select cron.schedule('gptmaker-sync-horario', '7 * * * *', $$select private.sincronizar_gptmaker()$$);
