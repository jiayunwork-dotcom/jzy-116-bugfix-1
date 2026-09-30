# 单阶段构建：node:20-slim 内完成 TypeScript 编译，产出单一容器即可对外应答
FROM node:20-slim

WORKDIR /app

# 先装依赖，利用层缓存
COPY package.json package-lock.json ./
RUN npm ci

# 拷贝源码并编译到 dist/
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# 运行期不再需要开发依赖与测试代码，清理掉
RUN npm prune --omit=dev && npm cache clean --force

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

USER node
CMD ["node", "dist/server.js"]
