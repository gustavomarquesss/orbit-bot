# DG Bot

Bot de vendas no Telegram para uso pessoal: fluxos de mensagens configuráveis,
botões que geram cobrança PIX (via SyncPay), entrega automática de conteúdo após
pagamento confirmado e rastreamento de origem entre canais/bots.

Arquitetura completa e justificativa de custo em [`ARCHITECTURE.md`](./ARCHITECTURE.md).
Estado atual do projeto (decisões, pendências) em [`PROJECT_STATE.md`](./PROJECT_STATE.md).

## Setup local

Guia completo (pré-requisitos, Postgres via Docker, `.env` mínimo, migrations,
login do painel e erros comuns) em [`SETUP-LOCAL.md`](./SETUP-LOCAL.md).

Resumo:

```bash
npm install
docker run -d --name dgbot-db -e POSTGRES_USER=dgbot -e POSTGRES_PASSWORD=devpass -e POSTGRES_DB=dgbot -p 55432:5432 postgres:16-alpine
cp .env.example .env   # ajustar DATABASE_URL para @localhost:55432 (nunca commitar o .env)
npx prisma migrate dev # cria as tabelas no banco apontado por DATABASE_URL
npm run user:create    # cria um login para o painel /admin
npm run dev
```

## Editando mensagens, botões e fluxos (sem tocar em código)

Todo o conteúdo do bot — mensagens, mídia, botões, produtos e para onde cada
botão leva — fica salvo no banco de dados, não em código. Duas formas de editar:

### Painel web (`/admin`, protegido por senha) — recomendado

Acesse `https://SEU_DOMINIO/admin`, faça login com `ADMIN_PANEL_PASSWORD`, e use:

- **Dashboard** — métricas de vendas (receita, conversão, últimas cobranças).
- **Fluxos** — criar/editar/excluir fluxos, passos (texto e mídia) e botões,
  com autocomplete pra apontar botões de "ir para outro fluxo" ou "vender produto".
- **Produtos** — criar/editar/excluir produtos (preço, tipo de entrega,
  proteção de conteúdo, ativo/inativo).

Único ponto que o painel não faz por você: campos de mídia (foto/vídeo/áudio
de um passo) pedem o `file_id` do Telegram colado manualmente — não há upload
direto pela tela ainda, porque isso exigiria rotear o arquivo pelo próprio bot
pra capturar o `file_id`. Se isso virar fricção no dia a dia, é uma extensão
natural do painel (ver `PROJECT_STATE.md`).

### Comandos no bot (alternativa)

Também dá pra editar direto no chat com o bot (disponível só para o
`TELEGRAM_ADMIN_USER_ID` configurado no `.env`; qualquer outro usuário que
tentar usá-los é ignorado silenciosamente).

Todos os comandos abaixo estão **implementados e com CRUD real no banco**
(não há mais wizard/scene do Telegraf — ver decisão em
`src/bot/adminCommands.ts`: argumentos numa linha só, com `|` separando
campos que podem ter espaço, para não depender de estado de conversa em
memória, que se perderia se o processo dormir/reiniciar no Render free tier):

| Comando | O que faz |
|---|---|
| `/fluxos` | Lista os fluxos existentes (chave, nome, e qual é o de entrada) |
| `/novofluxo <chave> <nome>` | Cria um novo fluxo |
| `/novamensagem <fluxo> <texto>` | Adiciona um passo (texto) ao fim do fluxo. Para incluir foto/vídeo/áudio/documento, envie a mídia normalmente e depois responda a ela (reply) com este comando |
| `/novobotao <fluxo> <passo> <label> \| <AÇÃO> \| <destino>` | Adiciona um botão a um passo. `<AÇÃO>` é uma de `GOTO_FLOW`, `BUY_PRODUCT`, `OPEN_LINK`, `REDIRECT_CHANNEL`; `<destino>` é a chave do fluxo, o id (ou nome) do produto, ou a URL, conforme a ação |
| `/produtos` | Lista produtos cadastrados (nome, preço em R$, ativo/inativo, id) |
| `/novoproduto <nome> \| <preço> \| <FILE\|LINK> \| <message_id do cofre ou link> \| <protect sim/não> \| <descrição>` | Cadastra um produto numa linha só |
| `/vendas` | Resumo de Orders por status (pendente/paga/recusada/expirada), contado direto do banco |

Exemplos:

```
/novofluxo boas-vindas Boas-vindas
/novamensagem boas-vindas Olá! Bem-vindo(a).
/novoproduto Ebook Vendas | 29.90 | FILE | 482 | sim | PDF com o passo a passo
/novobotao boas-vindas 0 Comprar agora | BUY_PRODUCT | Ebook Vendas
/novobotao boas-vindas 0 Ver ofertas | GOTO_FLOW | ofertas
/novobotao boas-vindas 0 Canal VIP | OPEN_LINK | https://t.me/seu_canal
```

Para produtos do tipo `FILE`, o "destino" não é o `file_id` do Telegram — é o
**número da mensagem** (`message_id`) que contém o arquivo dentro do canal
"cofre" configurado em `TELEGRAM_VAULT_CHANNEL_ID`. Poste o produto uma vez
nesse canal e use o número da mensagem (visível encaminhando-a pra "Saved
Messages" e olhando os detalhes, ou via um bot auxiliar tipo @userinfobot em
canais). A entrega usa `copyMessage`, que exige `message_id`, não `file_id`
— decisão documentada em `src/bot/delivery.ts` e no `prisma/schema.prisma`.


## Fluxo de branches

```
feature/*  →  dev  →  homolog  →  main
```

- **`main`** — estável, produção. Protegida: nunca commit direto, só merge vindo de `homolog`.
- **`homolog`** — homologação: features já concluídas em `dev` são validadas aqui antes de ir para `main`.
- **`dev`** — desenvolvimento contínuo, integração das features em andamento.
- **`feature/nome-da-feature`** — uma branch por funcionalidade, criada a partir de `dev`, com merge de volta pra `dev` ao concluir (ex: `feature/pagamento-pix`, `feature/fluxo-mensagens`).

Fluxo de trabalho:

```bash
git checkout dev
git checkout -b feature/minha-feature
# ... trabalhar, commitar ...
git checkout dev
git merge feature/minha-feature
git branch -d feature/minha-feature
```

Quando um lote de features em `dev` estiver pronto para validação:

```bash
git checkout homolog
git merge dev
# validar em ambiente de homologação
git checkout main
git merge homolog
```

### Commits

Padrão [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` nova funcionalidade
- `fix:` correção de bug
- `chore:` manutenção, dependências, config
- `docs:` documentação
- `test:` testes

Exemplo: `feat: gerar cobrança PIX ao clicar em botão de compra`

## Deploy

Self-hosted numa VPS própria via Docker Compose (`app` + `postgres` + `caddy`
como reverse proxy com TLS automático). Requer um domínio/subdomínio apontando
pro IP da VPS (obrigatório para o Caddy emitir certificado — os webhooks do
Telegram e da SyncPay exigem HTTPS confiável).

```bash
cp .env.example .env   # preencher tudo, incluindo POSTGRES_*, PUBLIC_DOMAIN e PUBLIC_BASE_URL=https://SEU_DOMINIO
docker compose up -d --build
docker compose exec app npx prisma migrate deploy
```

Detalhes de provisionamento da VPS, backup do Postgres e registro dos
webhooks em `PROJECT_STATE.md`, atualizados conforme o deploy real for feito.
