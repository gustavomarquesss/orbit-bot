# DG Bot

Bot de vendas no Telegram para uso pessoal: fluxos de mensagens configuráveis,
botões que geram cobrança PIX (via SyncPay), entrega automática de conteúdo após
pagamento confirmado e rastreamento de origem entre canais/bots.

Arquitetura completa e justificativa de custo em [`ARCHITECTURE.md`](./ARCHITECTURE.md).
Estado atual do projeto (decisões, pendências) em [`PROJECT_STATE.md`](./PROJECT_STATE.md).

## Setup local

```bash
npm install
cp .env.example .env   # preencher com suas credenciais (nunca commitar o .env)
npx prisma migrate dev # cria as tabelas no banco apontado por DATABASE_URL
npm run dev
```

## Editando mensagens, botões e fluxos (sem tocar em código)

Todo o conteúdo do bot — mensagens, mídia, botões e para onde cada botão leva —
fica salvo no banco de dados, não em código. Para editar, use os comandos
administrativos direto no chat com o bot (disponíveis só para o
`TELEGRAM_ADMIN_USER_ID` configurado no `.env`):

| Comando | O que faz |
|---|---|
| `/fluxos` | Lista os fluxos existentes |
| `/novofluxo <chave> <nome>` | Cria um novo fluxo |
| `/novamensagem <fluxo>` | Inicia o assistente para adicionar um passo (texto/mídia) a um fluxo |
| `/novobotao <fluxo> <passo>` | Adiciona um botão a um passo, com sua ação (ir para outro fluxo, comprar produto, abrir link, redirecionar para canal) |
| `/produtos` | Lista produtos cadastrados |
| `/novoproduto` | Assistente para cadastrar um produto (preço, arquivo/link de entrega) |
| `/vendas` | Resumo rápido de vendas aprovadas/pendentes/recusadas |

O guia detalhado, com exemplos passo a passo de cada comando, fica documentado
à medida que os comandos forem implementados (task de documentação em
`PROJECT_STATE.md`).

O painel web (`/admin`, protegido por senha) complementa isso com métricas e
histórico de vendas — é somente leitura na v1.

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
