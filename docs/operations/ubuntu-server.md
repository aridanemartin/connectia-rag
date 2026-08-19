# Ubuntu Server Deployment Guide

Deploy the Connectia RAG service on Ubuntu Server 24.04 LTS (Noble Numbat).

---

## Prerequisites

- **Ubuntu Server 24.04 LTS** (fresh install recommended)
- **Docker Engine** 27.x and **Docker Compose** plugin v2.x
- **Git** to clone the repository
- **Port 80** and **443** open in the firewall (for Caddy reverse proxy)
- A domain name pointing to the server's public IP (for automatic TLS)

---

## 1. Install Docker

```bash
# Add Docker's official GPG key
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

# Add the repository
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update

# Install Docker Engine and plugins
sudo apt-get install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin

# Add your user to the docker group (log out and back in after this)
sudo usermod -aG docker $USER
```

Verify the installation:

```bash
docker --version
docker compose version
```

---

## 2. Clone the repository

```bash
git clone https://github.com/aridanemartin/connectia-rag.git
cd connectia-rag
```

---

## 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your values:

```ini
# Required: set a strong, unique token (at least 32 characters)
AUTH_TOKEN=replace-with-a-secret-token-of-at-least-32-characters

# Optional: set the domain for automatic TLS
SITE_ADDRESS=rag.example.com

# Optional: change Ollama models (defaults shown)
# OLLAMA_CHAT_MODEL=gemma3:12b
# OLLAMA_EMBEDDING_MODEL=qwen3-embedding:0.6b
```

> **Security:** Never commit `.env` to version control. The `.gitignore` file
> already excludes it.

---

## 4. Start the stack

```bash
docker compose up -d --build
```

This starts all services:

| Service | Image | Purpose |
|---|---|---|
| `api` | (built from Dockerfile) | RAG API server |
| `ollama` | `ollama/ollama:0.32.5` | LLM inference |
| `model-init` | `ollama/ollama:0.32.5` | One-shot model downloader |
| `qdrant` | `qdrant/qdrant:v1.18.3` | Vector database |
| `caddy` | `caddy:2.11.4-alpine` | Reverse proxy |

Monitor the startup:

```bash
docker compose logs -f api
```

Initial model download can take several minutes. The API will not accept
requests until all dependencies are healthy.

---

## 5. Verify the deployment

```bash
# Liveness check (unauthenticated)
curl http://localhost/health/live

# Readiness check (unauthenticated)
curl http://localhost/health/ready

# Authenticated API check
curl -H "Authorization: Bearer $(grep AUTH_TOKEN .env | cut -d= -f2)" \
  http://localhost/api/v1/questions \
  -d '{"question":"¿Cuál es el horario?"}' -H "Content-Type: application/json"
```

---

## 6. Logs and monitoring

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f api

# Last 100 lines with timestamps
docker compose logs --tail=100 -t api
```

---

## 7. Stop the stack

```bash
# Graceful shutdown (waits for active requests to finish)
docker compose down

# Remove volumes (destroys all data)
docker compose down -v
```

---

## 8. Update the stack

```bash
git pull
docker compose up -d --build --pull always
```

---

## Firewall configuration

```bash
# Allow HTTP and HTTPS
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

---

## Resource requirements

| Component | Minimum | Recommended |
|---|---|---|
| **CPU** | 4 cores | 8 cores |
| **RAM** | 8 GB | 16 GB |
| **Disk** | 20 GB | 50 GB (SSD) |
| **Swap** | 2 GB | 4 GB |

The Ollama model `gemma3:12b` requires approximately 8 GB of RAM at load time.
The embedding model `qwen3-embedding:0.6b` is lightweight (< 1 GB).

---

## Troubleshooting

### Ollama runs out of memory

Edit `compose.yaml` or create a `docker-compose.override.yml`:

```yaml
services:
  ollama:
    environment:
      OLLAMA_NUM_PARALLEL: "1"
      OLLAMA_MAX_LOADED_MODELS: "1"
    deploy:
      resources:
        limits:
          memory: 10G
```

### API container crashes on startup

```bash
docker compose logs api
```

Common causes:
- Missing or invalid `.env` file (especially `AUTH_TOKEN`)
- Port 3000 already in use
- Qdrant or Ollama not yet healthy

### Certificate errors with Caddy

Ensure `SITE_ADDRESS` is set to your domain (not `:80`) and that DNS
records point to the server. Caddy automatically provisions Let's Encrypt
certificates.