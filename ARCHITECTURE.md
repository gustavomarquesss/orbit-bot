# Arquitetura — DG Bot (bot de vendas Telegram, uso pessoal)

> Este arquivo é a fonte da verdade sobre decisões técnicas. Qualquer agente/sessão
> deve ler este arquivo (e o `PROJECT_STATE.md`) antes de tomar decisões estruturais
> novas, para não recriar debates já resolvidos.

## Contexto

Bot de vendas no Telegram para uso pessoal (um único operador/beneficiário, sem
revenda como SaaS). Modelo de referência: Shark Bot, porém mais simples e 100%
sob controle próprio (sem depender de plataforma terceira que possa omitir vendas).

## Stack escolhida

| Camada | Escolha | Justificativa |
|---|---|---|
| Linguagem/Runtime | Node.js 20 + TypeScript | Preferência do usuário |
| Framework HTTP | Express | Serve, no mesmo processo: webhook do Telegram, webhook da SyncPay e o painel admin — um único deploy, custo mínimo |
| Bot Telegram | [Telegraf](https://telegraf.js.org/) | Mais mantido que `node-telegram-bot-api`; suporta webhook nativamente; `scenes`/`wizards` mapeiam bem para "fluxos configuráveis" |
| ORM / DB access | Prisma | Boa DX para schema e migrations; suporte oficial a Postgres/Neon; usuário não mexe em SQL cru no dia a dia |
| Banco de dados | **Postgres via [Neon](https://neon.tech) (free tier)** | Ver "Hospedagem" abaixo — Render free não tem disco persistente, então SQLite local não sobrevive a redeploys |
| Gateway PIX | SyncPay | Já usada pelo usuário — conta e credenciais existentes |
| Painel admin | Express + EJS (server-rendered) + Chart.js via CDN | Painel de uso único (só o operador), não justifica SPA/build step. Login simples via senha em variável de ambiente (sem multiusuário) |
| Entrega de conteúdo | Canal privado "cofre" no Telegram + `file_id` salvo no banco | Reenvio via `copyMessage` com `protect_content: true`. Custo zero, sem storage externo, sem limite de tamanho próprio |
| Config de mensagens/fluxos/botões | **Banco de dados**, editável via comandos administrativos do próprio bot | Um arquivo JSON/YAML versionado exigiria commit + push + redeploy a cada ajuste de texto. Guardando no Postgres, o operador edita na hora, direto pelo Telegram — é a opção "comando administrativo no próprio bot" já prevista no briefing original |

## Hospedagem

Pesquisado em 2026-08-18 antes de decidir:

- **Fly.io**: removeu o free tier em 2024/2025. Hoje é pago desde o primeiro Machine
  (~$2–25/mês dependendo do uso). Descartado.
- **Railway**: o "free" hoje na prática já cobra ~$1/mês com recursos bem limitados
  (1 vCPU / 0.5GB). Não é mais um free tier real.
- **Render**: ainda oferece free tier real — 750h/mês grátis, 512MB RAM, 0.1 CPU.
  **Trade-off aceito com o usuário**: o serviço dorme após 15 min sem tráfego HTTP
  de entrada e leva ~1 min para acordar. Como tanto o webhook do Telegram quanto o
  da SyncPay são requests HTTP de entrada, eles *acordam* o serviço — a cobrança
  ou confirmação não se perde, apenas atrasa até ~1 min no pior caso.

**Escolhido: Render (free tier)**, com mitigação:
- Um ping externo gratuito (cron-job.org ou UptimeRobot) batendo em `/health` a
  cada ~10 min para reduzir a janela de sono e, consequentemente, a frequência de
  cold-starts.
- Se o atraso deixar de ser aceitável (volume maior, reclamação de cliente), o
  upgrade natural é Render Starter (~$7/mês) ou migrar para uma VPS própria —
  decisão a revisitar depois, não bloqueia o v1.

**Banco: Neon (free tier)** — 100 CU-hours/mês, sem pausa agressiva por
inatividade (diferente do Supabase, que pausa após 7 dias sem request). Só
precisamos de Postgres puro, sem as features extras do Supabase (auth/storage/realtime).

## Custo total estimado: R$0/mês

Único custo indireto é o tempo de resposta ocasionalmente mais lento (cold start),
não dinheiro.

## Estrutura de pastas

```
dg-bot/
├── ARCHITECTURE.md          # este arquivo
├── PROJECT_STATE.md         # memória viva do projeto — ler antes/depois de cada tarefa
├── README.md                # setup, fluxo de branches, guia de edição sem código
├── prisma/
│   └── schema.prisma        # modelo de dados único, fonte da verdade do schema
├── src/
│   ├── server.ts            # bootstrap do Express: monta bot webhook + payment webhook + admin
│   ├── config.ts            # leitura/validação de env vars
│   ├── db/
│   │   └── client.ts        # Prisma client singleton
│   ├── bot/
│   │   ├── index.ts         # instância Telegraf, registro de handlers
│   │   ├── flows.ts         # engine que lê Flow/FlowStep/Button do banco e conduz a conversa
│   │   ├── adminCommands.ts # comandos /novomsg, /editarbotao etc — edição sem código
│   │   ├── deepLink.ts      # parsing do parâmetro `start` e resolução de Origin
│   │   └── delivery.ts      # entrega de conteúdo via canal-cofre + protect_content
│   ├── payments/
│   │   ├── syncpay.ts       # client HTTP da API SyncPay (gerar cobrança, consultar status)
│   │   └── webhook.ts       # handler do webhook de confirmação + idempotência
│   └── admin/
│       ├── routes.ts        # rotas do painel (login, dashboard, vendas)
│       └── views/           # templates EJS
├── scripts/
│   └── agent-browser-check.mjs  # já existente — validação visual do painel admin
├── .env.example
├── package.json
└── tsconfig.json
```

## Modelo de dados (resumo — detalhado em `prisma/schema.prisma`)

- `Origin` — fontes de tráfego rastreáveis (bot A, canal B, campanha C), cada uma
  com um `param` usado no deep link `t.me/seu_bot?start=param`.
- `Lead` — usuário do Telegram que interagiu com o bot; guarda `telegramId` e a
  `Origin` do primeiro contato.
- `Flow` / `FlowStep` / `Button` — fluxos de mensagens configuráveis e seus
  botões, editáveis via comando admin, sem deploy.
- `Product` — o que é vendido: preço, tipo de entrega (arquivo via `file_id` do
  Telegram ou link externo), flag de `protect_content`.
- `Order` — uma cobrança PIX gerada: liga `Lead` + `Product` + `Origin`, guarda
  o id da cobrança na SyncPay, status (pending/paid/refused/expired), valores e
  timestamps. É o registro que permite auditoria cruzada com o extrato real da
  gateway.
- `WebhookEvent` — log bruto de todo webhook recebido da SyncPay (payload +
  id externo), usado para garantir idempotência (webhook duplicado não gera
  entrega duplicada nem reprocessamento).

## Segurança

- Credenciais (token do bot, API key SyncPay, secret do webhook, senha do
  painel admin) apenas em variáveis de ambiente, nunca commitadas — `.gitignore`
  já cobre `.env*`.
- Webhook da SyncPay validado por assinatura/segredo compartilhado (a confirmar
  no momento da implementação, conforme doc oficial da SyncPay).
- Todo o código é próprio; nenhuma lógica de geração de cobrança fica em serviço
  terceiro fora do nosso controle.

## Fluxo de branches

```
feature/*  →  dev  →  homolog  →  main
```

- `main`: estável, só recebe merge (nunca commit direto).
- `homolog`: features prontas em validação antes de produção.
- `dev`: integração contínua do que está em desenvolvimento.
- `feature/*`: uma branch por funcionalidade, a partir de `dev`.
- Commits seguem [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `chore:`, `docs:`, `test:`).

Detalhado com exemplos práticos no `README.md`.
