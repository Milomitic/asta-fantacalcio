# Dockerfile
FROM node:20-alpine

# Create app directory
WORKDIR /app

# Install only production deps
COPY package.json package-lock.json* ./
RUN npm ci --only=production || npm install --only=production

# Copy source
COPY server.js ./
COPY public ./public
COPY data ./data

# Ensure runtime dirs (also handled by app, but it's nice to have)
RUN mkdir -p /app/logs

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
