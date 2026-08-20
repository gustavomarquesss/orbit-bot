import { Prisma } from "@prisma/client";

export function formatBRL(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export function formatSecondsDuration(totalSeconds: number | null): string {
  if (totalSeconds == null) return "—";
  const s = Math.max(0, Math.round(totalSeconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// Brasil não observa horário de verão desde 2019 — deslocamento fixo é
// suficiente pra calcular o início do dia local sem precisar de lib de
// timezone nova. Usado pelos cortes "hoje"/"ontem" e pelas quebras por
// hora/dia da semana em horário local (dashboard e Estatísticas).
export const BR_OFFSET_MS = 3 * 60 * 60 * 1000;

export function startOfDayBR(date: Date): Date {
  const shifted = new Date(date.getTime() - BR_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() + BR_OFFSET_MS);
}

/**
 * Resolve o período do dashboard/estatísticas em um intervalo de datas.
 * `start`/`end` limitam as métricas (`end: null` = até agora); `chartStart`
 * limita só gráficos de série temporal — em "total" as métricas continuam
 * all-time, mas o gráfico é limitado aos últimos 90 dias (um bar por dia
 * desde o início do projeto não seria legível nem útil).
 */
export function resolvePeriodRange(period: string): { start: Date; end: Date | null; chartStart: Date } {
  const todayStart = startOfDayBR(new Date());
  const daysAgo = (n: number) => new Date(todayStart.getTime() - n * 86_400_000);

  switch (period) {
    case "hoje":
      return { start: todayStart, end: null, chartStart: todayStart };
    case "ontem":
      return { start: daysAgo(1), end: todayStart, chartStart: daysAgo(1) };
    case "30d":
      return { start: daysAgo(29), end: null, chartStart: daysAgo(29) };
    case "total":
      return { start: new Date(0), end: null, chartStart: daysAgo(89) };
    case "7d":
    default:
      return { start: daysAgo(6), end: null, chartStart: daysAgo(6) };
  }
}

/** Condição SQL opcional (`AND col = valor`) — evita repetir o padrão
 * `Prisma.sql\`AND ...\` : Prisma.empty` em toda query raw deste módulo. */
export function optionalSql(condition: boolean, sql: Prisma.Sql): Prisma.Sql {
  return condition ? sql : Prisma.empty;
}
