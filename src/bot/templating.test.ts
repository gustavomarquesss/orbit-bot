import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  renderTemplate,
  extractCountdownDirectives,
  extractMessageEffectId,
  parseButtonLabel,
} from "./templating.js";

const lead = {
  id: "lead-1",
  telegramId: 123456789n,
  firstName: "Ana",
} as never;
const bot = { displayName: "Meu Bot", telegramUsername: "meu_bot" };

describe("renderTemplate — variáveis fixas", () => {
  it("substitui profile_name/nome, telegram_user_id, bot.*", () => {
    const out = renderTemplate("Oi {profile_name} ({nome})! ID {telegram_user_id}. Bot: {bot.nome} @{bot.username}", { lead, bot });
    expect(out).toBe("Oi Ana (Ana)! ID 123456789. Bot: Meu Bot @meu_bot");
  });

  it("gera random_id alfanumérico de 6 chars, diferente a cada chamada", () => {
    const a = renderTemplate("{random_id}", { lead, bot });
    const b = renderTemplate("{random_id}", { lead, bot });
    expect(a).toMatch(/^[0-9A-Z]{6}$/);
    expect(a).not.toBe(b);
  });

  it("campos sem captura de lead (país/estado/cidade) renderizam vazio", () => {
    expect(renderTemplate("[{country}][{state}][{city}][{estado}][{uf}][{cidade}]", { lead, bot })).toBe("[][][][][][]");
  });

  it("extra sobrepõe o valor padrão em caso de colisão de chave", () => {
    expect(renderTemplate("{valor}", { lead, bot, extra: { valor: "R$ 29,90" } })).toBe("R$ 29,90");
  });

  it("mantém placeholder literal se a chave não é reconhecida", () => {
    expect(renderTemplate("{isso_nao_existe}", { lead, bot })).toBe("{isso_nao_existe}");
  });
});

describe("renderTemplate — saudação (greeting/saudacao) por faixa de horário", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const cases: [string, string][] = [
    ["2026-03-04T08:00:00-03:00", "Bom dia"], // 8h BR
    ["2026-03-04T14:00:00-03:00", "Boa tarde"], // 14h BR
    ["2026-03-04T20:00:00-03:00", "Boa noite"], // 20h BR
    ["2026-03-04T02:00:00-03:00", "Boa madrugada"], // 2h BR
  ];
  it.each(cases)("%s -> %s", (iso, expected) => {
    vi.setSystemTime(new Date(iso));
    expect(renderTemplate("{greeting}", { lead, bot })).toBe(expected);
    expect(renderTemplate("{saudacao}", { lead, bot })).toBe(expected);
  });
});

describe("renderTemplate — data/hora (fuso America/Sao_Paulo, sem DST)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 2026-03-04T17:35:42Z = 14:35:42 em Brasília (UTC-3).
    vi.setSystemTime(new Date("2026-03-04T17:35:42.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("time/time_sec/date/day/month/year no fuso certo, não em UTC", () => {
    expect(renderTemplate("{time}", { lead, bot })).toBe("14:35");
    expect(renderTemplate("{time_sec}", { lead, bot })).toBe("14:35:42");
    expect(renderTemplate("{date}", { lead, bot })).toBe("04/03/2026");
    expect(renderTemplate("{day}", { lead, bot })).toBe("04");
    expect(renderTemplate("{month}", { lead, bot })).toBe("03");
    expect(renderTemplate("{year}", { lead, bot })).toBe("2026");
  });

  it("weekday/month_ext/date_ext são consistentes entre si e capitalizados", () => {
    const weekday = renderTemplate("{weekday}", { lead, bot });
    const monthExt = renderTemplate("{month_ext}", { lead, bot });
    const dateExt = renderTemplate("{date_ext}", { lead, bot });
    expect(weekday[0]).toBe(weekday[0].toUpperCase());
    expect(monthExt[0]).toBe(monthExt[0].toUpperCase());
    expect(dateExt).toBe(`${weekday}, 04 de ${monthExt} de 2026`);
  });
});

describe("renderTemplate — aritmética de data ({time+1}, {date+7}, etc)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-04T17:35:00.000Z")); // 14:35 BR
  });
  afterEach(() => vi.useRealTimers());

  it("{time+1}/{time-2} deslocam em horas inteiras", () => {
    expect(renderTemplate("{time+1}", { lead, bot })).toBe("15:35");
    expect(renderTemplate("{time-2}", { lead, bot })).toBe("12:35");
  });

  it("{time+0:15}/{time+1:30} deslocam em horas:minutos", () => {
    expect(renderTemplate("{time+0:15}", { lead, bot })).toBe("14:50");
    expect(renderTemplate("{time+1:30}", { lead, bot })).toBe("16:05");
  });

  it("{date+1}/{date-1}/{date+7} deslocam em dias, formatado como {date}", () => {
    expect(renderTemplate("{date+1}", { lead, bot })).toBe("05/03/2026");
    expect(renderTemplate("{date-1}", { lead, bot })).toBe("03/03/2026");
    expect(renderTemplate("{date+7}", { lead, bot })).toBe("11/03/2026");
  });

  it("{month+1}/{year+1} deslocam mês/ano, com rollover de ano quando aplicável", () => {
    expect(renderTemplate("{month+1}", { lead, bot })).toBe("04");
    expect(renderTemplate("{year+1}", { lead, bot })).toBe("2027");
  });
});

describe("renderTemplate — countdown e effect no texto", () => {
  it("{countdown:S} vira o valor INICIAL formatado MM:SS (o tick ao vivo é responsabilidade do scheduler)", () => {
    expect(renderTemplate("Expira em {countdown:300}", { lead, bot })).toBe("Expira em 05:00");
    expect(renderTemplate("{countdown:180:10}", { lead, bot })).toBe("03:00");
    expect(renderTemplate("{countdown:120:5:delete}", { lead, bot })).toBe("02:00");
  });

  it("{countdown:S} é limitado a 30s-5min mesmo se o admin digitar fora do limite", () => {
    expect(renderTemplate("{countdown:5}", { lead, bot })).toBe("00:30");
    expect(renderTemplate("{countdown:9999}", { lead, bot })).toBe("05:00");
  });

  it("{effect:...} some do texto visível (vira message_effect_id, não texto)", () => {
    expect(renderTemplate("Oferta! {effect:fire}", { lead, bot })).toBe("Oferta! ");
  });
});

describe("extractCountdownDirectives", () => {
  it("extrai duração/intervalo/delete de cada diretiva, com os limites aplicados", () => {
    const found = extractCountdownDirectives("A {countdown:300} B {countdown:9999:2:delete} C");
    expect(found).toEqual([
      { raw: "{countdown:300}", totalSeconds: 300, intervalSeconds: 5, deleteOnZero: false },
      { raw: "{countdown:9999:2:delete}", totalSeconds: 300, intervalSeconds: 5, deleteOnZero: true },
    ]);
  });

  it("intervalo mínimo de 5s mesmo se o admin pedir menos", () => {
    const [found] = extractCountdownDirectives("{countdown:60:1}");
    expect(found.intervalSeconds).toBe(5);
  });

  it("retorna lista vazia se não há countdown no texto", () => {
    expect(extractCountdownDirectives("sem nada aqui")).toEqual([]);
  });
});

describe("extractMessageEffectId", () => {
  it("resolve cada efeito pro id numérico real da Bot API", () => {
    expect(extractMessageEffectId("{effect:fire}")).toBe("5104841245755180586");
    expect(extractMessageEffectId("{effect:confetti}")).toBe("5046509860389126442");
    expect(extractMessageEffectId("{effect:poop}")).toBe("5046589136895476101");
  });

  it("retorna undefined se não há efeito no texto", () => {
    expect(extractMessageEffectId("mensagem normal")).toBeUndefined();
  });
});

describe("parseButtonLabel", () => {
  it("mapeia os 3 hex reais pro style correspondente da Bot API 9.4", () => {
    expect(parseButtonLabel("Comprar agora {#FF0000}")).toEqual({ text: "Comprar agora", style: "danger" });
    expect(parseButtonLabel("Saiba mais {#0000FF}")).toEqual({ text: "Saiba mais", style: "primary" });
    expect(parseButtonLabel("Confirmar {#00FF00}")).toEqual({ text: "Confirmar", style: "success" });
  });

  it("hex desconhecido (ex: rosa, que não existe na Bot API) é ignorado — texto sem a cor, sem crashar", () => {
    expect(parseButtonLabel("Rosa {#FFCBDB}")).toEqual({ text: "Rosa" });
  });

  it("sem sufixo de cor, retorna o texto como está", () => {
    expect(parseButtonLabel("Botão normal")).toEqual({ text: "Botão normal" });
  });
});
