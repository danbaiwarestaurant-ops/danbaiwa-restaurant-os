-- Apply before releasing permanent staff deletion. Keeps historical records intact.
BEGIN;
CREATE INDEX IF NOT EXISTS audit_staff_deletion_idx ON public.audit_logs(account_id, entity_id)
  WHERE entity = 'staff_identity' AND action = 'PERMANENT_DELETE';

-- Older offline clients must not recreate a deleted staff UUID with an old PIN.
CREATE OR REPLACE FUNCTION public.reject_deleted_staff_profile()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.audit_logs a WHERE a.account_id = NEW.account_id
    AND a.entity_id = NEW.id::text AND a.entity = 'staff_identity' AND a.action = 'PERMANENT_DELETE') THEN
    RAISE EXCEPTION 'Staff profile was permanently deleted' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS prevent_deleted_staff_restore ON public.users;
CREATE TRIGGER prevent_deleted_staff_restore BEFORE INSERT OR UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.reject_deleted_staff_profile();

-- The archival identity and credential removal become one server transaction even
-- if the sending device disconnects before its queued DELETE request arrives.
CREATE OR REPLACE FUNCTION public.remove_archived_staff_profile()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.entity = 'staff_identity' AND NEW.action = 'PERMANENT_DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.users WHERE account_id = NEW.account_id AND id::text = NEW.entity_id AND role = 'admin') THEN
      RAISE EXCEPTION 'The business owner cannot be deleted as staff' USING ERRCODE = '23514';
    END IF;
    DELETE FROM public.users WHERE account_id = NEW.account_id AND id::text = NEW.entity_id AND role <> 'admin';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS remove_staff_credentials ON public.audit_logs;
CREATE TRIGGER remove_staff_credentials AFTER INSERT ON public.audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.remove_archived_staff_profile();
COMMIT;
