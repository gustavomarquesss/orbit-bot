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
| Infra/deploy | Docker Compose (app + Postgres) numa VPS própria | Ver "Hospedagem" abaixo — decisão revisada em 2026-08-18 |
| Entrega de conteúdo | Canal privado "cofre" no Telegram + `file_id` salvo no banco | Reenvio via `copyMessage` com `protect_content: true`. Custo zero, sem storage externo, sem limite de tamanho próprio |
| Config de mensagens/fluxos/botões | **Banco de dados**, editável via comandos administrativos do próprio bot | Um arquivo JSON/YAML versionado exigiria commit + push + redeploy a cada ajuste de texto. Guardando no Postgres, o operador edita na hora, direto pelo Telegram — é a opção "comando administrativo no próprio bot" já prevista no briefing original |

## Hospedagem

Pesquisado em 2026-08-18. Decisão original (Render free + Neon free) foi
**revisada no mesmo dia**, a pedido do usuário, antes de qualquer deploy real
acontecer — nenhum retrabalho, só documentando a mudança.

### Decisão original (histórico, não vale mais)

- **Fly.io**: sem free tier desde 2024/2025 (~$2–25/mês). Descartado.
- **Railway**: "free" hoje já cobra ~$1/mês com recursos bem limitados. Não é
  free tier real.
- **Render free**: 750h/mês grátis, mas dorme após 15 min sem tráfego HTTP de
  entrada (~1 min pra acordar). **Motivo da revisão**: o usuário precisa de
  confirmação de pagamento e notificações em tempo quase real — um atraso de
  até 1 min no pior caso, ainda que raro com keep-alive, não é aceitável pro
  caso de uso. Além disso, o usuário já pretende escalar a infra no futuro, e
  prefere montar o formato definitivo agora em vez de migrar depois.

### Decisão atual: VPS própria + Docker Compose

- **VPS**: qualquer provedor com IPv4 público e Docker (referência de custo:
  Hetzner CX22 ou equivalente, ~€5–8/mês — self-hosted true always-on, sem
  spin-down).
- **App + Postgres no mesmo servidor**, orquestrados via `docker-compose.yml`:
  - `app`: container Node.js (build a partir do `Dockerfile` do repo).
  - `db`: container `postgres:16`, com volume nomeado persistente (backup é
    responsabilidade do usuário — ver seção "Backup" abaixo).
  - `caddy`: reverse proxy com HTTPS automático (Let's Encrypt) na frente do
    `app` — **necessário**: tanto o webhook do Telegram quanto o da SyncPay
    exigem endpoint HTTPS com certificado confiável. Caddy resolve isso com
    zero configuração manual de certificado, desde que exista um domínio (ou
    subdomínio) apontando pro IP da VPS.
- **Sem Neon/Supabase**: `DATABASE_URL` aponta pro Postgres do próprio
  `docker-compose` (`postgresql://.../db:5432/...` dentro da rede interna do
  Compose).
- **Sem keep-alive ping**: não existe spin-down numa VPS always-on — o
  mecanismo de `/health` continua útil como health check do Docker/monitoramento,
  mas deixa de ser uma mitigação de cold-start.

**Pendência a confirmar com o usuário**: qual VPS efetivamente contratar e se
já existe um domínio/subdomínio disponível para apontar (obrigatório para o
Caddy emitir certificado TLS). Ver `PROJECT_STATE.md`.

**Trade-off assumido conscientemente**: o usuário passa a ser responsável por
atualizações de segurança do SO, backup do volume do Postgres e renovação de
certificado (o Caddy renova sozinho, mas depende do domínio continuar
apontando certo). Em troca, ganha always-on real e controle total da infra —
consistente com o objetivo do projeto de não depender de terceiros.

## Custo total estimado: ~€5–8/mês (VPS)

Único custo recorrente do projeto. Ainda assim mínimo frente a alternativas
gerenciadas equivalentes (um Postgres gerenciado + um serviço web always-on
pago facilmente passaria de $15–20/mês).

## Backup

Volume do Postgres (`docker-compose.yml`) é a única fonte de dados persistente
do projeto — sem ele, perde-se histórico de vendas, leads e config de fluxos.
Backup mínimo viável: `pg_dump` agendado (cron na própria VPS) pra um destino
fora da VPS (ex: objeto S3-compatible barato, ou simplesmente `scp` periódico
pra outra máquina). Detalhar e implementar como parte da task de deploy — ver
`PROJECT_STATE.md`.

## Estrutura de pastas

```
dg-bot/
├── ARCHITECTURE.md          # este arquivo
├── PROJECT_STATE.md         # memória viva do projeto — ler antes/depois de cada tarefa
├── README.md                # setup, fluxo de branches, guia de edição sem código
├── Dockerfile                # build da imagem da app
├── docker-compose.yml        # app + postgres + caddy (reverse proxy/TLS)
├── Caddyfile                  # config do reverse proxy
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
