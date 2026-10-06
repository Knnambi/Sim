FROM node:22-alpine
WORKDIR /bridge
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.mjs ./
COPY proto ./proto
ENV BRIDGE_HOST=0.0.0.0 BRIDGE_PORT=8091
EXPOSE 8091
CMD ["node", "server.mjs"]
