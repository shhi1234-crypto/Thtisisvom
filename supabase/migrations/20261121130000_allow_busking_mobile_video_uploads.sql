-- Allow short phone videos alongside the existing audio and PDF formats.
update storage.buckets set allowed_mime_types = array(select distinct mime from unnest(coalesce(allowed_mime_types, '{}'::text[]) || array['video/mp4','video/quicktime','video/3gpp']) as mime) where id = 'busking-files';
