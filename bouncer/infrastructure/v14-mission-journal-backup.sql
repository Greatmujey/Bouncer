-- RESEARCH ONLY. Requires the V14 original checkpoint and owner enrollment
-- migrations. Stores only an encrypted FileJournal envelope, bound to the
-- current original-stream head and reviewed goal. It neither verifies AES-GCM
-- nor authorizes a wallet/transaction. The application must authenticate the
-- ciphertext, check the complete event chain, verify receipts and stop on any
-- uncertain response. A database owner or restored database can roll back both
-- streams and backups; this is not an independent freshness oracle.
BEGIN;
CREATE TABLE bouncer_v14_originals_v1.mission_journal_backups (
  scope_id text NOT NULL REFERENCES bouncer_v14_originals_v1.streams(scope_id),
  goal_id text NOT NULL CHECK (goal_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  phase text NOT NULL CHECK (phase IN ('pending','completed')),
  witness_revision integer NOT NULL CHECK (witness_revision BETWEEN 1 AND 31),
  witness_head_sha256 text NOT NULL CHECK (witness_head_sha256 ~ '^[0-9a-f]{64}$'),
  ciphertext_sha256 text NOT NULL CHECK (ciphertext_sha256 ~ '^[0-9a-f]{64}$'),
  record text NOT NULL CHECK (octet_length(record) BETWEEN 2 AND 270000 AND position(E'\n' IN record)=0 AND position(E'\r' IN record)=0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scope_id,goal_id,phase),
  UNIQUE(scope_id,witness_revision)
);
ALTER TABLE bouncer_v14_originals_v1.mission_journal_backups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON bouncer_v14_originals_v1.mission_journal_backups FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER no_mission_backup_changes BEFORE UPDATE OR DELETE ON bouncer_v14_originals_v1.mission_journal_backups
FOR EACH ROW EXECUTE FUNCTION bouncer_v14_originals_v1.no_event_changes();
CREATE TRIGGER no_mission_backup_truncate BEFORE TRUNCATE ON bouncer_v14_originals_v1.mission_journal_backups
FOR EACH STATEMENT EXECUTE FUNCTION bouncer_v14_originals_v1.no_event_changes();

-- The Edge layer hashes the capability before this call. An append takes the
-- same row lock as the witness stream and must match its exact current head.
-- Lost acknowledgements are reconciled by read; no overwrite/reset is exposed.
CREATE FUNCTION public.bouncer_v14_mission_journal_backup_v1(
  p_scope_id text,p_capability_hash text,p_operation text,p_goal_id text,p_phase text,
  p_expected_revision integer DEFAULT NULL,p_expected_head_sha256 text DEFAULT NULL,p_record text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  item bouncer_v14_originals_v1.streams%ROWTYPE;
  saved bouncer_v14_originals_v1.mission_journal_backups%ROWTYPE;
  document jsonb; envelope jsonb; binding jsonb; last_event jsonb; selected_goal jsonb;
  setup_count integer; originals integer; verified integer;
BEGIN
  IF p_scope_id IS NULL OR p_scope_id !~ '^[0-9a-f]{32}$' OR
     p_capability_hash IS NULL OR p_capability_hash !~ '^[0-9a-f]{64}$' OR
     p_operation IS NULL OR p_operation NOT IN ('read','append') OR
     p_goal_id IS NULL OR p_goal_id !~ '^[A-Za-z0-9_-]{1,64}$' OR
     p_phase IS NULL OR p_phase NOT IN ('pending','completed') THEN
    RETURN jsonb_build_object('error','unavailable');
  END IF;
  IF p_operation='read' THEN
    IF p_expected_revision IS NOT NULL OR p_expected_head_sha256 IS NOT NULL OR p_record IS NOT NULL THEN
      RETURN jsonb_build_object('error','unavailable');
    END IF;
    SELECT * INTO item FROM bouncer_v14_originals_v1.streams
      WHERE scope_id=p_scope_id AND capability_hash=p_capability_hash FOR SHARE;
  ELSE
    IF p_expected_revision IS NULL OR p_expected_revision<19 OR p_expected_revision>31 OR
       p_expected_head_sha256 IS NULL OR p_expected_head_sha256 !~ '^[0-9a-f]{64}$' OR
       p_record IS NULL OR octet_length(p_record)<2 OR octet_length(p_record)>270000 OR
       position(E'\n' IN p_record)<>0 OR position(E'\r' IN p_record)<>0 THEN
      RETURN jsonb_build_object('error','unavailable');
    END IF;
    SELECT * INTO item FROM bouncer_v14_originals_v1.streams
      WHERE scope_id=p_scope_id AND capability_hash=p_capability_hash FOR UPDATE;
  END IF;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','unavailable'); END IF;
  IF p_operation='read' THEN
    SELECT * INTO saved FROM bouncer_v14_originals_v1.mission_journal_backups
      WHERE scope_id=item.scope_id AND goal_id=p_goal_id AND phase=p_phase;
    IF NOT FOUND THEN RETURN jsonb_build_object('status','MISSING'); END IF;
    RETURN jsonb_build_object('status','EXISTING_BACKUP','record',saved.record::jsonb);
  END IF;
  IF item.revision<>p_expected_revision OR item.head_sha256<>p_expected_head_sha256 THEN
    RETURN jsonb_build_object('error','unavailable');
  END IF;
  BEGIN document:=p_record::jsonb; envelope:=(document->>'ciphertext')::jsonb;
  EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('error','unavailable'); END;
  IF jsonb_typeof(document) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(document))<>15 OR
     document->>'format' IS DISTINCT FROM 'bouncer-v14-mission-journal-backup-v1' OR
     document->>'scope_id' IS DISTINCT FROM item.scope_id OR document->>'owner' IS DISTINCT FROM item.owner_id OR
     document->>'vault' IS DISTINCT FROM item.vault_id OR document->>'review_sha256' IS DISTINCT FROM item.review_sha256 OR
     COALESCE(document->>'mission_sha256','') !~ '^[0-9a-f]{64}$' OR
     document->'witness_revision' IS DISTINCT FROM to_jsonb(item.revision) OR
     document->>'witness_head_sha256' IS DISTINCT FROM item.head_sha256 OR
     document->>'goal_id' IS DISTINCT FROM p_goal_id OR document->>'phase' IS DISTINCT FROM p_phase OR
     COALESCE(document->>'kind','') NOT IN ('random','market','oracle','storage') OR
     COALESCE(document->>'tx_hash','') !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' OR
     COALESCE(document->>'fingerprint','') !~ '^[0-9a-f]{64}$' OR COALESCE(document->>'ciphertext_sha256','') !~ '^[0-9a-f]{64}$' OR
     jsonb_typeof(document->'ciphertext') IS DISTINCT FROM 'string' OR
     octet_length(document->>'ciphertext')>256000 OR
     encode(sha256(convert_to(document->>'ciphertext','UTF8')),'hex') IS DISTINCT FROM document->>'ciphertext_sha256' OR
     jsonb_typeof(envelope) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(envelope))<>5 OR
     envelope->>'format' IS DISTINCT FROM 'bouncer-encrypted-file-journal-v1' OR
     envelope->>'cipher' IS DISTINCT FROM 'aes-256-gcm' OR
     COALESCE(envelope->>'nonce','') !~ '^[A-Za-z0-9+/]{16}$' OR COALESCE(envelope->>'tag','') !~ '^[A-Za-z0-9+/]{22}==$' OR
     COALESCE(envelope->>'ciphertext','') !~ '^[A-Za-z0-9+/]+={0,2}$' THEN
    RETURN jsonb_build_object('error','unavailable');
  END IF;
  SELECT (record::jsonb)->'data' INTO binding FROM bouncer_v14_originals_v1.events WHERE scope_id=item.scope_id AND seq=1;
  SELECT record::jsonb INTO last_event FROM bouncer_v14_originals_v1.events WHERE scope_id=item.scope_id AND seq=item.revision;
  SELECT count(*) FILTER (WHERE record::jsonb->>'type'='wallet_verified'),
         count(*) FILTER (WHERE record::jsonb->>'type'='mission_original'),
         count(*) FILTER (WHERE record::jsonb->>'type'='mission_verified')
    INTO setup_count,originals,verified FROM bouncer_v14_originals_v1.events WHERE scope_id=item.scope_id;
  IF jsonb_typeof(binding->'goals') IS DISTINCT FROM 'array' OR jsonb_array_length(binding->'goals')<>3 OR
     binding->>'mission_sha256' IS DISTINCT FROM document->>'mission_sha256' OR
     setup_count<>6 OR verified<0 OR verified>=3 THEN RETURN jsonb_build_object('error','unavailable'); END IF;
  selected_goal:=(binding->'goals')->verified;
  IF selected_goal->>'id' IS DISTINCT FROM p_goal_id OR selected_goal->>'kind' IS DISTINCT FROM document->>'kind' THEN
    RETURN jsonb_build_object('error','unavailable');
  END IF;
  IF (p_phase='pending' AND (originals<>verified OR COALESCE(last_event->>'type','') NOT IN ('wallet_verified','mission_verified'))) OR
     (p_phase='completed' AND (originals<>verified+1 OR last_event->>'type' IS DISTINCT FROM 'mission_original' OR
       last_event->'data'->>'goal_id' IS DISTINCT FROM p_goal_id OR last_event->'data'->>'kind' IS DISTINCT FROM document->>'kind' OR
       last_event->'data'->>'tx_hash' IS DISTINCT FROM document->>'tx_hash' OR
       last_event->'data'->>'fingerprint' IS DISTINCT FROM document->>'fingerprint')) THEN
    RETURN jsonb_build_object('error','unavailable');
  END IF;
  INSERT INTO bouncer_v14_originals_v1.mission_journal_backups(scope_id,goal_id,phase,witness_revision,witness_head_sha256,ciphertext_sha256,record)
    VALUES(item.scope_id,p_goal_id,p_phase,item.revision,item.head_sha256,document->>'ciphertext_sha256',p_record)
    ON CONFLICT DO NOTHING RETURNING * INTO saved;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','unavailable'); END IF;
  RETURN jsonb_build_object('status','EXISTING_BACKUP','record',saved.record::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION public.bouncer_v14_mission_journal_backup_v1(text,text,text,text,text,integer,text,text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.bouncer_v14_mission_journal_backup_v1(text,text,text,text,text,integer,text,text) TO service_role;
COMMIT;
