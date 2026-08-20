import { prisma } from "../src/db/client.js";

/** `npm run user:list` — lista os usuários do painel, sem expor o hash. */
async function main(): Promise<void> {
  const users = await prisma.user.findMany({ orderBy: { createdAt: "asc" } });
  if (users.length === 0) {
    console.log("Nenhum usuário cadastrado ainda. Rode: npm run user:create");
    return;
  }
  for (const u of users) {
    console.log(`${u.id}  ${u.email}  (criado em ${u.createdAt.toLocaleString("pt-BR")})`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
