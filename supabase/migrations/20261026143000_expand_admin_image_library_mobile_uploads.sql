-- Allow the private admin image library to accept current mobile camera formats.
-- HEIC/HEIF are common on iPhone and some Android galleries.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'admin-image-library',
  'admin-image-library',
  false,
  52428800,
  array['image/jpeg','image/png','image/webp','image/gif','image/heic','image/heif']::text[]
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
