-- Separate, testnet-only original checkpoint. No wallet keys, signing, sending,
-- deployment authorization or receipt verification. Only public bindings and
-- original hashes belong here. Scope provisioning is intentionally NOT exposed
-- to the service role: an owner-authenticated browser enrollment flow must be
-- implemented and reviewed before any real scope is created. Database owners
-- and restored backups can still rewrite/roll back data; this is not a ledger.
BEGIN;
CREATE SCHEMA bouncer_v14_originals_v1;
REVOKE ALL ON SCHEMA bouncer_v14_originals_v1 FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE bouncer_v14_originals_v1.streams (
  scope_id text PRIMARY KEY CHECK (scope_id ~ '^[0-9a-f]{32}$'),
  owner_id text NOT NULL CHECK (owner_id ~ '^[a-z0-9][a-z0-9._-]*[a-z0-9]\.testnet$' AND length(owner_id) <= 64),
  vault_id text NOT NULL CHECK (vault_id ~ '^[a-z0-9][a-z0-9._-]*[a-z0-9]\.testnet$' AND length(vault_id) <= 64),
  capability_hash text NOT NULL CHECK (capability_hash ~ '^[0-9a-f]{64}$'),
  revision integer NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 32),
  head_sha256 text NOT NULL DEFAULT repeat('0',64) CHECK (head_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(owner_id,vault_id),
  CHECK (vault_id LIKE '%.' || owner_id AND
         split_part(vault_id,'.',1) || '.' || owner_id = vault_id),
  CHECK (revision <> 0 OR head_sha256 = repeat('0',64))
);
CREATE TABLE bouncer_v14_originals_v1.events (
  scope_id text NOT NULL REFERENCES bouncer_v14_originals_v1.streams(scope_id),
  seq integer NOT NULL CHECK (seq BETWEEN 1 AND 32),
  record text NOT NULL CHECK (octet_length(record) BETWEEN 2 AND 24576 AND position(E'\n' IN record)=0 AND position(E'\r' IN record)=0),
  record_sha256 text NOT NULL CHECK (record_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scope_id,seq)
);
ALTER TABLE bouncer_v14_originals_v1.streams ENABLE ROW LEVEL SECURITY;
ALTER TABLE bouncer_v14_originals_v1.events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA bouncer_v14_originals_v1 FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION bouncer_v14_originals_v1.no_event_changes() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'original event is append-only'; END;
$$;
CREATE TRIGGER no_event_changes BEFORE UPDATE OR DELETE ON bouncer_v14_originals_v1.events
FOR EACH ROW EXECUTE FUNCTION bouncer_v14_originals_v1.no_event_changes();
CREATE TRIGGER no_stream_delete BEFORE DELETE ON bouncer_v14_originals_v1.streams
FOR EACH ROW EXECUTE FUNCTION bouncer_v14_originals_v1.no_event_changes();
CREATE TRIGGER no_event_truncate BEFORE TRUNCATE ON bouncer_v14_originals_v1.events
FOR EACH STATEMENT EXECUTE FUNCTION bouncer_v14_originals_v1.no_event_changes();
CREATE TRIGGER no_stream_truncate BEFORE TRUNCATE ON bouncer_v14_originals_v1.streams
FOR EACH STATEMENT EXECUTE FUNCTION bouncer_v14_originals_v1.no_event_changes();

CREATE FUNCTION bouncer_v14_originals_v1.guard_stream_update() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.scope_id<>OLD.scope_id OR NEW.owner_id<>OLD.owner_id OR NEW.vault_id<>OLD.vault_id OR
     NEW.capability_hash<>OLD.capability_hash OR NEW.created_at<>OLD.created_at OR
     NEW.revision<>OLD.revision+1 OR NEW.head_sha256=OLD.head_sha256 THEN
    RAISE EXCEPTION 'original stream cannot be reset or rewritten';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_stream_update BEFORE UPDATE ON bouncer_v14_originals_v1.streams
FOR EACH ROW EXECUTE FUNCTION bouncer_v14_originals_v1.guard_stream_update();

-- Atomic compare-and-append, serialized by the stream row. The edge runtime
-- supplies only a SHA-256 of the random capability. The actual secret is never
-- retained in this database. No reset, delete, update-history or provisioning
-- operation is exposed here. A lost response must be reconciled by a read.
CREATE FUNCTION public.bouncer_v14_original_checkpoint_v1(
  p_scope_id text, p_capability_hash text, p_operation text,
  p_expected_revision integer DEFAULT NULL, p_expected_head_sha256 text DEFAULT NULL, p_record text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  item bouncer_v14_originals_v1.streams%ROWTYPE;
  document jsonb;
  records jsonb;
  new_head text;
BEGIN
  IF p_scope_id IS NULL OR p_scope_id !~ '^[0-9a-f]{32}$' OR
     p_capability_hash IS NULL OR p_capability_hash !~ '^[0-9a-f]{64}$' OR
     p_operation IS NULL OR p_operation NOT IN ('read','append') THEN
    RETURN jsonb_build_object('error','unavailable');
  END IF;
  IF p_operation='read' THEN
    IF p_expected_revision IS NOT NULL OR p_expected_head_sha256 IS NOT NULL OR p_record IS NOT NULL THEN
      RETURN jsonb_build_object('error','unavailable');
    END IF;
    SELECT * INTO item FROM bouncer_v14_originals_v1.streams
      WHERE scope_id=p_scope_id AND capability_hash=p_capability_hash FOR SHARE;
  ELSE
    IF p_expected_revision IS NULL OR p_expected_revision<0 OR p_expected_revision>=32 OR
       p_expected_head_sha256 IS NULL OR p_expected_head_sha256 !~ '^[0-9a-f]{64}$' OR
       p_record IS NULL OR octet_length(p_record)<2 OR octet_length(p_record)>24576 OR
       position(E'\n' IN p_record)<>0 OR position(E'\r' IN p_record)<>0 THEN
      RETURN jsonb_build_object('error','unavailable');
    END IF;
    SELECT * INTO item FROM bouncer_v14_originals_v1.streams
      WHERE scope_id=p_scope_id AND capability_hash=p_capability_hash FOR UPDATE;
  END IF;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','unavailable'); END IF;

  IF p_operation='append' THEN
    IF item.revision<>p_expected_revision OR item.head_sha256<>p_expected_head_sha256 THEN
      RETURN jsonb_build_object('error','unavailable');
    END IF;
    BEGIN document:=p_record::jsonb; EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('error','unavailable'); END;
    IF jsonb_typeof(document) IS DISTINCT FROM 'object' OR
       document->>'format' IS DISTINCT FROM 'bouncer-v14-original-event-v1' OR
       document->'seq' IS DISTINCT FROM to_jsonb(item.revision+1) OR
       document->>'previous_sha256' IS DISTINCT FROM item.head_sha256 OR
       jsonb_typeof(document->'data') IS DISTINCT FROM 'object' OR document->>'type' IS NULL OR
       (SELECT count(*) FROM jsonb_object_keys(document))<>5 OR
       (item.revision=0 AND (document->>'type' IS DISTINCT FROM 'reserve' OR
          document->'data'->>'scope_id' IS DISTINCT FROM item.scope_id OR
          document->'data'->>'owner' IS DISTINCT FROM item.owner_id OR
          document->'data'->>'vault' IS DISTINCT FROM item.vault_id)) OR
       (item.revision>0 AND document->>'type' NOT IN ('wallet_claim','wallet_original','wallet_verified','mission_original','mission_verified')) THEN
      RETURN jsonb_build_object('error','unavailable');
    END IF;
    new_head:=encode(sha256(convert_to(p_record,'UTF8')),'hex');
    INSERT INTO bouncer_v14_originals_v1.events(scope_id,seq,record,record_sha256)
      VALUES(item.scope_id,item.revision+1,p_record,new_head);
    UPDATE bouncer_v14_originals_v1.streams SET revision=item.revision+1,head_sha256=new_head
      WHERE scope_id=item.scope_id RETURNING * INTO item;
  END IF;
  SELECT COALESCE(jsonb_agg(record ORDER BY seq),'[]'::jsonb) INTO records
    FROM bouncer_v14_originals_v1.events WHERE scope_id=item.scope_id;
  RETURN jsonb_build_object('revision',item.revision,'head_sha256',item.head_sha256,'events',records);
END;
$$;
REVOKE ALL ON FUNCTION public.bouncer_v14_original_checkpoint_v1(text,text,text,integer,text,text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bouncer_v14_original_checkpoint_v1(text,text,text,integer,text,text) TO service_role;
COMMIT;
