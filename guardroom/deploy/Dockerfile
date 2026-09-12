FROM ghcr.io/astral-sh/uv:0.12.13 AS uv
FROM python:3.13-slim

WORKDIR /app
COPY --from=uv /uv /bin/uv
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy \
    PATH="/app/guardroom/backend/.venv/bin:$PATH" \
    GUARDROOM_CONFIG=/app/guardroom/configs/shop.json \
    NIGHTWATCH_INVESTIGATION_DB=/app/guardroom/.run/investigations.sqlite3

COPY investigation-agent /app/investigation-agent
COPY guardroom/backend /app/guardroom/backend
RUN uv sync --project /app/guardroom/backend --locked --no-dev --no-cache

COPY contracts/schemas /app/contracts/schemas
COPY guardroom/configs/shop.json /app/guardroom/configs/shop.json
RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin guardroom \
    && mkdir -p /app/guardroom/.run /app/.run/monitor \
    && chown 10001:10001 /app/guardroom/.run

USER 10001:10001
EXPOSE 9999
CMD ["python", "-m", "uvicorn", "main:app", "--app-dir", "/app/guardroom/backend", "--host", "0.0.0.0", "--port", "9999", "--workers", "1"]
