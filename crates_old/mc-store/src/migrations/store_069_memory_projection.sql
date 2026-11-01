-- The applied memory tuple is serialized in mc_cache_state.meta, beside the
-- frozen pair, and shares its cache generation CAS. Fence older binaries out:
-- they would silently discard the tuple on a metadata-only rewrite.
SELECT 1;
