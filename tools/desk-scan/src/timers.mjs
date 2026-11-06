// Three paper clocks. Each one is armed on its own delay. Firing one does not
// reset the others. None of them submit an order.

export const PAPER_INTERVALS_MS = Object.freeze({
  risk: 5 * 60 * 1000,
  closePoll: 30 * 1000,
  chief: 60 * 1000,
});

export function createPaperTimers({
  intervals = PAPER_INTERVALS_MS,
  schedule,
  clear,
  onRisk,
  onClosePoll,
  onChief,
} = {}) {
  if (typeof schedule !== 'function' || typeof clear !== 'function') {
    throw new Error('paper timers need schedule and clear');
  }
  const handles = {};
  let stopped = true;
  function arm(name, fn) {
    handles[name] = schedule(() => {
      fn();
      if (!stopped) arm(name, fn);
    }, intervals[name]);
  }
  return {
    intervals: { risk: intervals.risk, closePoll: intervals.closePoll, chief: intervals.chief },
    start() {
      stopped = false;
      arm('risk', onRisk || (() => {}));
      arm('closePoll', onClosePoll || (() => {}));
      arm('chief', onChief || (() => {}));
    },
    stop() {
      stopped = true;
      for (const handle of Object.values(handles)) clear(handle);
    },
  };
}
