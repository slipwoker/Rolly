# CPU image of the Rolly voice-agent test platform (backend + static browser client).
# Models are NOT baked in: mount ./models (see infrastructure/download_models.sh).
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 HF_HOME=/app/models/hf
RUN apt-get update && apt-get install -y --no-install-recommends libsndfile1 curl bzip2 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY backend backend
COPY providers providers
COPY memory memory
COPY telemetry telemetry
COPY benchmarks benchmarks
COPY finops finops
COPY config config
COPY frontend frontend
COPY infrastructure infrastructure
RUN useradd -m rolly && mkdir -p /app/data /app/models && chown -R rolly /app/data
USER rolly
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD curl -fs http://127.0.0.1:8000/healthz || exit 1
CMD ["uvicorn", "backend.app.main:app", "--host", "0.0.0.0", "--port", "8000"]
