# Estado do projeto — DG Bot

> Protocolo obrigatório: **leia este arquivo inteiro antes de iniciar qualquer
> tarefa** neste projeto. **Atualize-o ao concluir qualquer tarefa** com:
> decisões tomadas, o que foi implementado, o que ficou pendente, e trade-offs
> relevantes. Este arquivo substitui a necessidade de reconstruir contexto a
> partir do histórico do chat.

Última atualização: 2026-08-18

## Decisões tomadas (validadas com o usuário)

- Stack: Node.js 20 + TypeScript + Express + Telegraf + Prisma. Ver `ARCHITECTURE.md`.
- **Hospedagem (revisado em 2026-08-18, mesmo dia da decisão original):** VPS
  própria (referência: Hetzner ~€5-8/mês) + Docker Compose (app + Postgres +
  Caddy como reverse proxy/TLS). Motivo da revisão: usuário precisa de
  confirmação de pagamento/notificações em tempo quase real — o cold-start do
  Render free (~1min após 15min de inatividade) era incompatível com isso.
  VPS always-on também evita migração futura, já que o usuário pretende
  escalar nesse formato. Trade-off assumido: usuário passa a cuidar de
  patches de SO, backup do volume Postgres e domínio/TLS (Caddy renova
  certificado sozinho, desde que o domínio continue apontando certo).
  Decisão original (Render+Neon free) fica só como histórico no
  `ARCHITECTURE.md`, não vale mais.
- Banco: **Postgres em container Docker**, no mesmo `docker-compose.yml` da
  app (não mais Neon/Supabase — não se aplica mais desde a revisão de hosting acima).
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
- [x] `.gitignore` atualizado (node_modules, dist, .env*, prisma db local, worktrees de agente).
- [x] `prisma/schema.prisma` completo: `Origin`, `Lead`, `Flow`, `FlowStep`,
      `Button`, `FlowExecution`, `Product`, `Order`, `WebhookEvent`. Migration
      inicial gerada e commitada (`prisma/migrations/20260818050659_init`).
- [x] `prisma/seed.ts` — popula dados de exemplo em dev local (`npx tsx prisma/seed.ts`).
- [x] Branches `dev` e `homolog` criadas a partir do primeiro commit em `main`.
- [x] `src/server.ts`, `src/config.ts` (validação zod), `src/db/client.ts` (Prisma singleton).
- [x] `Dockerfile` + `docker-compose.yml` + `Caddyfile` (app + postgres + reverse proxy TLS).
- [x] **Integração Telegram (Telegraf)** — `src/bot/*`:
      webhook autenticado (path secreto + `secret_token`), engine de fluxos
      (`flows.ts`: renderização de texto/mídia, `GOTO_FLOW`, `BUY_PRODUCT`,
      `OPEN_LINK`/`REDIRECT_CHANNEL` como botão nativo), deep link tracking
      (`deepLink.ts`, cria Origin desconhecida automaticamente em vez de
      descartar), 7 comandos administrativos com CRUD real no banco
      (`/fluxos`, `/novofluxo`, `/produtos`, `/novoproduto`, `/novamensagem`,
      `/novobotao`, `/vendas` — ver tabela completa no README), entrega via
      canal-cofre (`delivery.ts`: `copyMessage` + `protect_content`, usa
      `message_id` da mensagem no canal, não `file_id`).
- [x] **Integração SyncPay (PIX)** — `src/payments/*`: cliente HTTP
      (`syncpay.ts`), `createOrderAndCharge` (`orders.ts`), webhook com
      validação de shared-secret + idempotência real via `WebhookEvent`
      (`webhook.ts`) — só entrega/notifica na transição `PENDING→PAID`.
- [x] **Painel admin web** — `src/admin/*`: login por senha (`timingSafeEqual`,
      sessão via `express-session`), dashboard com receita/contagens por
      status/leads/conversão/tabela de vendas recentes/gráfico Chart.js.
- [x] 62 testes automatizados (`vitest`) cobrindo lógica pura de bot e
      pagamentos (deep link, formatação, callback_data, cliente SyncPay,
      idempotência do webhook) — todos mockados (Prisma/fetch/Telegram).
- [x] `README.md` com setup local, fluxo de branches, tabela completa de
      comandos admin, instruções de deploy via Docker Compose.
- [x] `PROJECT_STATE.md` (este arquivo).

## Testado de verdade (2026-08-18, Postgres real via Docker local)

Não é mais só "compila e passa nos testes mockados" — validado contra um
Postgres real rodando em container e um servidor Express real:
- Migration + seed aplicados com sucesso.
- Login/logout do painel admin, rejeição de senha errada, dashboard
  renderizando métricas corretas calculadas a partir de dados reais no banco
  (receita, contagem por status, taxa de conversão, tabela de vendas).
- Sem overflow horizontal em viewport mobile (375px).
- Webhook da SyncPay: transição real `PENDING→PAID` no banco, idempotência
  (webhook duplicado retorna `{duplicate:true}` sem reprocessar — confirmado
  que não tenta entregar/notificar de novo), rejeição de secret inválido (401).
- **Bug real encontrado e corrigido**: o gráfico do dashboard (Chart.js)
  dependia da animação padrão (`requestAnimationFrame`), que não dispara se a
  aba carregar sem foco — ficava em branco. Corrigido com `animation: false`.
- Falhas esperadas com credenciais fake (token Telegram/API key SyncPay
  inválidos) foram tratadas graciosamente em todos os pontos — não derrubam
  o servidor nem quebram o fluxo principal (confirmado nos logs).
- **Build real da imagem Docker validado** (`docker build` + container
  rodando conectado a um Postgres real, `prisma migrate deploy` dentro do
  container, login funcionando com sessão persistida na tabela `session`).
  Dois problemas reais encontrados e corrigidos nesse teste:
  1. `node:20-slim` não vem com OpenSSL — Prisma avisava que estava
     "adivinhando" a versão pra usar. Corrigido instalando `openssl`
     explicitamente no `Dockerfile` (build e runtime).
  2. `express-session` usava `MemoryStore` (padrão) — vaza memória e perde
     todas as sessões a cada restart, inaceitável numa VPS always-on de longa
     duração. Trocado por `connect-pg-simple`, usando o mesmo Postgres da app.
  O flag `Secure` do cookie de sessão só "falha" em teste via HTTP direto
  sem TLS (esperado — o Caddy termina HTTPS antes de proxyar pro app; em
  produção o browser sempre fala HTTPS com o Caddy).

## Pendente (ver task list da sessão para detalhes)

- [ ] **Bloqueador para produção real** — preciso do usuário para:
      1. Confirmar `TELEGRAM_BOT_TOKEN` e `TELEGRAM_ADMIN_USER_ID` reais no `.env` da VPS.
      2. Confirmar `SYNCPAY_API_KEY` real e resolver os pontos em aberto
         levantados pela integração de pagamentos (ver checklist abaixo).
      3. Criar (ou apontar) o canal privado "cofre" e adicionar o bot como admin.
      4. Contratar a VPS (ainda não escolhida — usuário pediu recomendação,
         referência Hetzner CX22 ~€5-8/mês) e registrar um domínio/subdomínio
         (usuário ainda não tem um — **obrigatório** pro Caddy emitir TLS).
- [ ] **Checklist crítico da integração SyncPay antes de produção** (dinheiro real):
      1. Confirmar se `SYNCPAY_API_KEY` funciona como Bearer estático ou se é
         necessário o fluxo OAuth `client_id`/`client_secret` → `access_token`
         (a doc espelhada consultada, syncpay.apidog.io, sugere OAuth; a doc
         oficial web.syncpay.pro/documentacao/ estava inacessível na pesquisa —
         DNS falhou neste ambiente).
      2. Confirmar o endpoint e payload reais de criação de cobrança (usado
         `/v1/gateway/api`, campos `amount`/`items`/`pix.expiresInDays`/
         `customer` — especialmente se `customer.cpf` é obrigatório, já que
         Telegram não fornece CPF do lead).
      3. **Confirmar o mecanismo real de assinatura do webhook.** Hoje é um
         shared-secret (`SYNCPAY_WEBHOOK_SECRET`) na query string da
         `postbackUrl` — funcional e testado, mas é um fallback: nenhuma doc
         acessível documentou HMAC/assinatura oficial. Trocar por HMAC se a
         SyncPay oferecer, é mais seguro.
      4. Disparar uma cobrança de teste real pra conferir nomes de campo
         exatos da resposta/webhook (o parsing hoje aceita várias variantes
         de nome de campo por segurança, mas não foi validado contra a API real).
      5. Confirmar se enviar o QR code como `data:image/png;base64,...`
         (convertido pra Buffer em `src/bot/flows.ts`) funciona bem no cliente
         Telegram — testado só localmente com uma imagem PNG genérica, não
         com um QR real da SyncPay.
- [ ] Deploy via Docker Compose na VPS real + configurar domínio/TLS + backup
      agendado do Postgres (`pg_dump` + destino externo).
- [ ] Teste manual de conversa real com o bot no Telegram (não dá pra
      automatizar sem token real) — fluxo `/start` → deep link → navegação →
      compra → recebimento do PIX.
- [ ] Revisar `npm audit`: vulnerabilidades restantes são só em
      devDependencies (vitest/vite/esbuild, deepmerge-ts via prisma CLI) —
      não afetam produção, mas reavaliar se o audit apontar algo em
      dependência de runtime.

## Trade-offs relevantes para lembrar

- VPS própria significa que **não há mais mitigação de plataforma** para
  segurança de SO, backup e certificado — é tudo nosso. Não assumir que "está
  na nuvem, está seguro"; a task de deploy precisa cobrir isso de verdade
  (backup agendado do Postgres é bloqueador antes de considerar produção).
- Config de conteúdo fica no banco, não em arquivo — qualquer agente que for
  mexer em mensagens/fluxos deve editar via seed/comando admin, não hardcoded
  em `src/`.
- Painel admin v1 é somente leitura. Se o usuário pedir edição de conteúdo por
  lá também, é uma extensão da task 8, não do escopo do bot.
