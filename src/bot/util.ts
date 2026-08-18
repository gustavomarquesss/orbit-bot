const CALLBACK_PREFIX = "btn:";

export function buildButtonCallbackData(buttonId: string): string {
  return `${CALLBACK_PREFIX}${buttonId}`;
}

export function parseButtonCallbackData(data: string): string | null {
  return data.startsWith(CALLBACK_PREFIX) ? data.slice(CALLBACK_PREFIX.length) : null;
}

/**
 * Próxima ordem de um FlowStep/Button dentro de uma lista já ordenada, dado
 * o `order` do último item existente (ou `null` se a lista estiver vazia).
 */
export function nextOrder(lastOrder: number | null | undefined): number {
  return lastOrder == null ? 0 : lastOrder + 1;
}
