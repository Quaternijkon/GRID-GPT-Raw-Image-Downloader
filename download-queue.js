/* Per-run application-level congestion control and bounded task admission. */
(() => {
  const DEFAULT_CONCURRENCY = 6; // Manual default, retained for old preferences.
  const DEFAULT_MODE = 'auto';
  const MAX_CONCURRENCY = 12;
  const AUTO_MAX_CONCURRENCY = 64;
  const MiB = 1048576;

  function normalizeConcurrency(value) {
    if (value === 'auto' || value == null || value === '') return DEFAULT_MODE;
    const number = Number(value);
    return Number.isFinite(number) && number >= 1 ? Math.min(MAX_CONCURRENCY, Math.floor(number)) : DEFAULT_MODE;
  }

  function createController({ concurrency = DEFAULT_MODE, now = () => Date.now(), memoryBudgetBytes = 384 * MiB } = {}) {
    const requested = normalizeConcurrency(concurrency);
    const auto = requested === 'auto';
    const started = now();
    let target = auto ? 8 : requested, phase = auto ? 'probing' : 'manual', reason = 'Starting';
    let pauseUntil = 0, lastDecrease = -Infinity, lastSample = started, lastProbe = started;
    let bytes = 0, good = 0, bad = 0, latencySum = 0, clean = 0;
    let headerLatency = 0, headerSamples = 0, taskBaseLatency = Infinity, lastGrowthFrom = null;
    let baseLatency = Infinity, previousRate = 0, noGain = 0, probing = auto;
    let workingBytes = 8 * MiB, memoryLimit = AUTO_MAX_CONCURRENCY, rollback = null;
    let peakTarget = target, adjustments = 0;
    const history = [];
    const budget = Math.max(64 * MiB, Number(memoryBudgetBytes) || 384 * MiB);
    const max = () => Math.max(1, Math.min(AUTO_MAX_CONCURRENCY, Math.floor(budget / workingBytes)));
    memoryLimit = max();
    function change(next, why, nextPhase) {
      const old = target;
      target = auto ? Math.max(1, Math.min(max(), Math.floor(next))) : requested;
      reason = why; phase = nextPhase;
      peakTarget = Math.max(peakTarget, target);
      if (target !== old) {
        adjustments++;
        history.push({ elapsedMs: now() - started, from: old, to: target, reason: why });
        if (history.length > 128) history.shift();
      }
    }
    function congest(why = 'Server throttling', until = now() + 1000) {
      pauseUntil = Math.max(pauseUntil, until);
      if (auto && now() - lastDecrease >= 4000) {
        change(Math.floor(target / 2), why, 'backoff');
        lastDecrease = now(); probing = false; rollback = null;
      }
      reason = why;
      lastSample = now(); bytes = good = bad = latencySum = clean = 0;
      headerLatency = headerSamples = 0;
    }
    function observe(value, elapsedMs, rejected = false) {
      const errors = value?.retrievalErrors || [];
      const transient = errors.some(e => [408, 429, 500, 502, 503, 504].includes(e.status) ||
        (e.phase === 'fetch' && !e.status));
      if (transient || rejected) bad++;
      if (value?.status === 'queued') {
        good++; bytes += value.bytes || 0;
        if (!transient && value.retrievalAttempts <= 1) {
          latencySum += elapsedMs / Math.max(0.25, (value.bytes || 0) / MiB);
          clean++;
        }
      }
      if (value?.bytes > 0) {
        // Approximation includes encoded copies, Base64/message work and decoded pixels.
        const estimate = Math.max(8 * MiB, value.bytes * 4 + (value.width || 0) * (value.height || 0) * 4);
        workingBytes = Math.max(estimate, workingBytes * 0.9 + estimate * 0.1);
        memoryLimit = max();
        if (auto && target > memoryLimit) change(memoryLimit, 'Estimated memory budget', 'memory-bound');
      }
    }
    function snapshot() {
      return { mode: auto ? 'auto' : 'manual', concurrency: target, phase, reason,
        pauseUntil, coolingDown: now() < pauseUntil, memoryLimit: auto ? memoryLimit : requested,
        memoryBudgetBytes: budget, estimatedTaskBytes: Math.round(workingBytes), peakTarget, adjustments };
    }
    function sample({ active = 0, pending = 0 } = {}) {
      const time = now(), elapsed = time - lastSample;
      if (!auto || time < pauseUntil || elapsed < 4000 || pending === 0 || good + bad < 4) return snapshot();
      const rate = bytes / (elapsed / 1000);
      const latency = headerSamples ? headerLatency / headerSamples : null;
      const taskLatency = clean ? latencySum / clean : null;
      if (latency !== null) baseLatency = Math.min(baseLatency, latency);
      if (taskLatency !== null) taskBaseLatency = Math.min(taskBaseLatency, taskLatency);
      const inflated = latency !== null ? latency > baseLatency * 1.6 :
        taskLatency !== null && taskLatency > taskBaseLatency * 1.6;
      const gain = previousRate ? rate / previousRate : 2;
      if (bad / Math.max(1, good + bad) > 0.15) {
        change(Math.floor(target * 0.7), 'Transient request errors', 'backoff');
        lastDecrease = time; probing = false; rollback = null;
      } else if (inflated && gain < 1.08 && time - lastDecrease >= 8000) {
        change(Math.floor(target * 0.75), 'Latency rose without throughput gain', 'backoff');
        lastDecrease = time; probing = false; rollback = null;
      } else if (time - lastDecrease < 8000) {
        phase = 'recovering'; reason = 'Observing after backoff';
      } else if (rollback !== null) {
        if (gain < 1.05) change(rollback, 'Probe did not improve throughput', 'cruising');
        else { phase = 'cruising'; reason = 'Probe improved throughput'; }
        rollback = null; lastProbe = time;
      } else if (probing && gain > 1.08 && active >= Math.max(1, target - 1)) {
        noGain = 0;
        lastGrowthFrom = target;
        change(target + Math.max(2, Math.ceil(target / 2)), 'Throughput growing', 'probing');
      } else {
        noGain++;
        if (probing && noGain >= 2) {
          probing = false;
          if (lastGrowthFrom !== null && target > lastGrowthFrom) change(lastGrowthFrom, 'Throughput plateau after growth', 'cruising');
          lastGrowthFrom = null;
        }
        phase = target >= memoryLimit ? 'memory-bound' : 'cruising';
        reason = phase === 'memory-bound' ? 'Estimated memory budget' : 'Holding measured throughput';
        if (!probing && time - lastProbe >= 12000 && target < memoryLimit && active >= Math.max(1, target - 1)) {
          rollback = target;
          change(target + 2, 'Exploring spare capacity', 'probing');
          lastProbe = time;
        }
      }
      previousRate = rate;
      lastSample = time; bytes = good = bad = latencySum = clean = 0;
      headerLatency = headerSamples = 0;
      return snapshot();
    }
    return { observe, sample, snapshot, congest,
      observeNetwork: ({ ttfbMs }) => {
        if (Number.isFinite(ttfbMs) && ttfbMs > 0) { headerLatency += ttfbMs; headerSamples++; }
      },
      summary: () => ({ ...snapshot(), history: history.slice() }) };
  }

  async function run(items, task, { concurrency = DEFAULT_MODE, onProgress = () => {}, controller,
    now = () => Date.now(), tickMs = 500 } = {}) {
    const control = controller || createController({ concurrency, now });
    const results = new Array(items.length);
    let next = 0, active = 0, completed = 0, peakActive = 0, progressEnabled = true;
    return new Promise(resolve => {
      let timer, done = false;
      function notify(state) {
        if (!progressEnabled) return;
        try { onProgress({ total: items.length, started: next, completed, active,
          pending: items.length - next, peakActive, ...state }); }
        catch (error) { progressEnabled = false; console.warn('[BulkDL] Progress callback failed:', error); }
      }
      function pump() {
        if (done) return;
        const state = control.sample({ active, pending: items.length - next });
        while (!state.coolingDown && active < state.concurrency && next < items.length) {
          const index = next++, began = now();
          active++; peakActive = Math.max(peakActive, active);
          Promise.resolve().then(() => task(items[index], index)).then(
            value => { results[index] = { status: 'fulfilled', value }; },
            reason => { results[index] = { status: 'rejected', reason }; }
          ).then(() => {
            const outcome = results[index];
            control.observe(outcome.value, now() - began, outcome.status === 'rejected');
            active--; completed++;
            pump();
          });
        }
        notify(state);
        if (completed === items.length) { done = true; clearInterval(timer); resolve(results); }
      }
      timer = setInterval(pump, tickMs);
      pump();
    });
  }

  const api = { DEFAULT_CONCURRENCY, DEFAULT_MODE, MAX_CONCURRENCY, AUTO_MAX_CONCURRENCY,
    normalizeConcurrency, createController, run };
  globalThis.ChatGPTDownloadQueue = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
