# Sidecar JA3 (curl_cffi / impersonate Chrome) pour défaire le fingerprinting
# TLS de vidzy.cc. Voir ja3/server.py pour le pourquoi.
FROM python:3.12-slim

WORKDIR /app
RUN pip install --no-cache-dir "curl_cffi==0.17.0"
COPY server.py /app/server.py

# Réseau Docker interne uniquement (aucun port publié côté compose).
EXPOSE 8899
CMD ["python", "-I", "server.py"]
