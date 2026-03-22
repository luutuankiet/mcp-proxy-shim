FROM node:20-alpine

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npx", "-y", "@luutuankiet/mcp-proxy-shim", "serve"]
