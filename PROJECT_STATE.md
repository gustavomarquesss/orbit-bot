# Estado do projeto — DG Bot

> Protocolo obrigatório: **leia este arquivo inteiro antes de iniciar qualquer
> tarefa** neste projeto. **Atualize-o ao concluir qualquer tarefa** com:
> decisões tomadas, o que foi implementado, o que ficou pendente, e trade-offs
> relevantes. Este arquivo substitui a necessidade de reconstruir contexto a
> partir do histórico do chat.

Última atualização: 2026-08-19

## Redesign pro modelo Shark Bot (2026-08-19)

Usuário mostrou 13 telas reais do Shark Bot e confirmou que o painel
genérico (Flow/FlowStep/Button/Product) entregue antes ficou muito aquém.
Plano completo salvo em
`C:\Users\gusta\.claude\plans\rippling-rolling-castle.md` — ler antes de
continuar qualquer trabalho no painel/modelo de dados.

**Confirmado com o usuário**: quer paridade real (assinatura E pagamento
único, upsell/downsell/order bump/packs/prévias, múltiplos gateways com
fallback) — mas concordou em fazer por fases. Fase 1 (essencial: bots,
boas-vindas, planos, pagamentos) está em andamento.

**Feito e testado com bot real** (usuário confirmou "testei, funcionou"):
- Schema redesenhado: `Bot`/`BotCommand`/`FlowBot`/`WelcomeConfig`/
  `WelcomeMedia`/`RedirectButton`/`PaymentMessages`/`Plan` (substitui
  `Product`, funde pagamento único e assinatura via `durationDays` opcional).
  `Lead`/`Order` agora têm `botId`.
- Arquitetura multi-bot: `src/bot/botManager.ts` sobe/derruba instâncias
  Telegraf em runtime, sem reiniciar o processo — bots são cadastrados pelo
  painel (`/admin/bots/new`), token validado contra a API real (`getMe`)
  antes de salvar, criptografado no banco (`src/lib/crypto.ts`, AES-256-GCM).
- Tema dark/light com accent vermelho no painel (pedido explícito).
- Boas-vindas com variáveis (`{nome}`, `{saudacao}`, `{bot.username}`, etc —
  `src/bot/templating.ts`) renderizando de verdade no bot real.

**Fase 1 completa** (todas as milestones do plano feitas e testadas no
navegador com persistência real):
- `/admin/flows/:id/bots` — vincula/desvincula bots ao funil (UI, não mais
  script manual).
- `/admin/flows/:id/welcome` — mídia (até 3, via `file_id` colado), editor
  de texto com toolbar (B/I/U/S/code/quote) + chips de variável, CTA,
  botões de redirect (até 3), mini app, canal-cofre padrão do funil.
- `/admin/flows/:id/plans` — CRUD completo (nome, preço, duração em dias —
  vazio = pagamento único, preenchido = assinatura —, cor de botão, entrega
  FILE/LINK, entrega customizada por plano).
- `/admin/flows/:id/payments` — mensagens de PIX gerado/aprovado com preview
  ao vivo estilo bolha de chat do Telegram; `pixGeneratedMessage` já é usado
  de verdade pelo bot (com fallback pro texto padrão se vazio), assim como
  `pixApprovedMessage` (enviado ao comprador quando o webhook confirma o
  pagamento).
- Sidebar da tela de fluxo já mostra o mapa completo das seções futuras
  (Upsell/Downsell/Order Bump/Packs/Prévias/Assinatura/Top Assinantes)
  marcadas "em breve", sem implementação ainda.

**Próxima fase (fora do escopo do plano atual)**: Upsell, Downsell, Order
Bump, Packs, Prévias autodestrutivas, Assinatura/renovação, Top Assinantes,
cor de botão via Business API (funcionalidade real do Telegram, não do
painel — só funciona em contas com Business Premium), abstração de
múltiplos gateways de pagamento com fallback automático.

**Fase 1 validada de ponta a ponta em 2026-08-19**: `/start` → CTA → plano →
PIX real de R$1,00 → pagamento confirmado (status PAID) → sem erro de
entrega/notificação nos logs. Primeiro pagamento real completo do projeto.

**Bug 1 corrigido em 2026-08-19**: `createCharge` (`src/payments/syncpay.ts`)
mandava `amount: amountCents` direto pro campo `amount` da SyncPay,
assumindo que era em centavos. Não é — é em reais. Um plano de R$1,00
(`priceCents: 100`) gerava uma cobrança real de R$100,00 na SyncPay
(confirmado no dashboard deles pelo usuário). Corrigido para
`amount: amountCents / 100`, com teste de regressão em
`src/payments/__tests__/syncpay.test.ts` que verifica o corpo da requisição
enviada.

**Bug 2 corrigido em 2026-08-19 — postback da SyncPay nunca chega**: no
primeiro pagamento real completo, o Order ficou PENDING pra sempre — o
pagamento aprovou no dashboard da SyncPay mas nosso endpoint
`/webhooks/syncpay` nunca foi chamado (confirmado que o endpoint funciona
normalmente via `curl` direto). **Mitigação implementada**: polling de
reconciliação (`src/payments/reconciliation.ts`, `startReconciliationPolling`,
chamado em `server.ts`, intervalo de 20s) — varre Orders PENDING e consulta
`GET /transaction/:id` diretamente, aplicando a mesma lógica de
transição/entrega do webhook (extraída pra `src/payments/orderStatus.ts`,
compartilhada entre webhook e polling, idempotente). Testado e confirmado
funcionando: pegou o pagamento pendente e marcou PAID sozinho, sem depender
do webhook.

**Causa raiz encontrada em 2026-08-19**: o campo que mandávamos pra registrar
o callback (`postbackUrl` no body do `cash-in`) **não existe na API real da
SyncPay** — não há doc oficial acessível, mas uma lib de terceiros no GitHub
(`b7k3/syncpay`) documenta o payload real e mostra o campo correto:
**`webhook_url`**. A SyncPay provavelmente ignorava silenciosamente o campo
desconhecido — por isso nenhum webhook chegava, apesar do nosso endpoint
funcionar perfeitamente. Corrigido em `src/payments/syncpay.ts`
(`buildWebhookUrl`, antes `buildPostbackUrl`), com teste de regressão.
**Confirmado com um novo pagamento real (2026-08-19)**: o webhook chegou na
hora, sem precisar do polling de reconciliação — que continua ativo mesmo
assim, como rede de segurança (custo zero, só roda quando há Order PENDING).

## Protocolo de trabalho (feedback explícito do usuário, 2026-08-19)

**Commitar incrementalmente, a cada etapa concluída — não só no fechamento
da sessão.** Motivo: o usuário quer o histórico do git refletindo o avanço
real do projeto, não um punhado de commits gigantes no final. Cada
funcionalidade/correção fechada = um commit, na hora.

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
- Gateway PIX: **SyncPay**. Usuário já tem conta e credenciais OAuth
  (`client_id`/`client_secret` — **não** é API key estática, ver seção
  "Integração SyncPay — endpoints reais" abaixo).
- Bot Telegram: usuário já tem token criado no @BotFather.
- Config de fluxos/mensagens/botões: guardada no **banco**, editável via
  comandos administrativos no bot **e** pelo painel web (ver decisão revisada
  abaixo) — evita precisar de redeploy a cada edição de texto.
- Entrega de conteúdo: canal privado "cofre" no Telegram + `message_id` (não
  `file_id` — `copyMessage` exige `message_id`) + `protect_content: true`.
  Sem storage externo.
- **Painel admin (revisado em 2026-08-19, a pedido explícito do usuário):**
  não é mais somente leitura. Tem CRUD completo de Flows/FlowSteps/Buttons/
  Products pela tela web, além do dashboard de métricas. Decisão original
  ("v1 somente leitura, edição só via bot") não vale mais.
- Branches: `main` / `homolog` / `dev` / `feature/*`, Conventional Commits.

## Integração SyncPay — endpoints reais (confirmado em 2026-08-19)

A doc usada durante a implementação original (`syncpay.apidog.io`, um espelho
de terceiro) estava **errada** — apontava pro domínio `syncpay.pro`, que nem
existe (NXDOMAIN confirmado). Testado com credenciais reais do usuário
contra a API de produção:

- **Base URL real**: `https://api.syncpayments.com.br` (não `api.syncpay.pro`).
- **Auth**: `POST /api/partner/v1/auth-token`, body `{client_id, client_secret}`
  → `{access_token, token_type, expires_in, expires_at}`. Token dura 1h,
  cacheado em memória do processo (`src/payments/syncpay.ts`).
- **Criar cobrança**: `POST /api/partner/v1/cash-in`, body mínimo
  `{amount (REAIS, ex: 1.00 para R$1,00 — não centavos, ver bug corrigido
  em 2026-08-19 na seção "Fase 1"), description, postbackUrl}`. **Nenhum dado do
  comprador é exigido** (nome/email/CPF) — confirmado testando sem esses
  campos e recebendo sucesso. Uma tentativa anterior de exigir CPF (baseada
  na doc errada) foi implementada e **revertida** no mesmo dia (schema,
  `bot/flows.ts`, `bot/util.ts` — sem rastro no histórico do git, tudo squash
  antes do commit).
- **Resposta da criação**: `{message, pix_code, identifier}` — **sem** imagem
  de QR code pronta. `pix_code` é o texto copia-e-cola (EMV/BR Code);
  `identifier` é o id da transação (mapeado pra `Order.syncpayChargeId`). O
  QR code agora é **gerado por nós** a partir do `pix_code` (lib `qrcode`).
- **Consulta de status**: `GET /api/partner/v1/transaction/{identifier}` →
  `{data: {reference_id, currency, amount, status, description, pix_code}}`.
  Status observado: `"pending"` (minúsculo). Endpoint não usado no código
  ainda (webhook cobre o caso principal), mas é o caminho pra reconciliação
  manual/futuro polling de fallback caso o webhook falhe.
- **Limite de conta**: a conta de testes do usuário recebeu erro
  `"Cashin exceeds max_cashin_without_fee"` mesmo em valores baixos (R$1,00
  funcionou uma vez, depois passou a falhar — parece ser um teto cumulativo,
  não por transação). **Não é bug de código** — é configuração/verificação
  pendente na conta SyncPay do usuário. Ele precisa checar o painel da
  SyncPay ou falar com o suporte deles antes de operar em produção.
- Mecanismo de assinatura do webhook **ainda não confirmado** (nenhuma doc
  acessível documentou isso) — continua usando shared-secret na query string
  da `postbackUrl` como fallback. Nenhum pagamento real foi completado no
  teste (por causa do limite acima), então o payload real de um webhook de
  confirmação também **ainda não foi visto**.

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
      sessão via `connect-pg-simple`, não MemoryStore), dashboard com receita/
      contagens por status/leads/conversão/tabela de vendas recentes/gráfico
      Chart.js. **CRUD completo** de Flows/FlowSteps/Buttons (`flowsRoutes.ts`)
      e Products (`productsRoutes.ts`) — criar, editar, excluir tudo pela
      tela, com autocomplete pra apontar botões de compra/navegação. Views
      EJS com partials de header/footer compartilhados
      (`views/partials/`, `views/flows/`, `views/products/`). Único ponto que
      o painel não resolve: colar `file_id` de mídia manualmente (sem upload
      direto) — anotado como possível extensão futura.
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

## Ambiente de homologação local (técnica reutilizável)

Antes de contratar VPS/domínio, validamos boa parte do sistema de graça,
localmente, assim (repita quando precisar testar de novo sem gastar dinheiro):

1. Postgres real via Docker: `docker run -d --name dgbot-homolog-db -e
   POSTGRES_USER=dgbot -e POSTGRES_PASSWORD=... -e POSTGRES_DB=dgbot -p
   55432:5432 postgres:16-alpine`.
2. Túnel público HTTPS grátis, sem conta, via Cloudflare:
   `docker run -d --name dgbot-tunnel cloudflare/cloudflared:latest tunnel
   --url http://host.docker.internal:3000` (usar `host.docker.internal`, não
   `localhost` — no Docker Desktop Windows/Mac, `--network host` não dá
   acesso ao host real). A URL pública aparece no log do container
   (`docker logs dgbot-tunnel | grep trycloudflare`).
3. `.env` local com credenciais reais do usuário (Telegram + SyncPay) e
   `DATABASE_URL`/`PUBLIC_BASE_URL` apontando pro Postgres/túnel acima.
4. `npx prisma migrate dev` + `npx tsx prisma/seed.ts` + `npx tsx src/server.ts`.

Isso validou, com dado real (não mock): webhook do Telegram registra e
responde, `/start` funciona, painel admin CRUD persiste no banco, e a API da
SyncPay foi inspecionada diretamente (achou o domínio/endpoints certos — ver
seção acima). **Lembrete de segurança**: o `.env` usado aqui tem credenciais
reais — nunca commitar (já coberto pelo `.gitignore`), e o usuário colou
essas credenciais no chat uma vez — sugerido rotacionar por higiene quando
o projeto estabilizar.

## Pendente (ver task list da sessão para detalhes)

- [x] ~~Resolver o limite `max_cashin_without_fee`~~ — não bloqueou o
      pagamento de R$1,00 testado em 2026-08-19 (ficar de olho se voltar a
      aparecer em valores maiores).
- [x] ~~Confirmar o payload real de um webhook de pagamento confirmado~~ —
      **não confirmado porque o webhook da SyncPay nunca chegou** (ver bug 2,
      seção "Fase 1" acima). Coberto por polling de reconciliação em vez
      disso. `normalizeChargeStatus` continua sendo aproximação tolerante.
- [x] ~~Descobrir como registrar o webhook de verdade na SyncPay~~ —
      encontrado: campo correto é `webhook_url`, não `postbackUrl` (ver seção
      "Fase 1" acima). Corrigido. **Falta confirmar com um novo pagamento
      real** que o webhook chega de verdade agora (o polling de 20s cobre
      enquanto isso não for validado).
- [ ] Contratar a VPS (usuário pediu recomendação, referência Hetzner CX22
      ~€5-8/mês) e registrar um domínio/subdomínio (usuário ainda não tem um
      — obrigatório pro Caddy emitir TLS). Sem isso, não dá pra fazer o
      deploy real, mas dá pra continuar testando localmente (ver seção acima).
- [ ] Deploy via Docker Compose na VPS real + configurar domínio/TLS + backup
      agendado do Postgres (`pg_dump` + destino externo).
- [ ] Upload de mídia direto pelo painel web (hoje precisa colar `file_id`
      manualmente) — extensão possível se virar fricção no uso real.
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
  mexer em mensagens/fluxos deve editar via seed/painel/comando admin, não
  hardcoded em `src/`.
- **Nunca confiar em doc espelhada de terceiro sem validar contra a API real**
  assim que houver credenciais disponíveis — a doc usada pra SyncPay estava
  errada em endpoint, domínio, payload e resposta. Testar com uma chamada
  real é mais barato do que parecia.
