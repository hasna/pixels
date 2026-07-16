export const DEFAULT_HTTP_BODY_READ_TIMEOUT_MS = 10_000;
const MAX_HTTP_BODY_READ_TIMEOUT_MS = 60_000;

export interface BoundedRequestBodyOptions {
  readonly maxBytes: number;
  readonly timeoutMs?: number;
}

export type BoundedRequestBodyResult =
  | { readonly ok: true; readonly body: Uint8Array }
  | { readonly ok: false; readonly status: 400 | 408 | 413; readonly message: string };

function normalizedTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return DEFAULT_HTTP_BODY_READ_TIMEOUT_MS;
  return Math.min(MAX_HTTP_BODY_READ_TIMEOUT_MS, Math.max(1, Math.trunc(timeoutMs)));
}

function stopReading(
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
  body: ReadableStream<Uint8Array> | null,
  reason: string,
): void {
  const cancellation = reader ? reader.cancel(reason) : body?.cancel(reason);
  void cancellation?.catch(() => {});
}

/**
 * Reads a Fetch request body under one declared-and-streamed byte cap and one
 * total deadline. Only bytes at or below the cap are retained. Overflow,
 * abort, and timeout paths cancel the source without waiting for a hostile
 * underlying cancellation callback.
 */
export async function readBoundedRequestBody(
  request: Request,
  options: BoundedRequestBodyOptions,
): Promise<BoundedRequestBodyResult> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
    throw new TypeError("maxBytes must be a non-negative safe integer");
  }
  if (request.signal.aborted) {
    stopReading(undefined, request.body, "request aborted");
    return { ok: false, status: 408, message: "request aborted" };
  }

  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) {
      stopReading(undefined, request.body, "invalid content length");
      return { ok: false, status: 400, message: "invalid content length" };
    }
    const declaredBytes = Number(declared);
    if (!Number.isSafeInteger(declaredBytes)) {
      stopReading(undefined, request.body, "invalid content length");
      return { ok: false, status: 400, message: "invalid content length" };
    }
    if (declaredBytes > options.maxBytes) {
      stopReading(undefined, request.body, "request body too large");
      return { ok: false, status: 413, message: "request body exceeds 64 KiB" };
    }
  }

  if (request.body === null) return { ok: true, body: new Uint8Array() };
  const reader = request.body.getReader();
  const timeoutMs = normalizedTimeout(options.timeoutMs);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener = () => {};
  const timedOut = new Promise<{ readonly kind: "timeout" }>((resolve) => {
    timeout = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
  });
  const aborted = new Promise<{ readonly kind: "aborted" }>((resolve) => {
    const onAbort = () => resolve({ kind: "aborted" });
    request.signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => request.signal.removeEventListener("abort", onAbort);
  });
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const read = reader.read().then(
        (result) => ({ kind: "read" as const, result }),
        () => ({ kind: "error" as const }),
      );
      const outcome = await Promise.race([read, timedOut, aborted]);
      if (outcome.kind === "timeout") {
        stopReading(reader, request.body, "request body read timeout");
        return { ok: false, status: 408, message: "request body read timeout" };
      }
      if (outcome.kind === "aborted") {
        stopReading(reader, request.body, "request aborted");
        return { ok: false, status: 408, message: "request aborted" };
      }
      if (outcome.kind === "error") {
        stopReading(reader, request.body, "unable to read request body");
        return { ok: false, status: 400, message: "unable to read request body" };
      }
      if (outcome.result.done) break;
      const chunk = outcome.result.value;
      totalBytes += chunk.byteLength;
      if (totalBytes > options.maxBytes) {
        stopReading(reader, request.body, "request body too large");
        return { ok: false, status: 413, message: "request body exceeds 64 KiB" };
      }
      chunks.push(chunk);
    }
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    removeAbortListener();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, body };
}
