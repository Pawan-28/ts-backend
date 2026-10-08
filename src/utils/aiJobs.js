/**
 * In-memory background jobs for slow AI work (a 47-minute call recording needs download + upload + transcription + MoM = minutes).
 * The HTTP request returns at once; the job keeps running on the server and the page polls its state.
 *
 *   start(key, run)  -> { started, job }   one job per key: asking again while it runs returns the SAME job (no second Gemini spend)
 *   get(key)         -> job | null         { state: "running" | "done" | "failed", startedAt, finishedAt, result, error }
 *
 * Finished jobs are kept for `ttlMs` so a poll that arrives a little late still gets the answer, then dropped.
 */
const DEFAULT_TTL_MS = 15 * 60 * 1000;

function createJobRunner({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
  const jobs = new Map();

  const view = (job) => (job ? { state: job.state, startedAt: job.startedAt, finishedAt: job.finishedAt, result: job.result, error: job.error } : null);

  const prune = () => {
    for (const [key, job] of jobs) {
      if (job.state !== "running" && now() - job.finishedAt > ttlMs) jobs.delete(key);
    }
  };

  function start(key, run) {
    prune();
    const current = jobs.get(key);
    if (current && current.state === "running") return { started: false, job: view(current) };

    const job = { state: "running", startedAt: now(), finishedAt: null, result: null, error: null };
    jobs.set(key, job);
    const finish = (patch) => Object.assign(job, patch, { finishedAt: now() });
    Promise.resolve()
      .then(run)
      .then(
        (result) => finish({ state: "done", result }),
        (err) => finish({ state: "failed", error: { message: (err && err.message) || String(err), status: (err && err.status) || 500 } }),
      );
    return { started: true, job: view(job) };
  }

  function get(key) {
    prune();
    return view(jobs.get(key));
  }

  return { start, get };
}

module.exports = { createJobRunner, DEFAULT_TTL_MS };
