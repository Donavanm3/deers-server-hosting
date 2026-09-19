FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY packages ./packages
COPY apps/worker ./apps/worker
COPY apps/panel/src/lib ./apps/panel/src/lib
COPY prisma ./prisma
RUN npm install --workspaces --include-workspace-root && npx prisma generate
USER node
CMD ["npm", "run", "start", "-w", "@deers/worker"]
