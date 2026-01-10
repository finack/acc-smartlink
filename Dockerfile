# Build stage
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Production stage
FROM node:20-alpine
WORKDIR /app

# Copy built files and dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./

# Create data directory for SQLite database
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV DB_PATH=/app/data/spa-data.db
EXPOSE 3000

CMD ["node", "dist/spa-monitor.js"]
