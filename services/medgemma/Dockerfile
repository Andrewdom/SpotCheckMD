# Build from repository root: docker build -f services/medgemma/Dockerfile -t spotcheckmd-medgemma .
FROM python:3.11-slim
WORKDIR /app
COPY services/medgemma/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt && useradd --create-home --uid 10001 inference
COPY contracts /app/contracts
COPY services/medgemma/service.py /app/services/medgemma/service.py
ENV HF_HOME=/home/inference/.cache/huggingface
USER inference
EXPOSE 8000
CMD ["uvicorn", "services.medgemma.service:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--no-access-log"]
