/** Shared by scheduled and interactive callers; close stops admission before draining. */
export function createSingleFlightTask(work: () => Promise<void>) {
  let active: Promise<void> | undefined;
  let stopped = false;
  return {
    run(): Promise<void> {
      if (stopped) return Promise.resolve();
      if (active) return active;
      try { active = work().finally(() => { active = undefined; }); }
      catch (error) { active = Promise.reject(error); active.catch(() => { active = undefined; }); }
      return active;
    },
    close(): Promise<void> {
      stopped = true;
      return active?.catch(() => undefined) ?? Promise.resolve();
    },
  };
}
