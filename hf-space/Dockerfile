FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      libsndfile1 ffmpeg build-essential cmake git && rm -rf /var/lib/apt/lists/*

# Build kenlm CLI tools (lmplz, build_binary) from source — pip only installs the Python bindings.
RUN git clone --depth 1 https://github.com/kpu/kenlm.git /tmp/kenlm && \
    cd /tmp/kenlm && mkdir build && cd build && \
    cmake .. -DCMAKE_BUILD_TYPE=Release && make -j$(nproc) && \
    cp bin/lmplz bin/build_binary /usr/local/bin/ && \
    rm -rf /tmp/kenlm

# CPU-only torch AND torchaudio from the SAME index -> matching ABI (mismatched torchaudio was the earlier crash).
RUN pip install --no-cache-dir torch torchaudio --index-url https://download.pytorch.org/whl/cpu

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Writable caches (HF Spaces runs as uid 1000). HF for SeamlessM4T, ModelScope for Dolphin/funasr.
ENV HF_HOME=/app/hf-cache
ENV MODELSCOPE_CACHE=/app/ms-cache
RUN mkdir -p /app/hf-cache /app/ms-cache && chmod -R 777 /app/hf-cache /app/ms-cache

# Bake the Dolphin-small model into the image at BUILD time -> no ~1.4GB download at startup; the model loads
# from local disk, so the container comes up fast. (Does not change per-inference speed — that's the CPU limit.)
RUN python -c "import dolphin; dolphin.load_model('small', device='cpu')" || true

COPY app.py care_phrases.json care_vocab.json burmese_lm_corpus.txt build_lm.py ./

# Build the kenlm ARPA model from the Burmese corpus (character-level 5-gram).
# lmplz was built from source above. If it fails, the app falls back to the pure-Python LM.
RUN python build_lm.py || true

EXPOSE 7860
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
