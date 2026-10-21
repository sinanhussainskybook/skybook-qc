-- Skybook AI QC — an additional company phone number
--
-- An optional second phone number in Company Details, next to the existing
-- one. Like `phone`, it is saved exactly as typed (at most 40 characters);
-- QC accepts either number wherever the company's contact details are used.
-- Existing companies are unaffected (null).

alter table company_contacts
  add column additional_phone text check (char_length(additional_phone) <= 40);
