FROM node:20-alpine

WORKDIR /app

# 先复制 package.json 安装依赖（利用 Docker 缓存层）
COPY package.json package-lock.json* ./
RUN npm install --production

# 复制源码
COPY . .

# 暴露端口
EXPOSE 4000

# 启动
CMD ["node", "src/server.js"]
