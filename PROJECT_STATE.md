# Estado do projeto — DG Bot

> Protocolo obrigatório: **leia este arquivo inteiro antes de iniciar qualquer
> tarefa** neste projeto. **Atualize-o ao concluir qualquer tarefa** com:
> decisões tomadas, o que foi implementado, o que ficou pendente, e trade-offs
> relevantes. Este arquivo substitui a necessidade de reconstruir contexto a
> partir do histórico do chat.

Última atualização: 2026-08-18

## Decisões tomadas (validadas com o usuário)

- Stack: Node.js 20 + TypeScript + Express + Telegraf + Prisma. Ver `ARCHITECTURE.md`.
- Hospedagem: **Render free tier**, aceitando cold-start de ~1min após 15min de
  inatividade, mitigado com ping externo (cron-job.org/UptimeRobot). Usuário
  confirmou explicitamente que aceita esse trade-off (alternativa seria pagar
  ~$5-7/mês por estabilidade, ou usar VPS própria — não é o caso hoje).
- Banco: **Neon Postgres free tier** (não SQLite — Render free não tem disco
  persistente).
- Gateway PIX: **SyncPay**. Usuário já tem conta e API key.
- Bot Telegram: usuário já tem token criado no @BotFather.
- Config de fluxos/mensagens/botões: guardada no **banco**, editável via
  comandos administrativos no próprio bot (não arquivo JSON estático) — evita
  precisar de redeploy a cada edição de texto.
- Entrega de conteúdo: canal privado "cofre" no Telegram + `file_id` +
  `copyMessage` com `protect_content: true`. Sem storage externo.
- Painel admin: Express + EJS server-rendered, login único via senha em env
  var. v1 é somente leitura (métricas/vendas); edição de conteúdo fica só nos
  comandos do bot por enquanto.
- Branches: `main` / `homolog` / `dev` / `feature/*`, Conventional Commits.

## O que já foi implementado

- [x] `ARCHITECTURE.md` com stack, estrutura de pastas e justificativa de custo.
- [x] `package.json` + `tsconfig.json` (Node 20, ESM, TypeScript strict).
- [x] `.env.example` com todas as variáveis necessárias.
- [x] `.gitignore` atualizado (node_modules, dist, .env*, prisma db local).
- [x] `prisma/schema.prisma` completo: `Origin`, `Lead`, `Flow`, `FlowStep`,
      `Button`, `FlowExecution`, `Product`, `Order`, `WebhookEvent`.
- [x] `npm install` rodado. `npm audit`: restam vulnerabilidades **apenas em
      devDependencies** (vitest/vite/esbuild — servidor de dev do Vite, nunca
      exposto em produção; e deepmerge-ts via prisma CLI). Aceito por ora —
      não afeta o código que roda em produção. Reavaliar se o audit apontar
      algo em dependência de runtime (express, telegraf, prisma client).
- [x] `README.md` com setup local e fluxo de branches.
- [x] `PROJECT_STATE.md` (este arquivo).

## Pendente (ver task list da sessão para detalhes)

- [ ] Branches `dev` e `homolog` (criadas a partir do primeiro commit em `main`).
- [ ] `src/` — bootstrap do Express (`server.ts`), Prisma client singleton,
      config/env loader.
- [ ] Integração Telegram (Telegraf): webhook, engine de fluxos lendo do
      banco, comandos admin, deep link tracking, entrega via canal-cofre.
- [ ] Integração SyncPay: client HTTP, geração de cobrança, webhook +
      idempotência (usar `WebhookEvent` já modelado).
- [ ] Painel admin web.
- [ ] **Bloqueador para testar de ponta a ponta**: preciso do usuário para:
      1. Criar um projeto Neon e me passar a `DATABASE_URL` (via `.env`, nunca no chat).
      2. Confirmar `TELEGRAM_BOT_TOKEN` e `TELEGRAM_ADMIN_USER_ID` no `.env`.
      3. Confirmar `SYNCPAY_API_KEY` e detalhes de autenticação/assinatura do
         webhook (a API da SyncPay tem doc em https://web.syncpay.pro/documentacao/
         — confirmar formato exato de assinatura do webhook antes de implementar
         a validação).
      4. Criar (ou apontar) o canal privado "cofre" e me adicionar o bot como admin.
- [ ] Deploy no Render + configuração de keep-alive externo.
- [ ] QA E2E com agent-browser no painel admin (desktop + mobile).
- [ ] Expandir guia de comandos admin no README conforme forem implementados.

## Trade-offs relevantes para lembrar

- Render free pode atrasar confirmação de pagamento em até ~1min em cold-start.
  Não é um bug, é uma decisão de custo consciente — não "consertar" isso sem
  avisar o usuário primeiro (a correção envolve custo: upgrade de plano ou VPS).
- Config de conteúdo fica no banco, não em arquivo — qualquer agente que for
  mexer em mensagens/fluxos deve editar via seed/comando admin, não hardcoded
  em `src/`.
- Painel admin v1 é somente leitura. Se o usuário pedir edição de conteúdo por
  lá também, é uma extensão da task 8, não do escopo do bot.
