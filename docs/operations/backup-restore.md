# Backup and Restore

This guide covers backup and restore procedures for the Connectia RAG service.

---

## Data to protect

| Data | Location | Persistence | Criticality |
|---|---|---|---|
| SQLite database | `api_data` volume → `/data/sqlite/connectia.sqlite` | Application state | High |
| Qdrant vectors | `qdrant_data` volume → `/qdrant/storage` | Vector index | High |
| Ollama models | `ollama_models` volume → `/root/.ollama` | Downloaded models | Medium |
| Environment config | `.env` file | Configuration | High |

---

## Backup strategy

Run **all three** backups below. The SQLite and Qdrant backups together form a
consistent point-in-time snapshot of the application. The `.env` file should be
backed up separately (it is not inside a Docker volume).

### 1. SQLite database backup

SQLite supports safe online backups via the `.backup` command. Run this while
the API container is running:

```bash
# Create a backup directory
mkdir -p ~/backups/connectia

# Backup via the running API container (better-sqlite3 online backup)
docker compose exec api node -e "
  const Database = require('better-sqlite3');
  const db = new Database('/data/sqlite/connectia.sqlite', { readonly: true });
  db.backup('/data/backup.sqlite');
  db.close();
" 2>/dev/null

# Copy the backup out of the container
docker compose cp api:/data/backup.sqlite ~/backups/connectia/connectia-$(date +%Y%m%d-%H%M%S).sqlite

# Clean up the temporary backup inside the container
docker compose exec api rm -f /data/backup.sqlite
```

### 2. Qdrant snapshot

Qdrant provides a snapshot API. Create a snapshot while the stack is running:

```bash
# Create a Qdrant snapshot
curl -X POST 'http://localhost:6333/collections/connectia_documents/snapshots'

# Copy the snapshot from the Qdrant container
SNAPSHOT=$(docker compose exec qdrant \
  ls -t /qdrant/storage/snapshots/connectia_documents/ | head -1)
docker compose cp qdrant:/qdrant/storage/snapshots/connectia_documents/$SNAPSHOT \
  ~/backups/connectia/qdrant-snapshot-$(date +%Y%m%d-%H%M%S).snapshot
```

### 3. Environment configuration

```bash
cp .env ~/backups/connectia/env-$(date +%Y%m%d-%H%M%S).backup
```

---

## Automated backup script

Create a cron job at `/etc/cron.d/connectia-backup`:

```bash
# Daily backup at 02:00
0 2 * * * root /opt/connectia/scripts/backup.sh
```

And the backup script at `/opt/connectia/scripts/backup.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/connectia}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
COMPOSE_DIR="${COMPOSE_DIR:-/opt/connectia}"
DATE=$(date +%Y%m%d-%H%M%S)

mkdir -p "$BACKUP_DIR"

cd "$COMPOSE_DIR"

# SQLite backup
docker compose exec -T api node -e "
  const Database = require('better-sqlite3');
  const db = new Database('/data/sqlite/connectia.sqlite', { readonly: true });
  db.backup('$BACKUP_DIR/connectia-$DATE.sqlite');
  db.close();
" 2>/dev/null

# Qdrant snapshot
curl -sf -X POST 'http://localhost:6333/collections/connectia_documents/snapshots' > /dev/null
SNAPSHOT=$(docker compose exec -T qdrant \
  ls -t /qdrant/storage/snapshots/connectia_documents/ | head -1)
docker compose cp -T qdrant:/qdrant/storage/snapshots/connectia_documents/$SNAPSHOT \
  "$BACKUP_DIR/qdrant-$DATE.snapshot"

# Environment backup
cp .env "$BACKUP_DIR/env-$DATE.backup"

# Prune old backups
find "$BACKUP_DIR" -name "*.sqlite" -mtime +$RETENTION_DAYS -delete
find "$BACKUP_DIR" -name "*.snapshot" -mtime +$RETENTION_DAYS -delete
find "$BACKUP_DIR" -name "*.backup" -mtime +$RETENTION_DAYS -delete

echo "Backup completed: $DATE"
```

Make it executable:

```bash
chmod +x /opt/connectia/scripts/backup.sh
```

---

## Restore procedure

### Full restore

1. **Stop the stack** and remove volumes:

```bash
cd /opt/connectia
docker compose down -v
```

2. **Restore the SQLite database** (create a temporary container):

```bash
docker run --rm -v connectia-rag-demo_api_data:/data \
  -v ~/backups/connectia/connectia-20260816-020000.sqlite:/backup.sqlite \
  alpine sh -c "cp /backup.sqlite /data/sqlite/connectia.sqlite"
```

3. **Restore the Qdrant snapshot**:

```bash
# Copy the snapshot into the Qdrant data directory
docker run --rm -v connectia-rag-demo_qdrant_data:/data \
  -v ~/backups/connectia/qdrant-20260816-020000.snapshot:/tmp/restore.snapshot \
  alpine sh -c "cp /tmp/restore.snapshot /data/storage/snapshots/connectia_documents/"

# Start Qdrant alone to apply the snapshot
docker compose up -d qdrant
sleep 5

# Recover from the snapshot
curl -X PUT 'http://localhost:6333/collections/connectia_documents' \
  -H 'Content-Type: application/json' \
  -d "{
    \"snapshot\": \"/qdrant/storage/snapshots/connectia_documents/restore.snapshot\"
  }"

docker compose down
```

4. **Restore `.env`**:

```bash
cp ~/backups/connectia/env-20260816-020000.backup .env
```

5. **Start the stack**:

```bash
docker compose up -d --build
```

### Point-in-time restore

Repeat the full restore procedure using the backup from the desired timestamp.

---

## Verification

After restoring, verify the service is operational:

```bash
# Check liveness
curl http://localhost/health/live

# Check readiness
curl http://localhost/health/ready

# Send a test question
curl -H "Authorization: Bearer $(grep AUTH_TOKEN .env | cut -d= -f2)" \
  http://localhost/api/v1/questions \
  -d '{"question":"¿Cuál es el horario?"}' \
  -H "Content-Type: application/json"
```

---

## Recovery from data corruption

If the SQLite database is corrupted:

1. Attempt a restore from the most recent backup (see above).
2. If no backup is available, start with an empty database:
   - The application will recreate the schema on first startup via migrations.
   - You will need to re-index all documents.

```bash
docker compose down -v
docker compose up -d --build
```

3. Re-upload the PDF corpus and re-index all documents.

---

## Disaster recovery plan

| Scenario | RPO | RTO | Procedure |
|---|---|---|---|
| Single container crash | 0 | < 30 s | Docker restarts automatically |
| Host reboot | 0 | < 60 s | `docker compose up -d` |
| Data corruption | Previous backup | < 30 min | Restore from backup |
| Full volume loss | Previous backup | < 60 min | Restore from backup + re-index |
| Region loss | N/A | Manual | Deploy fresh + restore from off-site backup |