FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
COPY packages ./packages
COPY apps/panel ./apps/panel
COPY prisma ./prisma
RUN npm install --workspaces --include-workspace-root
RUN npx prisma generate && npm run build -w @deers/panel

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
USER node
EXPOSE 3000
CMD ["npm", "run", "start", "-w", "@deers/panel"]
