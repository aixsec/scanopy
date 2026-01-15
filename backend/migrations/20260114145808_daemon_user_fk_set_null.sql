-- Reassign daemons to organization Owner when their user is deleted
-- Previously blocked user deletion if they maintained any daemons

CREATE OR REPLACE FUNCTION reassign_daemons_on_user_delete()
RETURNS TRIGGER AS $$
DECLARE
    new_owner_id UUID;
BEGIN
    SELECT id INTO new_owner_id
    FROM users
    WHERE organization_id = OLD.organization_id
      AND permissions = 'Owner'
      AND id != OLD.id
    ORDER BY created_at ASC
    LIMIT 1;

    IF new_owner_id IS NOT NULL THEN
        UPDATE daemons
        SET user_id = new_owner_id
        WHERE user_id = OLD.id;
    END IF;

    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reassign_daemons_before_user_delete
    BEFORE DELETE ON users
    FOR EACH ROW
    EXECUTE FUNCTION reassign_daemons_on_user_delete();
