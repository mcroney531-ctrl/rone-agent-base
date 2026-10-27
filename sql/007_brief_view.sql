-- "Deeper prep ready" in Needs You until the owner has seen it on the brief.
alter table ops.brief_deeper add column if not exists seen_at timestamptz;
