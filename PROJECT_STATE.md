# Estado do projeto — DG Bot

> Protocolo obrigatório: **leia este arquivo inteiro antes de iniciar qualquer
> tarefa** neste projeto. **Atualize-o ao concluir qualquer tarefa** com:
> decisões tomadas, o que foi implementado, o que ficou pendente, e trade-offs
> relevantes. Este arquivo substitui a necessidade de reconstruir contexto a
> partir do histórico do chat.

Última atualização: 2026-08-19

## Fase 2 — paridade completa (upsell/downsell/order bump, assinatura, multi-gateway, mailing, dashboard, canal de vendas) — em andamento

Plano completo salvo em
`C:\Users\gusta\.claude\plans\rippling-rolling-castle.md` (Fase 2 no topo do
arquivo, Fase 1 arquivada abaixo). Usuário pediu paridade total com
ApexVips/Shark Bot **antes do deploy em VPS** — deploy real fica bloqueado
até esta fase fechar. Confirmado com o usuário: modelo de assinatura é
acesso por N dias + renovação manual + revogação automática (PIX não tem
cobrança recorrente real); canal de vendas é um único canal global (não por
bot); segundo gateway é WiinPay (usuário já tem credenciais); mailing é
escopo básico (sem agendamento).

**Milestone 1 concluído (2026-08-19) — `Order` → `Order` + `OrderItem`**:
pré-requisito pra Order Bump (cobrar base + adicionais numa única cobrança
PIX). `Order` perdeu `planId` direto; ganhou `items OrderItem[]` (`kind`
BASE/ORDER_BUMP/UPSELL/DOWNSELL, `unitPriceCents`, e os campos de
assinatura `accessExpiresAt`/`renewalReminderSentAt`/`revokedAt` usados no
Milestone 5). Migration `20260819122500_order_items` migrou os 4 Orders
reais já existentes (incluindo os pagos de verdade) sem perda de dado —
editada manualmente em cima do diff do `prisma migrate diff` pra inserir o
passo de cópia antes de dropar a coluna antiga. Verificado com uma compra
real de ponta a ponta depois da migração.

Efeito colateral útil: pra gerar essa migration sem rodar `prisma migrate
reset` (que apagaria o banco), descobri que o Prisma via "drift" por causa
da tabela `session` do `connect-pg-simple`, que não estava declarada no
schema. Resolvido com uma migration de baseline
(`20260819121733_baseline_session_table`, aplicada via `migrate resolve
--applied`, sem re-executar o SQL) + um `model Session` mapeado (`@@map`)
declarado só pra o Prisma Migrate parar de achar que a tabela é "órfã" —
o Prisma Client não gerencia essa tabela, quem cuida é a lib mesmo.

**Bug real encontrado durante a verificação do Milestone 1 (2026-08-19)**:
o payload de webhook de pagamento confirmado da SyncPay vem aninhado em
`{data: {idtransaction, status, ...}}`, não no formato plano que a gente
tinha assumido (nunca confirmado contra um pagamento real até agora — o
pagamento anterior desta sessão só tinha sido pego pelo polling). O webhook
estava sendo descartado silenciosamente ("id de transação não encontrado")
e todo pagamento só confirmava via o polling de reconciliação (até 20s de
atraso) em vez do webhook instantâneo. Corrigido em `src/payments/webhook.ts`
(`unwrapFields`), com teste de regressão usando o payload real observado
no log do servidor.

**Milestone 2 concluído (2026-08-19) — canal de vendas rico**: `Settings`
(singleton) guarda `salesChannelId`, configurável em `/admin/settings` sem
redeploy (cai no DM antigo se não configurado). `notifyAdminOfSale`
reescrita pro formato exato pedido pelo usuário, uma mensagem por
`OrderItem`. `Lead` ganhou `languageCode`/`isPremium` (capturados de
`ctx.from` no `/start` e em toda interação). Verificado com compra real —
mensagem chegou certinha no canal configurado pelo usuário.

**Bug real encontrado e corrigido durante a verificação (2026-08-19)**:
"Tempo Conversão" usava `lead.createdAt` (primeiro contato histórico do
lead — pode ser de horas atrás pra cliente recorrente) em vez de
`order.createdAt` (quando aquele PIX específico foi gerado). Uma compra de
menos de 1 minuto aparecia como "0d 2h 0m 7s". Corrigido pra usar sempre
`order.createdAt → order.paidAt`, com teste de regressão simulando um lead
antigo + order recente.

**Milestone 4 concluído (2026-08-19) — Order Bump**: modelo `Offer`
(`triggerPlanId`/`offeredPlanId`/`kind`/`message`/`acceptLabel`/
`declineLabel`). Painel em `/admin/flows/:id/offers`. Verificado com
compra real. **Correção pedida pelo usuário depois do primeiro teste**: a
UI original era uma lista de checkboxes + botão "Confirmar compra" — o
usuário queria (e agora é) aceitar/recusar sequencial: cada bump aparece
um de cada vez com dois botões de texto editável, clicar em qualquer um
já avança pro próximo bump (ou gera o PIX se acabou), sem botão de
confirmação separado. Bitmask + índice posicional no `callback_data`
(limite de 64 bytes do Telegram não permite carregar ids de bump direto).

**Milestone 4 (Upsell) reconstruído do zero (2026-08-19)**: a primeira
versão (Offer-based, um plano-gatilho específico, botão fixo Sim/Não) foi
**totalmente substituída** depois que o usuário mandou um print real de
referência mostrando uma estrutura bem mais rica. Modelo novo:
`UpsellSequence` (1 por Flow, ativa/pausada) → N `UpsellMessage` em
sequência (texto, `delayMinutes` — atraso configurável após a compra,
default 0 = imediato) → cada mensagem tem `UpsellMessagePlan[]` (planos
anexados, só pra alimentar os botões) e `UpsellMessageButton[]` (texto
livre, tipo `BUY_PLAN` — reaproveita o callback `plan:<id>` já existente,
compra normal, engatilha Order Bump se o plano tiver — ou `OPEN_LINK`, só
abre um link). Dispara depois de **qualquer** compra do funil (não mais
um plano-gatilho específico). Novo scheduler
(`src/bot/upsellScheduler.ts`, `setInterval` 30s, mesmo padrão do
`reconciliation.ts`) processa `ScheduledUpsellSend` — criados no momento
da compra, um por mensagem da sequência, com `sendAt` calculado a partir
do `delayMinutes` — sobrevive a restart do processo entre a compra e o
envio. Verificado via browser (criar mensagem, anexar plano, criar botão
BUY_PLAN — tudo persistindo certo); teste real de envio no bot pendente
com o usuário.

**Downsell desacoplado e adiado**: o mecanismo antigo (`Offer.kind=
DOWNSELL`, disparava quando um Upsell-antigo era recusado) ficou sem uso
depois do rebuild do Upsell — o Upsell novo não tem mais um botão fixo de
"recusar". Usuário confirmou que o Downsell real vai ser outra coisa:
dispara quando um PIX é **gerado mas não pago** depois de N minutos
configuráveis (ex: 5min, 15min) — não mais ligado a recusar um Upsell.
Ainda não implementado; usuário vai mandar um print de referência quando
chegarmos nessa tela.

**Milestone 4 (Order Bump + Upsell) verificado de ponta a ponta pelo
usuário (2026-08-19)**: compra com bump marcado funcionou; mensagem de
Upsell agendada (1min de atraso) chegou certinha, botão BUY_PLAN gerou PIX
novo separado. Milestone 4 considerado fechado (Downsell explicitamente
adiado, ver acima).

**Milestone 3 (WiinPay) — bloqueado de novo, agora por Cloudflare
(2026-08-19)**: usuário forneceu um token JWT (confirmado que veio da tela
"API/Integração" do painel deles, não de sessão de login). Não existe doc
oficial pública da API WiinPay — só uma referência de terceiro (Scribd)
sugerindo auth via `api_key` no corpo, valor mínimo R$3, campo
`webhook_url`. Tentativa de descobrir o domínio/contrato real por chamadas
diretas (curl, `api-v2.wiinpay.com.br`, achado via busca) esbarrou num
**Cloudflare "Attention Required"** bloqueando qualquer requisição
programática, em qualquer caminho testado (raiz, `/api/v1/me`,
`/api/v1/gateway/cash-in`, etc — todos 403 com o mesmo desafio JS do
Cloudflare, não um 404 de rota errada). Não dá pra descobrir o contrato às
cegas daqui. **Pré-requisito pra retomar**: usuário abrir o painel da
WiinPay, DevTools → Network, gerar um PIX de teste pela tela deles mesmo, e
trazer a requisição real capturada (URL, headers, body) — mesma técnica que
resolveu o mesmo tipo de bloqueio com a SyncPay no início do projeto.

**Milestone 4 — Downsell implementado (2026-08-19)**: usuário mandou prints
de referência com duas abas — "Geral" (dispara N minutos após o `/start`
pra leads que nunca geraram pagamento) e "PIX Gerado" (dispara N minutos
depois de um PIX gerado e não pago; quando tem sequência ativa, cancela de
vez os envios "Geral" pendentes do lead — confirmado com o usuário:
cancelamento definitivo, não pausa). Um único toggle `DownsellConfig.active`
liga/desliga as duas abas (bate com o print, que mostra o mesmo estado nas
duas). Cada `DownsellSequence` tem `delayMinutes`, desconto (`PERCENT` 0-100
ou `FIXED` em centavos), mensagem (HTML+variáveis), até 3 mídias, e Planos
anexados (reaproveita `Plan` existente — preço final calculado na hora,
`applyDiscount` em `src/bot/downsellMessage.ts`). Compra usa
`OrderItemKind.DOWNSELL` e não passa pela fila de Order Bump (a intenção é
recuperar a venda mais barata, não empurrar mais itens). Poller
`src/bot/downsellScheduler.ts` (mesmo padrão setInterval de
`upsellScheduler.ts`/`reconciliation.ts`, 30s) reavalia a condição na hora
de enviar (cancela sem mandar se o Order/lead já converteu nesse meio
tempo). Painel em `/admin/flows/:id/downsell` (duas abas, `?tab=geral|pix`),
com duplicar/pausar/excluir sequência. Escopo deliberadamente cortado do
print de referência, confirmado com o usuário: **"Criar planos" (planos
ad-hoc só pra uma oferta) ficou de fora** — só planos já cadastrados no
funil, com desconto aplicado em cima; o campo "Entrega do Downsell" do print
também ficou de fora por depender do mesmo recurso adiado (Planos ad-hoc não
têm `deliveryType` próprio pra precisar de override — Planos normais já
carregam sua própria config de entrega). Verificado no painel via browser
(criar sequência, salvar desconto, anexar plano, conferir preço com desconto
calculado certo, trocar de aba preservando estado). Suíte de testes cobre
`applyDiscount`/parse do callback (`downsellMessage.test.ts`) e o scheduler
completo (`downsellScheduler.test.ts`) — incluindo os guards de
cancelamento em cima da hora. **Verificado de ponta a ponta pelo usuário (2026-08-19), trigger PIX_GERADO**:
gerou um PIX real e não pagou — 1 minuto depois a mensagem de downsell
chegou certinha, com o botão de compra já no preço com desconto (Plano
Mensal VIP, R$2,00 → R$1,70). Achado no processo: a primeira tentativa de
teste do usuário não disparou nada — não era bug, eu só tinha criado a
sequência de teste na aba "Geral" (não dispara pra lead já existente) e
nunca tinha criado uma na aba "PIX Gerado". Corrigido criando a sequência
certa; confirmado funcionando na tentativa seguinte. **Trigger GERAL ainda
não verificado com o bot real** (só dispara no primeiro `/start` de um lead
novo — precisaria de uma conta nova do Telegram ou simulação via banco pra
testar sem esperar um lead orgânico novo).

**Milestone 5 (assinatura/renovação) implementado (2026-08-19)**: decisão
estrutural confirmada com o usuário antes de construir — planos de
assinatura (`durationDays` preenchido) dão acesso a um **canal/grupo VIP
privado** do Telegram, não só um arquivo/link direto no DM (que era o único
modelo que existia até aqui, e não dá pra "revogar" de verdade). Mudanças:
- `DeliveryType` ganhou o valor `CHANNEL`; `Plan.subscriptionChannelId`
  guarda o canal/grupo. Entrega (`deliverPlanToLead`) gera um convite de
  uso único (`createChatInviteLink`, `member_limit: 1`, expira em 1h) e
  manda pro comprador — precisa do bot ser admin desse canal com permissão
  de convidar/remover membros.
- `orderStatus.ts` agora seta `OrderItem.accessExpiresAt = paidAt +
  durationDays` na transição PAID (não fazia nada antes — o campo existia
  no schema desde o Milestone 1 mas nunca era escrito).
- `src/payments/subscriptionScheduler.ts` (novo, poller a cada 1h, mesmo
  padrão de setInterval dos outros schedulers): `sendRenewalReminders`
  manda lembrete 2 dias antes de vencer (template configurável em
  Pagamentos → "Lembrete de renovação", com botão que reaproveita o
  callback `plan:<id>` já existente — gera um PIX novo pro mesmo plano,
  compra normal, engatilha Order Bump se tiver); `revokeExpiredAccess` kicka
  (ban+unban imediato, sem banimento permanente) do canal VIP todo item
  vencido de plano `CHANNEL`, ou só marca `revokedAt` internamente pra
  planos FILE/LINK vencidos (não tem o que revogar de verdade — o arquivo/
  link já foi entregue).
- Painel: `/admin/flows/:id/plans` ganhou a opção "Canal/grupo VIP
  (assinatura)" no tipo de entrega + campo do ID do canal; `/admin/flows/
  :id/payments` ganhou o campo de mensagem de renovação.
- Testes novos: `subscriptionScheduler.test.ts` (lembrete + revogação,
  incluindo o guard "só mexe no Telegram se for CHANNEL") e
  `orderStatus.test.ts` (novo arquivo — não existia teste dedicado pra
  `applyNormalizedStatus` antes; cobre o cálculo de `accessExpiresAt`).
  Verificado no painel via browser (toggle de campos por tipo de entrega,
  round-trip de salvar/recarregar a mensagem de renovação).

**Verificado de ponta a ponta pelo usuário (2026-08-19)**: canal de teste
criado, bot promovido a admin (`can_invite_users`/`can_restrict_members`
confirmados via `getChatMember` antes do teste), plano "Plano Mensal VIP"
reconfigurado pra `CHANNEL` apontando pro canal — compra real confirmou
`accessExpiresAt` calculado certinho (`paidAt + 30 dias`, exato) e o convite
de uso único chegou no DM, usuário entrou no canal com sucesso. Revogação
testada simulando vencimento (backdate manual de `accessExpiresAt`,
`revokeExpiredAccess()` disparado manualmente): a chamada real
`banChatMember` retornou **`400: Bad Request: can't remove chat owner`** —
achado esperado, não é bug: quem comprou/testou é dono do canal de teste, e
a Bot API nunca deixa banir o dono via API. Em produção o dono é sempre o
operador (nunca um cliente), então isso nunca ocorre numa venda real.
Confirmado que o tratamento de erro funcionou como projetado: logou o erro
e marcou `revokedAt` mesmo assim (não fica tentando pra sempre). Teste com
uma segunda conta não-dona (pra ver o kick de verdade acontecer) foi
avaliado e considerado dispensável pelo usuário — `banChatMember`/
`unbanChatMember` são chamadas padrão da Bot API, não lógica própria do
projeto que precise de validação extra.

**Milestone 6 (mailing básico) implementado e verificado (2026-08-19)**:
novo modelo `Broadcast` (`botId`, `segment` ALL/BUYERS/NON_BUYERS,
`message`, `status` SENDING/DONE/FAILED, `totalRecipients`/`sentCount`/
`failedCount`). `src/bot/broadcast.ts` (`sendBroadcast`) roda em background
(disparado sem `await` pela rota — não segura a resposta HTTP), resolve o
segmento via query direta (`BUYERS`= tem `Order` PAID, `NON_BUYERS` = não
tem), manda em lotes de 25 com pausa de 1s entre lotes (limite real da Bot
API é ~30 msg/s), incrementa `sentCount`/`failedCount` por mensagem
(`Prisma.increment`, atômico). Falha de mensagem individual (bot bloqueado
pelo usuário etc) não derruba o broadcast inteiro — só conta como falha e
segue; `status: FAILED` só acontece se o bot nem estiver registrado (nada
pôde ser tentado). Painel novo em `/admin/mailing` (nível superior, não
dentro de um Flow — Broadcast é por Bot). Sem agendamento, só "enviar
agora" (`DRAFT` ficou fora do enum, já que nada no fluxo produz esse
estado). Verificado com um disparo real (segmento "Todos", 1 lead) —
painel mostrou "1 enviada / 0 falharam" e o usuário confirmou a mensagem
chegando no Telegram.

**Milestone 7 (dashboard) implementado e verificado (2026-08-19)** — fecha
a Fase 2 inteira, exceto WiinPay (bloqueado, ver abaixo). Dashboard
reescrito com filtro de bot + período (`hoje`/`ontem`/`7d`/`30d`/`total`,
querystring `?botId=&period=`) na querystring do `GET /admin`. Métricas
novas, todas deriváveis do que já existe (sem modelo novo): vendas
aprovadas (qtd+R$, por `paidAt`, não `createdAt` — mesmo critério já usado
no canal de vendas), ticket médio, tempo médio até pagar (`paidAt -
createdAt`, raw SQL com `EXTRACT(EPOCH ...)`), starts (Leads novos no
período), conversão de usuário (compradores/leads novos), conversão de
pagamento (pagos/PIX gerados no período), ranking top-5 por Código de Venda
(Origin, soma de receita). Gráfico de cobranças por dia agora acompanha o
período escolhido (antes fixo em 14 dias); em período "total" o gráfico é
limitado aos últimos 90 dias por legibilidade, mas as métricas continuam
all-time. Nova seção "Log de atividade" — mescla lead-criado/PIX-gerado/
venda-aprovada num único feed ordenado por hora, sempre os 20 mais
recentes (deliberadamente NÃO filtrado por período, senão ficaria vazio
toda vez que o usuário escolhesse "hoje" sem venda ainda). Pequeno acerto
à parte: "hoje"/"ontem" calculados com deslocamento fixo de -3h (Brasil não
observa horário de verão desde 2019), não UTC puro — senão o corte do dia
ficaria errado pro fuso do usuário. Fora de escopo (já descartado desde o
planejamento original): Ranking/Premiações/Top Players — features de
plataforma multi-tenant, não fazem sentido pra uma operação de bot pessoal
única. Verificado com dados reais via browser (8 vendas, R$11,00, ticket
médio R$1,38, conversão de pagamento 57.1% — todos os números batendo à
mão contra o banco).

**Achado durante a verificação**: notei mudanças no repositório fora desta
conversa — o usuário está configurando Tailwind CSS + DaisyUI em paralelo
(`tailwind.config.js`, `postcss.config.js`, `src/public/css/`,
`package.json`/`.gitignore` alterados, `header.ejs` já parcialmente migrado
pro visual novo, incluindo um novo `npm run dev` que roda servidor+watcher
de CSS junto via `concurrently`). Confirmado com o usuário: é trabalho dele
mesmo, ainda não terminado — as views de feature (dashboard/bots/flows/
mailing/settings) continuam consumindo as variáveis CSS/classes antigas de
propósito (comentário deixado no próprio `header.ejs`), então nada do que
foi construído nesta fase precisou mudar. **Importante**: os commits desta
sessão não incluem esses arquivos do Tailwind (ficam como trabalho não
commitado do usuário) — só os arquivos de fato tocados por cada milestone.

**Próximo**: Milestone 3 (WiinPay) segue bloqueado — usuário vai contatar o
suporte deles pra conseguir acesso à API/documentação (não é pública). Com
o Milestone 7 fechado, a Fase 2 está completa exceto WiinPay. Plano em
`C:\Users\gusta\.claude\plans\rippling-rolling-castle.md` já atualizado
pra refletir o rebuild do Upsell (Downsell/Assinatura/Mailing/Dashboard
seguem documentados lá como "desenho original, histórico" — atualizar lá
também na próxima passada).

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
