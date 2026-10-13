-- Skybook AI QC — temporary passwords (admin User Management)
--
-- When an administrator creates a user or resets a password, the password
-- they type is temporary: the user must choose their own at the next
-- sign-in. Existing accounts are unaffected (false).

alter table app_users
  add column must_change_password boolean not null default false;
