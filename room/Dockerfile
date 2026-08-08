FROM node:22-alpine
WORKDIR /app
COPY server.mjs .
ENV PEERTABLE_PORT=8790 PEERTABLE_DATA=/data
EXPOSE 8790
CMD ["node", "server.mjs"]
