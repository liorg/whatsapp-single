FROM node:20-slim

# ── System deps ──────────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y \
    python3 python3-pip python3-venv \
    redis-server \
    curl \
    git \
    build-essential \
    libvips-dev \
    && rm -rf /var/lib/apt/lists/*

# ── Python venv ───────────────────────────────────────────────────────────────
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY fastapi/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

# ── Node / Baileys ────────────────────────────────────────────────────────────
WORKDIR /app/baileys
COPY baileys/package.json ./
RUN npm install --omit=dev

COPY baileys/src/ ./src/

# ── FastAPI ───────────────────────────────────────────────────────────────────
WORKDIR /app/fastapi
COPY fastapi/app/ ./app/

# ── Supervisor (מנהל תהליכים) ─────────────────────────────────────────────────
RUN pip install supervisor
COPY supervisord.conf /etc/supervisord.conf

# ── Auth dir ─────────────────────────────────────────────────────────────────
RUN mkdir -p /app/auth_info

WORKDIR /app

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=5 \
  CMD curl -f http://localhost:8000/health || exit 1

CMD ["supervisord", "-c", "/etc/supervisord.conf", "-n"]
