# Rodando o projeto localmente

Guia para subir o DG Bot numa máquina nova depois de clonar o repositório.
O que **não** vem no Git (bloqueado pelo `.gitignore`): `.env`, `node_modules/`,
`dist/`, `public/css/output.css`, o banco. Só o `.env` precisa ser criado à mão —
o resto é gerado pelos comandos abaixo.

## 1. Pré-requisitos

| Ferramenta | Versão | Para quê |
|---|---|---|
| Node.js | 20+ | rodar a aplicação (`package.json` exige `>=20`) |
| Docker Desktop | qualquer | subir o Postgres (o schema é PostgreSQL, não dá pra usar SQLite) |
| Git | qualquer | clonar |

## 2. Instalar dependências

```bash
npm install
```

## 3. Subir um Postgres local

Um container só para desenvolvimento, na porta `55432` (evita conflito com um
Postgres 5432 que já exista na máquina):

```bash
docker run -d --name dgbot-db \
  -e POSTGRES_USER=dgbot \
  -e POSTGRES_PASSWORD=devpass \
  -e POSTGRES_DB=dgbot \
  -p 55432:5432 \
  postgres:16-alpine
```

Nas próximas vezes o container já existe — basta:

```bash
docker start dgbot-db
```

## 4. Criar o `.env`

```bash
cp .env.example .env
```

Edite para o mínimo necessário para a aplicação subir. Só estas variáveis são
validadas na inicialização (ver `src/config.ts`); as demais linhas do
`.env.example` podem ficar em branco enquanto você não for testar bot/pagamento:

```env
TELEGRAM_ADMIN_USER_ID=123456789
BOT_TOKEN_ENCRYPTION_KEY=dev-local-encryption-key-1234567890
SYNCPAY_API_BASE_URL=https://api.syncpayments.com.br
DATABASE_URL=postgresql://dgbot:devpass@localhost:55432/dgbot
SESSION_SECRET=dev-local-session-secret-1234567890
PORT=3000
PUBLIC_BASE_URL=http://localhost:3000
NODE_ENV=development
```

> ⚠️ O `DATABASE_URL` do `.env.example` aponta para `@db:5432` (rede do
> `docker-compose` de produção). Rodando local com `npm run dev` tem que ser
> `@localhost:55432`, batendo com o container do passo 3.
>
> `BOT_TOKEN_ENCRYPTION_KEY` e `SESSION_SECRET` precisam ter no mínimo 16
> caracteres. Em produção gere com `openssl rand -hex 32`.

## 5. Criar as tabelas

Aplica todas as migrations no banco apontado pelo `DATABASE_URL` (e roda o
`prisma generate` junto):

```bash
npx prisma migrate dev
```

Para conferir depois se está tudo aplicado: `npx prisma migrate status`.

## 6. (Opcional) Popular dados de exemplo

Cria um funil + plano de teste para não começar com o painel vazio:

```bash
npx tsx prisma/seed.ts
```

## 7. Criar um login para o painel admin

O login é multiusuário (contas no banco), não há senha fixa no `.env`:

```bash
npm run user:create   # pergunta e-mail e senha
npm run user:list     # confere quem já está cadastrado
```

## 8. Rodar

```bash
npm run dev
```

Sobe dois processos em paralelo (`concurrently`):

- **server** — `tsx watch src/server.ts`, a aplicação Express + bot, na porta 3000
- **css** — `tailwindcss --watch`, gera `public/css/output.css` (arquivo não
  versionado; por isso o primeiro `npm run dev` é obrigatório antes de abrir o painel)

Quando aparecer `ouvindo na porta 3000 (development)`, abra:

- Painel admin: <http://localhost:3000/admin> (login com a conta do passo 7)
- Health check: <http://localhost:3000/health>

Para parar: `Ctrl+C`. Para parar o banco: `docker stop dgbot-db`.

## Fazer o bot responder no Telegram (túnel HTTPS)

O projeto é **100% webhook** — não tem long-polling. Para o bot responder a
`/start`, o Telegram precisa conseguir fazer um `POST` numa URL HTTPS pública
que chegue no seu `localhost:3000`. Em dev isso é feito com um túnel grátis do
Cloudflare (sem conta):

```bash
docker run -d --name dgbot-tunnel cloudflare/cloudflared:latest \
  tunnel --url http://host.docker.internal:3000
```

Depois:

1. Pegue a URL pública gerada:
   ```bash
   docker logs dgbot-tunnel 2>&1 | grep trycloudflare.com
   ```
2. Coloque essa URL em `PUBLIC_BASE_URL` no `.env`.
3. Reinicie o `npm run dev` (o `tsx watch` **não** recarrega em mudança de
   `.env`) — no boot ele chama `setWebhook` para cada bot ativo.

No log você deve ver `webhook registrado em https://...` para cada bot com token
válido.

### Gotchas do túnel grátis

- **A URL muda toda vez que o container reinicia** (`trycloudflare` dá um
  subdomínio aleatório). Sempre que reiniciar o túnel, atualize o `.env` e
  reinicie o servidor.
- **`400: bad webhook: Failed to resolve host`** no `setWebhook`: o Telegram às
  vezes demora (ou não consegue) resolver um subdomínio `trycloudflare.com`
  recém-criado, mesmo com o túnel no ar. Solução: `docker restart dgbot-tunnel`
  para pegar outro subdomínio, atualizar o `.env`, reiniciar — repita até um
  hostname que o Telegram aceite (`setWebhook -> OK`).
- **`file_id` de mídia não é portável entre bots.** Um passo de fluxo cujo
  vídeo/foto foi enviado por outro bot vai dar `400: wrong file identifier` — o
  código cai no texto como fallback. Regenere a mídia pelo bot atual (painel
  `/admin/bots/<id>/media` ou reenviando pro bot).

## O que exige credenciais reais (não precisa para desenvolver a interface)

| Recurso | Por quê |
|---|---|
| Bot do Telegram | o token é cadastrado pelo painel (`/admin/bots`), não no `.env`. Precisa de um bot criado no [@BotFather](https://t.me/BotFather). |
| Webhooks (Telegram / SyncPay) | exigem uma URL HTTPS pública. Em dev usa-se um túnel grátis do Cloudflare (`cloudflare/cloudflared`), com `PUBLIC_BASE_URL` apontando para a URL do túnel. Detalhes em `PROJECT_STATE.md`, seção "Ambiente de homologação local". |
| SyncPay (PIX) | `client_id` / `client_secret` / `webhook secret` são configurados por usuário em `/admin/settings`, não no `.env`. |

Sem isso o servidor ainda sobe normalmente — só aparecem erros `401 Unauthorized`
no log ao tentar registrar webhooks de bots cadastrados, o que é esperado e não
impede o painel de funcionar.

## Erros comuns

| Sintoma | Causa / solução |
|---|---|
| `Configuração inválida. Confira o .env...` | falta variável obrigatória no `.env` (ver passo 4) |
| `Can't reach database server at localhost:55432` | o container do Postgres não está rodando — `docker start dgbot-db` |
| painel sem estilo / CSS quebrado | `public/css/output.css` não foi gerado — rode `npm run dev` (não só `dev:server`) |
| `P3009` / migrations pendentes | rode `npx prisma migrate dev` |
