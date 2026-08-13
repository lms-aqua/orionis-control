const SECRET_KEY = /authorization|cookie|password|secret|token/i;
const BEARER = /Bearer\s+[^\s'"`,}]+/gi;

export function redactLogValue(value, seen = new WeakSet()) {
  if (typeof value === 'string') return value.replace(BEARER, 'Bearer [REDACTED]');
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (value instanceof Error) {
    return { name: value.name, message: redactLogValue(value.message, seen) };
  }
  if (Array.isArray(value)) return value.map((item) => redactLogValue(item, seen));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SECRET_KEY.test(key) ? '[REDACTED]' : redactLogValue(item, seen),
    ]),
  );
}

export function installRedactingConsole(target = console) {
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    const write = target[method].bind(target);
    target[method] = (...args) => write(...args.map((arg) => redactLogValue(arg)));
  }
}
