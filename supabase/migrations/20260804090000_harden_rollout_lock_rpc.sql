-- The rollout lease RPCs are server-only safety primitives. The original
-- migration removed their default PUBLIC execute privilege but did not grant
-- execute back to PostgREST's service role, which would make real Supabase
-- rollouts fail closed before acquiring a lease.

alter function public.pf_acquire_rollout_lock(uuid, uuid, integer)
  set search_path = '';
alter function public.pf_release_rollout_lock(uuid, uuid)
  set search_path = '';

revoke all on function public.pf_acquire_rollout_lock(uuid, uuid, integer)
  from public, anon, authenticated, priceflag_ml_readonly;
revoke all on function public.pf_release_rollout_lock(uuid, uuid)
  from public, anon, authenticated, priceflag_ml_readonly;

grant execute on function public.pf_acquire_rollout_lock(uuid, uuid, integer)
  to service_role;
grant execute on function public.pf_release_rollout_lock(uuid, uuid)
  to service_role;
