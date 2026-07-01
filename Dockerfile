FROM node:20-alpine AS miniapp
WORKDIR /miniapp
COPY miniapp/package.json miniapp/package-lock.json* ./
RUN npm install
COPY miniapp/ ./
RUN npm run build

FROM python:3.14-slim
RUN apt update; apt install -y --no-install-recommends ffmpeg curl ca-certificates gnupg; \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -; \
    apt install -y --no-install-recommends nodejs; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml .
RUN pip install --no-cache-dir --pre .

COPY yt-hls/ ./yt-hls/
RUN cd yt-hls && npm install --omit=dev

#COPY bot.py .
COPY --from=miniapp /miniapp/dist ./miniapp/dist

CMD ["python", "bot.py"]
