import type { Lead, Bot } from "@prisma/client";

// Brasil não observa horário de verão desde 2019 — usar o timezone IANA via
// Intl é mais correto que um offset fixo mesmo assim (lida certo com o
// relógio do servidor rodando em qualquer timezone, ex: produção em UTC).
const BR_TIME_ZONE = "America/Sao_Paulo";

function formatBR(date: Date, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: BR_TIME_ZONE, ...opts }).format(date);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Faixas exatas pedidas pelo usuário (2026-08-20): Bom dia 5h–11h, Boa tarde
 * 12h–17h, Boa noite 18h–23h, Boa madrugada 0h–4h — diferente da versão
 * anterior (que não tinha "madrugada").
 */
function greeting(date: Date): string {
  const hour = Number(formatBR(date, { hour: "2-digit", hour12: false }));
  if (hour >= 5 && hour < 12) return "Bom dia";
  if (hour >= 12 && hour < 18) return "Boa tarde";
  if (hour >= 18) return "Boa noite";
  return "Boa madrugada";
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function dateExtenso(date: Date): string {
  const weekday = capitalize(formatBR(date, { weekday: "long" }));
  const day = formatBR(date, { day: "2-digit" });
  const month = capitalize(formatBR(date, { month: "long" }));
  const year = formatBR(date, { year: "numeric" });
  return `${weekday}, ${day} de ${month} de ${year}`;
}

/** Desloca uma data em minutos/dias/meses/anos, preservando o instante UTC
 * subjacente (Brasil sem DST torna a aritmética direta segura). */
function shiftDate(base: Date, unit: "time" | "date" | "month" | "year", minutesOrAmount: number): Date {
  const d = new Date(base);
  if (unit === "time") d.setUTCMinutes(d.getUTCMinutes() + minutesOrAmount);
  else if (unit === "date") d.setUTCDate(d.getUTCDate() + minutesOrAmount);
  else if (unit === "month") d.setUTCMonth(d.getUTCMonth() + minutesOrAmount);
  else d.setUTCFullYear(d.getUTCFullYear() + minutesOrAmount);
  return d;
}

function formatMMSS(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const EFFECT_IDS: Record<string, string> = {
  fire: "5104841245755180586",
  confetti: "5046509860389126442",
  heart: "5159385139981059251",
  thumbsup: "5107584321108051014",
  thumbsdown: "5104858069142078462",
  poop: "5046589136895476101",
};

/** Achado pesquisando a Bot API 9.4 (fev/2026): só existem 3 cores reais de
 * botão (primary=azul, success=verde, danger=vermelho) — não é hex livre. */
export type ButtonStyle = "primary" | "success" | "danger";
const BUTTON_COLOR_MAP: Record<string, ButtonStyle> = {
  "#FF0000": "danger",
  "#0000FF": "primary",
  "#00FF00": "success",
};

// Regex ampliada pra cobrir os novos formatos: dois-pontos (countdown/efeito),
// mais/menos (aritmética de data), ponto (bot.username já existente).
const PLACEHOLDER_RE = /\{([a-zA-Z0-9_.:+-]+)\}/g;
const ARITHMETIC_RE = /^(time|date|month|year)([+-]\d+)(?::(\d+))?$/;
const COUNTDOWN_RE = /^countdown:(\d+)(?::(\d+))?(?::delete)?$/;
const EFFECT_RE = /^effect:(fire|confetti|heart|thumbsup|thumbsdown|poop)$/;

/**
 * Substitui variáveis no texto rico (HTML restrito ao subset do Telegram)
 * salvo em WelcomeConfig/PaymentMessages/etc. Cobre: variáveis fixas de
 * usuário/localização/data-hora, aritmética de data ({time+1}, {date+7}...),
 * o valor INICIAL de um `{countdown:...}` (a contagem ao vivo de verdade é
 * responsabilidade de src/bot/countdownScheduler.ts, que edita a mensagem
 * depois de enviada) e remove `{effect:...}` do texto visível (isso vira
 * `message_effect_id` na chamada de envio, não texto — ver
 * extractMessageEffectId). Campos que o Telegram não fornece (email/
 * telefone/país/estado/cidade — precisariam de captura de lead que não
 * existe) renderizam vazio, documentado no hint da UI de edição.
 */
export function renderTemplate(
  text: string,
  context: {
    lead: Lead;
    bot: Pick<Bot, "displayName" | "telegramUsername">;
    /** Extras específicos de contexto (ex: {valor}/{plano} nas mensagens de
     * pagamento) — sobrepõem os valores padrão se houver colisão de chave. */
    extra?: Record<string, string>;
  }
): string {
  const now = new Date();

  const values: Record<string, string> = {
    // Novo padrão (2026-08-20) + aliases antigos em pt-BR mantidos pra não
    // quebrar texto já salvo.
    profile_name: context.lead.firstName ?? "",
    nome: context.lead.firstName ?? "",
    telegram_user_id: context.lead.telegramId.toString(),
    random_id: randomId(),
    greeting: greeting(now),
    saudacao: greeting(now),
    email: "",
    telefone: "",
    country: "",
    state: "",
    estado: "",
    uf: "",
    city: "",
    cidade: "",
    localizacao: "",
    time: formatBR(now, { hour: "2-digit", minute: "2-digit", hour12: false }),
    time_sec: formatBR(now, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }),
    date: formatBR(now, { day: "2-digit", month: "2-digit", year: "numeric" }),
    date_ext: dateExtenso(now),
    day: formatBR(now, { day: "2-digit" }),
    month: formatBR(now, { month: "2-digit" }),
    month_ext: capitalize(formatBR(now, { month: "long" })),
    year: formatBR(now, { year: "numeric" }),
    weekday: capitalize(formatBR(now, { weekday: "long" })),
    "bot.nome": context.bot.displayName ?? "",
    "bot.username": context.bot.telegramUsername ?? "",
    qr_code: "[QR Code enviado como imagem separada]",
    ...context.extra,
  };

  return text.replace(PLACEHOLDER_RE, (match, key: string) => {
    const arithmetic = key.match(ARITHMETIC_RE);
    if (arithmetic) {
      const [, unit, signedAmount, minutesPart] = arithmetic as unknown as [string, "time" | "date" | "month" | "year", string, string | undefined];
      const amount = Number(signedAmount);
      // "time" desloca em MINUTOS (shiftDate exige isso pro unit "time"):
      // sem H:M explícito, o número é horas (ex: {time-2} = -2h = -120min);
      // com H:M, combina horas+minutos no mesmo sinal do prefixo.
      const offset =
        unit === "time"
          ? minutesPart != null
            ? (amount < 0 ? -1 : 1) * (Math.abs(amount) * 60 + Number(minutesPart))
            : amount * 60
          : amount;
      const shifted = shiftDate(now, unit, offset);
      if (unit === "time") return formatBR(shifted, { hour: "2-digit", minute: "2-digit", hour12: false });
      if (unit === "date") return formatBR(shifted, { day: "2-digit", month: "2-digit", year: "numeric" });
      if (unit === "month") return formatBR(shifted, { month: "2-digit" });
      return formatBR(shifted, { year: "numeric" });
    }

    const countdown = key.match(COUNTDOWN_RE);
    if (countdown) {
      const totalSeconds = Math.min(300, Math.max(30, Number(countdown[1])));
      return formatMMSS(totalSeconds);
    }

    if (EFFECT_RE.test(key)) return "";

    return key in values ? values[key] : match;
  });
}

export interface CountdownDirective {
  /** Substring exata `{countdown:...}` — usada pra saber o que reescrever a cada tick. */
  raw: string;
  totalSeconds: number;
  intervalSeconds: number;
  deleteOnZero: boolean;
}

/** Duração 30s–5min, intervalo mínimo 5s — limites exatos pedidos pelo usuário. */
export function extractCountdownDirectives(rawTemplate: string): CountdownDirective[] {
  const found: CountdownDirective[] = [];
  const re = /\{countdown:(\d+)(?::(\d+))?(:delete)?\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rawTemplate))) {
    found.push({
      raw: m[0],
      totalSeconds: Math.min(300, Math.max(30, Number(m[1]))),
      intervalSeconds: Math.max(5, Number(m[2] ?? 5)),
      deleteOnZero: m[3] === ":delete",
    });
  }
  return found;
}

/** Só o primeiro `{effect:...}` do texto é usado — a Bot API só aceita um
 * `message_effect_id` por mensagem, e só funciona em chat privado e só no
 * envio (não em edição). */
export function extractMessageEffectId(rawTemplate: string): string | undefined {
  const m = rawTemplate.match(/\{effect:(fire|confetti|heart|thumbsup|thumbsdown|poop)\}/);
  return m ? EFFECT_IDS[m[1]] : undefined;
}

export interface ParsedButtonLabel {
  text: string;
  style?: ButtonStyle;
}

/** `{#FF0000}`/`{#0000FF}`/`{#00FF00}` no final do texto do botão vira a cor
 * real suportada pela Bot API 9.4 (primary/success/danger — não há hex
 * livre; qualquer outro hex é ignorado, o texto some mas sem cor). */
export function parseButtonLabel(label: string): ParsedButtonLabel {
  const match = label.match(/\s*\{(#[0-9A-Fa-f]{6})\}\s*$/);
  if (!match) return { text: label };
  const style = BUTTON_COLOR_MAP[match[1].toUpperCase()];
  const text = label.slice(0, match.index).trimEnd();
  return style ? { text, style } : { text };
}
