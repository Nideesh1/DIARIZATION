# Demo UI in a container. Build and run with compose.yaml (see README "Run with Docker Compose").
FROM python:3.12-slim

# ffmpeg: remux browser webm recordings so they can be seeked, and probe durations.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app
ENV UV_PROJECT_ENVIRONMENT=/opt/venv UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy \
    PATH=/opt/venv/bin:$PATH PYTHONUNBUFFERED=1
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

COPY app.py client.py ./
COPY static ./static

# Listen on all interfaces inside the container; compose publishes it on 127.0.0.1 only.
ENV DEMO_HOST=0.0.0.0 DEMO_PORT=8080 DEMO_DATA_DIR=/data
EXPOSE 8080
CMD ["python", "app.py"]
