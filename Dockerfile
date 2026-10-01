# 排练字幕修订 Web 应用
FROM node:20-slim

# better-sqlite3 为原生模块，预编译二进制在部分平台不可用时需要本地编译
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先装依赖（利用 Docker 层缓存）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 拷贝应用代码
COPY server ./server
COPY public ./public

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/app/data

EXPOSE 3000

# 容器启动时若数据库不存在会自动初始化（server/db.js 幂等建表）
CMD ["node", "server/index.js"]
