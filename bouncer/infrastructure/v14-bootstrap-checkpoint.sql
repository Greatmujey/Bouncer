-- Temporary-key bootstrap checkpoint, separate from the existing V14 and
-- direct-test journals. Stores public review/attestation/originals and an
-- encrypted key kit only. It cannot sign, broadcast, or authorize a wallet.
-- The Edge caller MUST check a fresh owner NEP-413 signature on enrollment and
-- recovery; PostgreSQL cannot check it. A database owner, restored snapshot,
-- or compromised backend can still rewrite/roll back every row. Clients must
-- compare an independently retained latest head and never treat an empty or
-- older history as proof that no wallet prompt or transaction occurred.
BEGIN;
CREATE SCHEMA bouncer_v14_bootstrap_v1;
REVOKE ALL ON SCHEMA bouncer_v14_bootstrap_v1 FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE bouncer_v14_bootstrap_v1.streams (
  scope_id text PRIMARY KEY CHECK (scope_id ~ '^[0-9a-f]{32}$'),
  capability_hash text NOT NULL CHECK (capability_hash ~ '^[0-9a-f]{64}$'),
  owner_id text NOT NULL CHECK (owner_id ~ '^[a-z0-9][a-z0-9._-]*[a-z0-9][.]testnet$' AND length(owner_id)<=64),
  vault_id text NOT NULL CHECK (vault_id ~ '^[a-z0-9][a-z0-9._-]*[a-z0-9][.]testnet$' AND length(vault_id)<=64),
  owner_public_key text NOT NULL CHECK (owner_public_key ~ '^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  temporary_public_key text NOT NULL CHECK (temporary_public_key ~ '^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  review_sha256 text NOT NULL CHECK (review_sha256 ~ '^[0-9a-f]{64}$'),
  review_text text NOT NULL CHECK (octet_length(review_text) BETWEEN 2 AND 24000 AND position(E'\n' IN review_text)=0 AND position(E'\r' IN review_text)=0),
  kit_sha256 text NOT NULL CHECK (kit_sha256 ~ '^[0-9a-f]{64}$'),
  sealed_kit text NOT NULL CHECK (octet_length(sealed_kit) BETWEEN 2 AND 16000 AND position(E'\n' IN sealed_kit)=0 AND position(E'\r' IN sealed_kit)=0),
  attestation_sha256 text NOT NULL CHECK (attestation_sha256 ~ '^[0-9a-f]{64}$'),
  owner_attestation text NOT NULL CHECK (octet_length(owner_attestation) BETWEEN 2 AND 8192 AND position(E'\n' IN owner_attestation)=0 AND position(E'\r' IN owner_attestation)=0),
  revision integer NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 4),
  head_sha256 text NOT NULL DEFAULT repeat('0',64) CHECK (head_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(owner_id,vault_id),
  CHECK (vault_id LIKE '%.' || owner_id AND split_part(vault_id,'.',1) || '.' || owner_id=vault_id),
  CHECK (owner_public_key<>temporary_public_key),
  CHECK (revision<>0 OR head_sha256=repeat('0',64))
);
CREATE TABLE bouncer_v14_bootstrap_v1.events (
  scope_id text NOT NULL REFERENCES bouncer_v14_bootstrap_v1.streams(scope_id),
  seq integer NOT NULL CHECK (seq BETWEEN 1 AND 4),
  record text NOT NULL CHECK (octet_length(record) BETWEEN 2 AND 4096 AND position(E'\n' IN record)=0 AND position(E'\r' IN record)=0),
  record_sha256 text NOT NULL CHECK (record_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scope_id,seq)
);
ALTER TABLE bouncer_v14_bootstrap_v1.streams ENABLE ROW LEVEL SECURITY;
ALTER TABLE bouncer_v14_bootstrap_v1.events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA bouncer_v14_bootstrap_v1 FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION bouncer_v14_bootstrap_v1.immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'bootstrap original is immutable'; END; $$;
CREATE TRIGGER no_event_changes BEFORE UPDATE OR DELETE ON bouncer_v14_bootstrap_v1.events FOR EACH ROW EXECUTE FUNCTION bouncer_v14_bootstrap_v1.immutable();
CREATE TRIGGER no_event_truncate BEFORE TRUNCATE ON bouncer_v14_bootstrap_v1.events FOR EACH STATEMENT EXECUTE FUNCTION bouncer_v14_bootstrap_v1.immutable();
CREATE TRIGGER no_stream_delete BEFORE DELETE ON bouncer_v14_bootstrap_v1.streams FOR EACH ROW EXECUTE FUNCTION bouncer_v14_bootstrap_v1.immutable();
CREATE TRIGGER no_stream_truncate BEFORE TRUNCATE ON bouncer_v14_bootstrap_v1.streams FOR EACH STATEMENT EXECUTE FUNCTION bouncer_v14_bootstrap_v1.immutable();
CREATE FUNCTION bouncer_v14_bootstrap_v1.guard_stream() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.scope_id<>OLD.scope_id OR NEW.capability_hash<>OLD.capability_hash OR NEW.owner_id<>OLD.owner_id OR
     NEW.vault_id<>OLD.vault_id OR NEW.owner_public_key<>OLD.owner_public_key OR NEW.temporary_public_key<>OLD.temporary_public_key OR
     NEW.review_sha256<>OLD.review_sha256 OR NEW.review_text<>OLD.review_text OR NEW.kit_sha256<>OLD.kit_sha256 OR
     NEW.sealed_kit<>OLD.sealed_kit OR NEW.attestation_sha256<>OLD.attestation_sha256 OR NEW.owner_attestation<>OLD.owner_attestation OR
     NEW.created_at<>OLD.created_at OR NEW.revision<>OLD.revision+1 OR NEW.head_sha256=OLD.head_sha256 THEN
    RAISE EXCEPTION 'bootstrap stream cannot be rewritten';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER guard_stream BEFORE UPDATE ON bouncer_v14_bootstrap_v1.streams FOR EACH ROW EXECUTE FUNCTION bouncer_v14_bootstrap_v1.guard_stream();

-- Only the Edge verifier may call this function. Exact replay reads the same
-- immutable enrollment; another scope, review or kit never replaces it.
CREATE FUNCTION public.bouncer_v14_bootstrap_enroll_v1(
  p_scope_id text,p_capability_hash text,p_owner_id text,p_vault_id text,p_owner_public_key text,p_temporary_public_key text,
  p_review_sha256 text,p_review_text text,p_kit_sha256 text,p_sealed_kit text,p_attestation_sha256 text,p_owner_attestation text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE item bouncer_v14_bootstrap_v1.streams%ROWTYPE; review jsonb; kit jsonb; att jsonb; created boolean:=false;
BEGIN
  IF p_scope_id IS NULL OR p_scope_id !~ '^[0-9a-f]{32}$' OR p_capability_hash IS NULL OR p_capability_hash !~ '^[0-9a-f]{64}$' OR
     p_owner_id IS NULL OR p_vault_id IS NULL OR p_owner_public_key IS NULL OR p_temporary_public_key IS NULL OR
     p_owner_public_key !~ '^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$' OR p_temporary_public_key !~ '^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$' OR
     p_review_sha256 IS NULL OR p_review_sha256 !~ '^[0-9a-f]{64}$' OR p_review_text IS NULL OR octet_length(p_review_text) NOT BETWEEN 2 AND 24000 OR
     p_kit_sha256 IS NULL OR p_kit_sha256 !~ '^[0-9a-f]{64}$' OR p_sealed_kit IS NULL OR octet_length(p_sealed_kit) NOT BETWEEN 2 AND 16000 OR
     p_attestation_sha256 IS NULL OR p_attestation_sha256 !~ '^[0-9a-f]{64}$' OR p_owner_attestation IS NULL OR octet_length(p_owner_attestation) NOT BETWEEN 2 AND 8192 OR
     position(E'\n' IN p_review_text)<>0 OR position(E'\r' IN p_review_text)<>0 OR position(E'\n' IN p_sealed_kit)<>0 OR position(E'\r' IN p_sealed_kit)<>0 OR
     position(E'\n' IN p_owner_attestation)<>0 OR position(E'\r' IN p_owner_attestation)<>0 OR
     encode(sha256(convert_to(p_sealed_kit,'UTF8')),'hex')<>p_kit_sha256 OR
     encode(sha256(convert_to(p_owner_attestation,'UTF8')),'hex')<>p_attestation_sha256 THEN RETURN jsonb_build_object('error','unavailable'); END IF;
  BEGIN review:=p_review_text::jsonb;kit:=p_sealed_kit::jsonb;att:=p_owner_attestation::jsonb;
  EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('error','unavailable'); END;
  IF jsonb_typeof(review) IS DISTINCT FROM 'object' OR review->>'format' IS DISTINCT FROM 'bouncer-v14-temporary-vault-bootstrap-v1' OR
     review->>'network' IS DISTINCT FROM 'testnet' OR review->>'owner' IS DISTINCT FROM p_owner_id OR review->>'vault' IS DISTINCT FROM p_vault_id OR
     review->>'owner_public_key' IS DISTINCT FROM p_owner_public_key OR review->>'temporary_vault_public_key' IS DISTINCT FROM p_temporary_public_key OR
     review->>'review_sha256' IS DISTINCT FROM p_review_sha256 OR review->'wallet_approval_obtained' IS DISTINCT FROM 'false'::jsonb OR
     review->'transaction_sent' IS DISTINCT FROM 'false'::jsonb OR
     jsonb_typeof(kit) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(kit))<>14 OR
     kit->>'format' IS DISTINCT FROM 'bouncer-v14-temporary-bootstrap-kit-v1' OR kit->>'network' IS DISTINCT FROM 'testnet' OR
     kit->>'owner' IS DISTINCT FROM p_owner_id OR kit->>'vault' IS DISTINCT FROM p_vault_id OR kit->>'owner_public_key' IS DISTINCT FROM p_owner_public_key OR
     kit->>'temporary_public_key' IS DISTINCT FROM p_temporary_public_key OR kit->>'review_sha256' IS DISTINCT FROM p_review_sha256 OR
     kit->>'scope_id' IS DISTINCT FROM p_scope_id OR kit->>'capability_sha256' IS DISTINCT FROM p_capability_hash OR
     kit->>'kdf' IS DISTINCT FROM 'PBKDF2-SHA256' OR kit->'iterations' IS DISTINCT FROM to_jsonb(600000) OR
     COALESCE(kit->>'salt','') !~ '^[A-Za-z0-9+/]{22}==$' OR COALESCE(kit->>'iv','') !~ '^[A-Za-z0-9+/]{16}$' OR
     COALESCE(kit->>'ciphertext','') !~ '^[A-Za-z0-9+/]+={0,2}$' OR length(kit->>'ciphertext') NOT BETWEEN 24 AND 5500 OR
     jsonb_typeof(att) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(att))<>3 OR
     att->'terms'->>'format' IS DISTINCT FROM 'bouncer-v14-bootstrap-enrollment-v1' OR
     att->'terms'->>'network' IS DISTINCT FROM 'testnet' OR att->'terms'->>'owner' IS DISTINCT FROM p_owner_id OR
     att->'terms'->>'vault' IS DISTINCT FROM p_vault_id OR att->'terms'->>'owner_public_key' IS DISTINCT FROM p_owner_public_key OR
     att->'terms'->>'temporary_public_key' IS DISTINCT FROM p_temporary_public_key OR att->'terms'->>'scope_id' IS DISTINCT FROM p_scope_id OR
     att->'terms'->>'review_sha256' IS DISTINCT FROM p_review_sha256 OR att->'terms'->>'capability_sha256' IS DISTINCT FROM p_capability_hash OR
     att->'terms'->>'kit_sha256' IS DISTINCT FROM p_kit_sha256 OR
     COALESCE(att->'terms'->>'site','') NOT IN ('https://bouncer-near.vercel.app','https://bouncer-production-6df1.up.railway.app') OR
     jsonb_typeof(att->'nonce_base64') IS DISTINCT FROM 'string' OR jsonb_typeof(att->'signature_base64') IS DISTINCT FROM 'string'
  THEN RETURN jsonb_build_object('error','unavailable'); END IF;
  INSERT INTO bouncer_v14_bootstrap_v1.streams(scope_id,capability_hash,owner_id,vault_id,owner_public_key,temporary_public_key,
    review_sha256,review_text,kit_sha256,sealed_kit,attestation_sha256,owner_attestation)
    VALUES(p_scope_id,p_capability_hash,p_owner_id,p_vault_id,p_owner_public_key,p_temporary_public_key,
      p_review_sha256,p_review_text,p_kit_sha256,p_sealed_kit,p_attestation_sha256,p_owner_attestation)
    ON CONFLICT DO NOTHING RETURNING * INTO item;
  IF FOUND THEN created:=true;
  ELSE
    SELECT * INTO item FROM bouncer_v14_bootstrap_v1.streams WHERE scope_id=p_scope_id AND capability_hash=p_capability_hash AND
      owner_id=p_owner_id AND vault_id=p_vault_id AND owner_public_key=p_owner_public_key AND temporary_public_key=p_temporary_public_key AND
      review_sha256=p_review_sha256 AND review_text=p_review_text AND kit_sha256=p_kit_sha256 AND sealed_kit=p_sealed_kit AND
      attestation_sha256=p_attestation_sha256 AND owner_attestation=p_owner_attestation FOR SHARE;
    IF NOT FOUND THEN RETURN jsonb_build_object('error','unavailable'); END IF;
  END IF;
  RETURN jsonb_build_object('status',CASE WHEN created THEN 'ENROLLED' ELSE 'EXISTING' END,
    'scope_id',item.scope_id,'revision',item.revision,'head_sha256',item.head_sha256,'kit_sha256',item.kit_sha256,'attestation_sha256',item.attestation_sha256);
END; $$;
REVOKE ALL ON FUNCTION public.bouncer_v14_bootstrap_enroll_v1(text,text,text,text,text,text,text,text,text,text,text,text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.bouncer_v14_bootstrap_enroll_v1(text,text,text,text,text,text,text,text,text,text,text,text) TO service_role;

-- A capability-holder may read or append one exact CAS event. Claims win only
-- once; an unknown write outcome requires inspection, not a second prompt.
CREATE FUNCTION public.bouncer_v14_bootstrap_events_v1(
  p_scope_id text,p_capability_hash text,p_operation text,p_expected_revision integer DEFAULT NULL,
  p_expected_head_sha256 text DEFAULT NULL,p_record text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE item bouncer_v14_bootstrap_v1.streams%ROWTYPE; document jsonb; event_hash text; rows jsonb; expected_type text;
BEGIN
  IF p_scope_id IS NULL OR p_scope_id !~ '^[0-9a-f]{32}$' OR p_capability_hash IS NULL OR p_capability_hash !~ '^[0-9a-f]{64}$' OR
     p_operation IS NULL OR p_operation NOT IN ('read','append') THEN RETURN jsonb_build_object('error','unavailable'); END IF;
  SELECT * INTO item FROM bouncer_v14_bootstrap_v1.streams WHERE scope_id=p_scope_id AND capability_hash=p_capability_hash FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','unavailable'); END IF;
  IF p_operation='read' THEN
    IF p_expected_revision IS NOT NULL OR p_expected_head_sha256 IS NOT NULL OR p_record IS NOT NULL THEN RETURN jsonb_build_object('error','unavailable'); END IF;
  ELSE
    IF p_expected_revision IS NULL OR p_expected_revision<>item.revision OR item.revision>=4 OR p_expected_head_sha256 IS NULL OR
       p_expected_head_sha256<>item.head_sha256 OR p_record IS NULL OR octet_length(p_record) NOT BETWEEN 2 AND 4096 OR
       position(E'\n' IN p_record)<>0 OR position(E'\r' IN p_record)<>0 THEN RETURN jsonb_build_object('error','unavailable'); END IF;
    BEGIN document:=p_record::jsonb;EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('error','unavailable'); END;
    expected_type:=CASE item.revision WHEN 0 THEN 'create_claim' WHEN 1 THEN 'create_original' WHEN 2 THEN 'deploy_claim' ELSE 'deploy_original' END;
    IF jsonb_typeof(document) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(document))<>5 OR
       document->>'format' IS DISTINCT FROM 'bouncer-v14-original-event-v1' OR
       document->'seq' IS DISTINCT FROM to_jsonb(item.revision+1) OR document->>'previous_sha256' IS DISTINCT FROM item.head_sha256 OR
       document->>'type' IS DISTINCT FROM expected_type OR jsonb_typeof(document->'data') IS DISTINCT FROM 'object' OR
       (SELECT count(*) FROM jsonb_object_keys(document->'data'))<>3 OR document->'data'->>'scope_id' IS DISTINCT FROM item.scope_id OR
       document->'data'->>'review_sha256' IS DISTINCT FROM item.review_sha256 OR
       (expected_type IN ('create_claim','deploy_claim') AND document->'data'->'tx_hash' IS DISTINCT FROM 'null'::jsonb) OR
       (expected_type IN ('create_original','deploy_original') AND COALESCE(document->'data'->>'tx_hash','') !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
    THEN RETURN jsonb_build_object('error','unavailable'); END IF;
    event_hash:=encode(sha256(convert_to(p_record,'UTF8')),'hex');
    INSERT INTO bouncer_v14_bootstrap_v1.events(scope_id,seq,record,record_sha256) VALUES(item.scope_id,item.revision+1,p_record,event_hash);
    UPDATE bouncer_v14_bootstrap_v1.streams SET revision=revision+1,head_sha256=event_hash WHERE scope_id=item.scope_id RETURNING * INTO item;
  END IF;
  SELECT COALESCE(jsonb_agg(record ORDER BY seq),'[]'::jsonb) INTO rows FROM bouncer_v14_bootstrap_v1.events WHERE scope_id=item.scope_id;
  RETURN jsonb_build_object('status',CASE WHEN p_operation='read' THEN 'EXISTING' ELSE 'APPENDED' END,'scope_id',item.scope_id,
    'revision',item.revision,'head_sha256',item.head_sha256,'review_sha256',item.review_sha256,'events',rows);
END; $$;
REVOKE ALL ON FUNCTION public.bouncer_v14_bootstrap_events_v1(text,text,text,integer,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.bouncer_v14_bootstrap_events_v1(text,text,text,integer,text,text) TO service_role;

-- The Edge caller must freshly authenticate the owner before using this read.
-- Output is ciphertext and public history only; it grants no transaction rights.
CREATE FUNCTION public.bouncer_v14_bootstrap_owner_read_v1(p_owner_id text,p_vault_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE item bouncer_v14_bootstrap_v1.streams%ROWTYPE; rows jsonb;
BEGIN
  IF p_owner_id IS NULL OR p_vault_id IS NULL THEN RETURN jsonb_build_object('error','unavailable'); END IF;
  SELECT * INTO item FROM bouncer_v14_bootstrap_v1.streams WHERE owner_id=p_owner_id AND vault_id=p_vault_id FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','unavailable'); END IF;
  SELECT COALESCE(jsonb_agg(record ORDER BY seq),'[]'::jsonb) INTO rows FROM bouncer_v14_bootstrap_v1.events WHERE scope_id=item.scope_id;
  RETURN jsonb_build_object('status','EXISTING','scope_id',item.scope_id,'owner',item.owner_id,'vault',item.vault_id,
    'owner_public_key',item.owner_public_key,'temporary_public_key',item.temporary_public_key,'review_sha256',item.review_sha256,
    'review_text',item.review_text,'kit_sha256',item.kit_sha256,'sealed_kit',item.sealed_kit,'attestation_sha256',item.attestation_sha256,
    'owner_attestation',item.owner_attestation,'revision',item.revision,'head_sha256',item.head_sha256,'events',rows);
END; $$;
REVOKE ALL ON FUNCTION public.bouncer_v14_bootstrap_owner_read_v1(text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.bouncer_v14_bootstrap_owner_read_v1(text,text) TO service_role;
COMMIT;
