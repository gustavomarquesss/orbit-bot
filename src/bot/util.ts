/**
 * Próxima ordem de um item dentro de uma lista já ordenada (WelcomeMedia,
 * RedirectButton, Plan, ...), dado o `order` do último item existente (ou
 * `null` se a lista estiver vazia).
 */
export function nextOrder(lastOrder: number | null | undefined): number {
  return lastOrder == null ? 0 : lastOrder + 1;
}
