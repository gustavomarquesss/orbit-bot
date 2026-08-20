-- Reverte a decisão de "canal de mídias por bot" (Bot.mediaChannelId),
-- criada minutos antes nesta mesma sessão — o usuário corrigiu: o upload
-- de mídia deve reusar o mesmo canal já configurado em Settings.salesChannelId
-- (canal de vendas), não um campo novo por bot. Sem dado real em produção
-- ainda (feature nunca chegou a ser usada de verdade).
ALTER TABLE "Bot" DROP COLUMN "mediaChannelId";
