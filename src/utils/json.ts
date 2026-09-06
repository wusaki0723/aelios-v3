export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function openAiError(message: string, status = 400, type = "invalid_request_error"): Response {
  return json(
    {
      error: {
        message,
        type,
        param: null,
        code: null
      }
    },
    { status }
  );
}
