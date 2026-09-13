FROM ghcr.io/astral-sh/uv:0.12.13 AS uv
FROM python:3.13-slim
WORKDIR /app
COPY --from=uv /uv /bin/uv
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy \
    PATH="/app/investigator/.venv/bin:$PATH"
COPY investigator/pyproject.toml investigator/uv.lock /app/investigator/
COPY investigator/nightwatch_investigator /app/investigator/nightwatch_investigator
COPY contracts/schemas /app/contracts/schemas
RUN uv sync --project /app/investigator --locked --no-dev --no-cache \
    && useradd --uid 10002 --create-home --shell /usr/sbin/nologin investigator \
    && mkdir -p /app/investigator/.data \
    && chown 10002:10002 /app/investigator/.data
USER 10002:10002
EXPOSE 9998
CMD ["python", "-m", "uvicorn", "nightwatch_investigator.api:app", "--host", "0.0.0.0", "--port", "9998", "--workers", "1"]
