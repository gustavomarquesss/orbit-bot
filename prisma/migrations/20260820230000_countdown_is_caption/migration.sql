-- Marca se o contador ao vivo edita uma legenda de mídia (editMessageCaption)
-- em vez de texto de mensagem (editMessageText) — sem isso a Bot API rejeita
-- a edição e o contador fica travado no marcador " COUNTDOWN " pra sempre.
ALTER TABLE "ScheduledCountdownEdit" ADD COLUMN "isCaption" BOOLEAN NOT NULL DEFAULT false;
