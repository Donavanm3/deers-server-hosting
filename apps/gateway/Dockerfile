FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY packages ./packages
COPY apps/gateway ./apps/gateway
COPY prisma ./prisma
RUN npm install --workspaces --include-workspace-root && npx prisma generate
USER node
EXPOSE 8080
CMD ["npm", "run", "start", "-w", "@deers/gateway"]
