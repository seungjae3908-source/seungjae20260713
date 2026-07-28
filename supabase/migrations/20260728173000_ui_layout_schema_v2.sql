-- UI canvas editor phase 2 schema compatibility.
-- Existing version 1 layouts remain valid; new drafts and published layouts use version 2.

alter table public.ui_layout_versions
  drop constraint if exists ui_layout_versions_schema_version_check;

alter table public.ui_layout_versions
  add constraint ui_layout_versions_schema_version_check
  check (schema_version in (1, 2));

alter table public.ui_layout_versions
  alter column schema_version set default 2;
