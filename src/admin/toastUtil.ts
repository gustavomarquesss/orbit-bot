/**
 * Anexa uma mensagem de sucesso na query string de um redirect — lida pelo
 * toast global (ver views/partials/toast.ejs). Os erros já usam o mesmo
 * mecanismo por convenção própria de cada rota (?error=/?fileError=/etc);
 * este helper cobre só o lado de sucesso, que não tinha feedback nenhum
 * até então (pedido do usuário, 2026-08-20).
 */
export function withSuccess(url: string, message = "Salvo com sucesso!"): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}success=${encodeURIComponent(message)}`;
}

/** Mesma ideia de `withSuccess`, pro caso de erro — a maioria das rotas já
 * monta `?error=`/`?fileError=`/etc na mão por convenção própria; este
 * helper só evita repetir a mesma concatenação nos casos novos. */
export function withError(url: string, message: string): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}error=${encodeURIComponent(message)}`;
}
