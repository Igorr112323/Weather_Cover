/** Мелкая асинхронная утилитарика: отложка, сериализация, защита от устаревших ответов. */

export function debounce(fn, wait = 300) {
  let timer = 0;
  const wrapped = (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = 0;
      fn(...args);
    }, wait);
  };
  wrapped.flush = (...args) => {
    if (timer) {
      window.clearTimeout(timer);
      timer = 0;
    }
    fn(...args);
  };
  wrapped.cancel = () => {
    if (timer) {
      window.clearTimeout(timer);
      timer = 0;
    }
  };
  return wrapped;
}

/**
 * Последовательная очередь: операции записи в базу не перекрываются,
 * каждая начинается после завершения предыдущей.
 */
export function createSerialQueue() {
  let tail = Promise.resolve();
  let pending = 0;

  return {
    get size() {
      return pending;
    },
    get busy() {
      return pending > 0;
    },
    enqueue(task) {
      pending += 1;
      const run = tail.then(() => task(), () => task());
      tail = run.then(
        () => {
          pending -= 1;
        },
        () => {
          pending -= 1;
        },
      );
      return run;
    },
    drain() {
      return tail;
    },
  };
}

/**
 * Очередь асинхронных операций: результат более позднего вызова не должен
 * перетирать результат более раннего (быстрое переключение вкладок, двойные
 * клики по «Спрогнозировать»).
 */
export function createStaleGuard() {
  let sequence = 0;
  return {
    next() {
      sequence += 1;
      const token = sequence;
      return {
        isCurrent: () => token === sequence,
        token,
      };
    },
    invalidate() {
      sequence += 1;
    },
    get current() {
      return sequence;
    },
  };
}

export function sleep(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/** Ожидание следующего кадра — удобно перед измерением/перерисовкой карты. */
export function nextFrame() {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}
