-- One row per recording. The audio and the ASR response live in MinIO (audio_key, result_key);
-- this table holds the status and the numbers the list shows. Applied on startup (idempotent).
CREATE TABLE IF NOT EXISTS recordings (
    id                text PRIMARY KEY,
    name              text        NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    status            text        NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued', 'processing', 'done', 'failed')),
    note              text,                      -- live progress text while processing
    error             text,                      -- reason when failed
    ext               text        NOT NULL,
    audio_key         text        NOT NULL,      -- <id>/audio.<ext>
    result_key        text,                      -- <id>/result.json once done
    num_speakers_hint int,
    duration_s        real,
    processing_s      real,
    rtf               real,                      -- x real time: audio seconds per wall second
    speakers          int,
    words             int,
    stt_model         text,
    diar_model        text,
    speaker_names     jsonb       NOT NULL DEFAULT '{}',
    speaker_stats     jsonb                      -- [{speaker, seconds, share}] in order of first appearance
);
-- columns added after the first release (CREATE TABLE IF NOT EXISTS leaves an existing table alone)
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS speaker_stats jsonb;
CREATE INDEX IF NOT EXISTS recordings_created_at ON recordings (created_at DESC);
