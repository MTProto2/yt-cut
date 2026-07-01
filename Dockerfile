FROM node:20-alpine AS build
WORKDIR /miniapp
COPY miniapp/package.json miniapp/package-lock.json* ./
RUN npm install
COPY miniapp/ ./
ARG VITE_YT_HLS_URL
ENV VITE_YT_HLS_URL=${VITE_YT_HLS_URL}
RUN npm run build

FROM nginx:alpine
COPY --from=build /miniapp/dist /usr/share/nginx/html/miniapp
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
