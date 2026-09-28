# One image for both app services: `ui` runs app.py, `worker` runs worker.py (see compose.yaml).
FROM python:3.12-slim

# ffmpeg: the worker remuxes browser webm recordings so they can be seeked, and probes durations.
# tzdata: list timestamps in local time (TZ from compose / .env).
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg tzdata \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app
ENV UV_PROJECT_ENVIRONMENT=/opt/venv UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy \
    PATH=/opt/venv/bin:$PATH PYTHONUNBUFFERED=1
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

COPY app.py client.py store.py worker.py ./
COPY sql ./sql
COPY static ./static

# Listen on all interfaces inside the container; compose publishes it on 127.0.0.1 only.
ENV DEMO_HOST=0.0.0.0 DEMO_PORT=8080
EXPOSE 8080
CMD ["python", "app.py"]
