FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      libsndfile1 ffmpeg && rm -rf /var/lib/apt/lists/*

# CPU-only torch AND torchaudio from the SAME index -> matching ABI (mismatched torchaudio was the earlier crash).
RUN pip install --no-cache-dir torch torchaudio --index-url https://download.pytorch.org/whl/cpu

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .

# Writable caches (HF Spaces runs as uid 1000). HF for SeamlessM4T, ModelScope for Dolphin/funasr; persist between restarts.
ENV HF_HOME=/app/hf-cache
ENV MODELSCOPE_CACHE=/app/ms-cache
RUN mkdir -p /app/hf-cache /app/ms-cache && chmod -R 777 /app/hf-cache /app/ms-cache

EXPOSE 7860
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
