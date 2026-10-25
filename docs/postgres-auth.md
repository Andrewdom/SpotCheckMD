# Physician authentication and PostgreSQL

This feature replaces anonymous browser ownership with a manually seeded physician account and PostgreSQL-backed shared persistence. It remains a fictional-patient hackathon prototype, not a production identity system or HIPAA-compliant deployment.

## Data model

`db/migrations/001_physician_auth_postgres.sql` creates relational ownership and lifecycle columns while retaining the evolving encounter/model payloads as JSONB:

- `organizations`, `physicians`, and `organization_memberships` define the actor and tenant boundary.
- `physician_sessions` stores SHA-256 session-token digests only. Raw random tokens exist only in Secure, HttpOnly, SameSite=Lax cookies.
- `encounters` stores organization, physician, patient, revision and analysis state relationally plus the versioned aggregate in `document`.
- `media_objects` authorizes opaque private file keys. Image and audio bytes remain under `AURA_DATA_DIR/media/`.
- `transcript_artifacts`, `clinical_findings`, `analysis_jobs`, `ehr_charts`, `ehr_notes`, `approved_notes`, and `audit_events` preserve queryable ownership and lifecycle data alongside exact JSON snapshots.
- `login_attempts` supports a five-failure, 15-minute throttle without storing raw usernames or IP addresses.

All encounter mutations retain the existing revision check. PostgreSQL transactions take a database advisory lock around the current aggregate compatibility layer so two devices cannot silently overwrite each other. This is intentionally optimized for one web container and the single MedGemma inference slot.

## Local development

Create an ignored local environment file containing a strong PostgreSQL password, then run:

```sh
POSTGRES_PASSWORD='<local secret>' docker compose -f compose.dev.yaml up -d postgres
DATABASE_URL='postgresql://spotcheckmd:<local secret>@127.0.0.1:55432/spotcheckmd' npm run db:migrate
DATABASE_URL='postgresql://spotcheckmd:<local secret>@127.0.0.1:55432/spotcheckmd' npm run db:seed
```

Set the same `DATABASE_URL` plus a random `AUTH_RATE_LIMIT_SECRET` in `.env.local`, then run `npm run dev`. There is no self-registration route.

`AUTH_RATE_LIMIT_SECRET` keys the HMAC fingerprints stored in `login_attempts`, so raw usernames and client addresses are never persisted. Generate it with `openssl rand -hex 32`. Without it the app falls back to a fixed development value; `deploy/unraid/web-run.sh` refuses to start without one. Sign-in is throttled after 5 failures per account and client within 15 minutes, and after 20 failures per account from any client, because forwarded IP headers can be spoofed when no proxy overwrites them.

## Unraid preparation

Do not run these commands until the pull request, legacy backup, and import assignment have been reviewed.

```sh
cd /mnt/user/appdata/spotcheckmd-web/repository
deploy/unraid/postgres-init-config.sh
deploy/unraid/postgres-run.sh
deploy/unraid/postgres-migrate.sh
```

The database is published only to `127.0.0.1:5433`; it has no LAN listener or Cloudflare route. Credentials live in mode-0600 files under `/mnt/user/appdata/spotcheckmd-postgres/config/` and `/mnt/user/appdata/spotcheckmd-web/config/`.

Run `npm run db:seed` from a trusted interactive server shell with `DATABASE_URL` loaded from the private web environment. Do not place the password in shell history or command arguments.

## Legacy import

The importer defaults to validation only. It verifies every referenced media file, reports counts, ignores all anonymous sessions, and requires the selected seeded physician ID.

```sh
npm run db:import-legacy -- --source /mnt/user/appdata/spotcheckmd-web/data --physician <seeded-physician-id>
```

After reviewing the counts and taking an external appdata backup, repeat with `--apply`. The importer refuses a non-empty target, copies the legacy JSON into a timestamped `legacy-backups` directory, assigns encounters and Demo EHR charts to the selected physician, and copies media into the private `media/` directory. It never converts anonymous sessions.

## Backup and restore

Create a database backup and separately back up the media tree:

```sh
deploy/unraid/postgres-backup.sh
tar -C /mnt/user/appdata/spotcheckmd-web -czf /mnt/user/appdata/spotcheckmd-postgres/backups/spotcheckmd-media-$(date -u +%Y%m%dT%H%M%SZ).tgz data/media
```

To restore, stop the web container, preserve the current database and media directories, and run `SPOTCHECK_RESTORE_CONFIRMED=yes deploy/unraid/postgres-restore.sh <dump>`. Restore the matching media archive before starting the web container. Validate table counts, media references, login, one encounter read, and `/api/health` before changing the Cloudflare route or deleting the prior data.

## Rollback

Keep the pre-migration web image, `/mnt/user/appdata/spotcheckmd-web/data/db.json`, legacy media files, and database dump. A rollback stops the new web container, restores its prior private environment file and image, and leaves PostgreSQL stopped. Never point the old JSON build at partially moved media or delete either persistence set during validation.
