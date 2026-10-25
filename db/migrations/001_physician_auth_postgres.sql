BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organizations (
  id text PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS physicians (
  id text PRIMARY KEY,
  username text NOT NULL,
  username_normalized text NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organization_memberships (
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  physician_id text NOT NULL REFERENCES physicians(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('physician', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, physician_id)
);

CREATE TABLE IF NOT EXISTS physician_sessions (
  token_hash char(64) PRIMARY KEY,
  physician_id text NOT NULL REFERENCES physicians(id) ON DELETE CASCADE,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  ip_hash char(64),
  user_agent_hash char(64)
);
CREATE INDEX IF NOT EXISTS physician_sessions_active_idx ON physician_sessions (physician_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS login_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  throttle_key char(64) NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  success boolean NOT NULL
);
CREATE INDEX IF NOT EXISTS login_attempts_recent_idx ON login_attempts (throttle_key, attempted_at DESC);

CREATE TABLE IF NOT EXISTS encounters (
  id char(32) PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id),
  physician_id text NOT NULL REFERENCES physicians(id),
  patient_id text NOT NULL,
  revision integer NOT NULL CHECK (revision >= 0),
  analysis_status text NOT NULL CHECK (analysis_status IN ('none', 'running', 'ready', 'failed')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  document jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS encounters_physician_idx ON encounters (physician_id, created_at DESC);

CREATE TABLE IF NOT EXISTS media_objects (
  file_key char(32) PRIMARY KEY,
  source_id char(32) NOT NULL,
  encounter_id char(32) NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
  organization_id text NOT NULL REFERENCES organizations(id),
  physician_id text NOT NULL REFERENCES physicians(id),
  kind text NOT NULL CHECK (kind IN ('image', 'audio', 'preview')),
  mime text NOT NULL,
  byte_size bigint,
  created_at timestamptz NOT NULL,
  UNIQUE (encounter_id, source_id, kind)
);
CREATE INDEX IF NOT EXISTS media_objects_owner_idx ON media_objects (physician_id, encounter_id);

CREATE TABLE IF NOT EXISTS transcript_artifacts (
  id text PRIMARY KEY,
  encounter_id char(32) NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
  physician_id text NOT NULL REFERENCES physicians(id),
  source_id char(32),
  provider text NOT NULL,
  model text NOT NULL,
  digest text NOT NULL,
  artifact jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS clinical_findings (
  id char(32) PRIMARY KEY,
  encounter_id char(32) NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
  physician_id text NOT NULL REFERENCES physicians(id),
  section char(1) NOT NULL CHECK (section IN ('S','O','A','P')),
  review_status text NOT NULL CHECK (review_status IN ('pending','accepted','rejected')),
  finding jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS analysis_jobs (
  run_id char(32) PRIMARY KEY,
  encounter_id char(32) NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
  organization_id text NOT NULL REFERENCES organizations(id),
  physician_id text NOT NULL REFERENCES physicians(id),
  encounter_revision integer NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  queued_at timestamptz NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  expires_at timestamptz NOT NULL,
  snapshot jsonb NOT NULL,
  error_code text
);
CREATE INDEX IF NOT EXISTS analysis_jobs_queue_idx ON analysis_jobs (status, queued_at);

CREATE TABLE IF NOT EXISTS ehr_charts (
  organization_id text NOT NULL REFERENCES organizations(id),
  physician_id text NOT NULL REFERENCES physicians(id),
  patient_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  document jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (physician_id, patient_id)
);

CREATE TABLE IF NOT EXISTS ehr_notes (
  id char(32) PRIMARY KEY,
  encounter_id char(32) NOT NULL,
  physician_id text NOT NULL REFERENCES physicians(id),
  patient_id text NOT NULL,
  revision integer NOT NULL,
  digest char(64) NOT NULL,
  note jsonb NOT NULL,
  saved_at timestamptz NOT NULL,
  UNIQUE (encounter_id, revision, digest)
);

CREATE TABLE IF NOT EXISTS approved_notes (
  encounter_id char(32) NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
  physician_id text NOT NULL REFERENCES physicians(id),
  revision integer NOT NULL,
  digest char(64) NOT NULL,
  snapshot jsonb NOT NULL,
  approved_at timestamptz NOT NULL,
  PRIMARY KEY (encounter_id, revision)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  encounter_id char(32) NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
  physician_id text NOT NULL REFERENCES physicians(id),
  event_index integer NOT NULL,
  occurred_at timestamptz NOT NULL,
  action text NOT NULL,
  revision integer NOT NULL,
  event jsonb NOT NULL,
  UNIQUE (encounter_id, event_index)
);

INSERT INTO schema_migrations(version) VALUES ('001_physician_auth_postgres') ON CONFLICT DO NOTHING;
COMMIT;
