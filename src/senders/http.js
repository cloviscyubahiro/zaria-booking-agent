// Small JSON POST helper shared by the senders. Retries only when a retry can
// help (network error, rate limit 429, server error 5xx). A bad token or a bad
// number is reported straight away instead of being hammered three times.

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function postJson({ url, headers = {}, body, fetchImpl = globalThis.fetch, attempts = 3, sleep = wait, timeoutMs = 20000 }) {
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) return { ok: true, status: res.status, data };
      last = { ok: false, status: res.status, data };
      if (!(res.status === 429 || res.status >= 500)) return last;
    } catch (err) {
      last = { ok: false, status: 0, data: { error: { message: err.message } } };
    }
    if (attempt < attempts) await sleep(attempt * 2000);
  }
  return last;
}
