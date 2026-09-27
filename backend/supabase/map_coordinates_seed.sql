-- ============================================================================
-- StudyHub — sample map coordinates
-- Run AFTER map_and_feed_schema.sql.
--
-- This sets coordinates on your EXISTING institutions rows (matched by name)
-- so the map isn't empty. Edit the names/coordinates to match your real data,
-- or skip this file entirely and set latitude/longitude by hand in the
-- Table Editor for each institution you care about.
-- ============================================================================

update public.institutions set latitude = 27.7172, longitude = 85.3240
where lower(name) = lower('St. Xavier''s College');

-- Generic fallback: any institution still missing coordinates gets a
-- realistic-looking scatter around Kathmandu so the map isn't blank while
-- you fill in real addresses. Safe to skip/delete this block.
update public.institutions
set
    latitude  = 27.7172 + (random() - 0.5) * 0.08,
    longitude = 85.3240 + (random() - 0.5) * 0.08
where latitude is null;
