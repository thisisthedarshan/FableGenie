FROM node:20-slim

WORKDIR /app
COPY backend/package*.json ./
RUN npm install --production

COPY backend ./backend
COPY frontend ./frontend

ENV PORT=8080
EXPOSE 8080

CMD ["node", "backend/src/server.js"]
