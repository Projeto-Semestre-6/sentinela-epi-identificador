# syntax=docker/dockerfile:1.7
# ── Backend Dockerfile (multi-stage) ────────────────────────────────────────
# Stage 1: instala dependências pesadas (torch CPU, ultralytics) num venv
FROM python:3.11-slim AS builder

# Sem PYTHONDONTWRITEBYTECODE: queremos .pyc gerados (startup mais rápido).
ENV PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /build

# Todas as deps têm wheel pronto: gcc / libglib2.0-dev não são necessários.

COPY backend/requirements.txt ./requirements.txt

# venv (e não --target): o pip enxerga o torch já instalado e NÃO puxa o
# torch CUDA do PyPI quando resolve o ultralytics.
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Cache do pip persistido entre builds (BuildKit).
RUN --mount=type=cache,target=/root/.cache/pip \
    # 1) torch/torchvision CPU-only (versões fixas)
    pip install \
        torch==2.5.1 torchvision==0.20.1 \
        --index-url https://download.pytorch.org/whl/cpu \
    # 2) demais deps (torch já satisfeito -> sem CUDA)
    && pip install -r requirements.txt \
    # 3) ultralytics puxa opencv-python (GUI); mantém só a versão headless
    && pip uninstall -y opencv-python \
    && pip install --force-reinstall --no-deps opencv-python-headless \
    # 4) pré-compila bytecode para o runtime
    && python -m compileall -q /opt/venv

# ── Stage 2: imagem de execução (sem ferramentas de build) ──────────────────
FROM python:3.11-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:$PATH"

WORKDIR /app

# Apenas libs de runtime necessárias para OpenCV / libGL
RUN apt-get update && apt-get install -y --no-install-recommends \
        libglib2.0-0 \
        libsm6 \
        libxext6 \
        libxrender1 \
        libgl1 \
        curl \
    && rm -rf /var/lib/apt/lists/*

# Copia venv do stage builder (mesmo caminho /opt/venv, mesma base Python)
COPY --from=builder /opt/venv /opt/venv

# Copia código-fonte e modelo
COPY backend/ ./backend/
COPY best.pt  ./best.pt

WORKDIR /app/backend

EXPOSE 8000

CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
