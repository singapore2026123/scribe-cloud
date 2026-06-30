FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      libsndfile1 ffmpeg && rm -rf /var/lib/apt/lists/*

# CPU-only torch (avoids huge CUDA download)
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .

# Writable HF cache (HF Spaces runs as uid 1000; model is cached here between restarts)
ENV HF_HOME=/app/hf-cache
RUN mkdir -p /app/hf-cache && chmod -R 777 /app/hf-cache

EXPOSE 7860
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
