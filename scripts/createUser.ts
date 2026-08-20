import { createInterface } from "node:readline";
import { prisma } from "../src/db/client.js";
import { hashPassword } from "../src/lib/password.js";

/**
 * Cadastro manual de usuário do painel (Fase 3 — multi-tenant). Sem tela
 * pública de auto-cadastro de propósito — só quem tem acesso ao servidor
 * cria conta. `npm run user:create`.
 *
 * Prompts com texto visível (sem mascarar a senha com "*") — script interno
 * de setup, roda raramente; mascarar exigiria alternar pra raw mode no meio
 * de uma sessão de `readline` já aberta, o que conflita com os listeners
 * internos dela (dois handlers de stdin disputando os mesmos bytes).
 * Simplicidade > polimento visual aqui.
 */
async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // Iterador assíncrono em vez de `rl.question()` repetido: `question()`
  // lança ERR_USE_AFTER_CLOSE se o stream de entrada já tiver fechado (ex:
  // stdin vindo de um pipe, que emite EOF assim que os dados acabam) — o
  // iterador simplesmente resolve `done: true` nesse caso, sem lançar.
  const lines = rl[Symbol.asyncIterator]();
  async function ask(promptText: string): Promise<string> {
    process.stdout.write(promptText);
    const { value, done } = await lines.next();
    return done ? "" : value;
  }

  try {
    const email = (await ask("E-mail: ")).trim().toLowerCase();
    if (!email || !email.includes("@")) {
      console.error("E-mail inválido.");
      process.exitCode = 1;
      return;
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      console.error(`Já existe um usuário com o e-mail ${email}.`);
      process.exitCode = 1;
      return;
    }

    const password = await ask("Senha (mín. 8 caracteres): ");
    if (password.length < 8) {
      console.error("Senha precisa ter pelo menos 8 caracteres.");
      process.exitCode = 1;
      return;
    }
    const confirm = await ask("Confirme a senha: ");
    if (password !== confirm) {
      console.error("As senhas não coincidem.");
      process.exitCode = 1;
      return;
    }

    const passwordHash = await hashPassword(password);
    const user = await prisma.user.create({ data: { email, passwordHash } });
    console.log(`Usuário criado: ${user.email} (id: ${user.id})`);
  } finally {
    rl.close();
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
