import type { Lead, Bot } from "@prisma/client";

function saudacao(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Bom dia";
  if (hour < 18) return "Boa tarde";
  return "Boa noite";
}

/**
 * Substitui variáveis `{nome}`/`{email}`/etc no texto rico (HTML restrito
 * ao subset do Telegram) salvo em WelcomeConfig/PaymentMessages. Campos que
 * a Bot API do Telegram não fornece (email/telefone/cidade/estado/uf/
 * localizacao) renderizam vazio — documentado no hint da UI de edição.
 */
export function renderTemplate(
  text: string,
  context: { lead: Lead; bot: Pick<Bot, "displayName" | "telegramUsername"> }
): string {
  const values: Record<string, string> = {
    nome: context.lead.firstName ?? "",
    email: "",
    telefone: "",
    estado: "",
    uf: "",
    cidade: "",
    localizacao: "",
    saudacao: saudacao(),
    "bot.nome": context.bot.displayName ?? "",
    "bot.username": context.bot.telegramUsername ?? "",
  };

  return text.replace(/\{([a-zA-Z0-9_.]+)\}/g, (match, key: string) =>
    key in values ? values[key] : match
  );
}
