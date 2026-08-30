-- Enforces "at most one active/pending session per equipment" at the database level, not
-- just in application code (StartSessionHandler.execute() checks this too, as the fast path
-- with a friendly error -- see that handler's comment). A partial unique index is what
-- closes the actual race: two concurrent StartSessionCommand calls for the same equipment
-- could otherwise both pass an application-level "is anyone already using this?" check
-- before either has committed its INSERT. Without this, two different operators could end
-- up with two independent Session rows both claiming the same physical console -- each
-- believing itself to be in exclusive control, with no coordination between them.

CREATE UNIQUE INDEX sessions_one_active_per_equipment
  ON sessions ("equipmentId")
  WHERE status IN ('PENDING', 'ACTIVE');
