-- Baseline: registra no histórico do Prisma Migrate a tabela "session" que o
-- connect-pg-simple (express-session store, ver src/admin/routes.ts) cria
-- sozinho em runtime, fora do controle do Prisma. Esta migration não roda
-- de verdade (a tabela já existe) — é aplicada via `prisma migrate resolve
-- --applied`, só pra sincronizar o histórico com a realidade do banco e
-- destravar `prisma migrate dev` sem precisar de reset.
CREATE TABLE IF NOT EXISTS "session" (
  "sid" varchar NOT NULL COLLATE "default",
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL
);

ALTER TABLE "session" ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE;

CREATE INDEX "IDX_session_expire" ON "session" ("expire");
