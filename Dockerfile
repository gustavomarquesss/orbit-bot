FROM node:20-slim AS build
WORKDIR /app
# node:20-slim (Debian) não vem com OpenSSL — o query engine do Prisma precisa
# dele pra rodar; sem isso ele "adivinha" a versão e pode quebrar em runtime.
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY prisma ./prisma
RUN npx prisma generate
COPY --from=build /app/dist ./dist
# EJS views do painel admin não são compiladas pelo tsc — copiadas à parte,
# no mesmo caminho relativo (src/server.ts resolve `views` ao lado do módulo).
COPY src/admin/views ./dist/admin/views

EXPOSE 3000
CMD ["node", "dist/server.js"]
