/** Framework seam for work that continues after an OAuth response is sent. */

export type PostResponseTask = () => void | Promise<void>;
export type PostResponseScheduler = (task: PostResponseTask) => void;

let testScheduler: PostResponseScheduler | null = null;

export function schedulePostResponse(
  task: PostResponseTask,
  productionScheduler: PostResponseScheduler,
): void {
  (testScheduler ?? productionScheduler)(task);
}

/** Credential-free route tests only. Always reset this in a `finally` block. */
export function setPostResponseSchedulerForTests(scheduler: PostResponseScheduler | null): void {
  testScheduler = scheduler;
}
