-- Leila Hormozi Threads pipeline: enum addition.
--
-- Postgres rule: an enum value added in a transaction can't be referenced
-- in the same transaction. Keep this migration single-statement so the
-- value is visible to subsequent migrations and runtime inserts.

ALTER TYPE platform_enum ADD VALUE IF NOT EXISTS 'threads_leila';
