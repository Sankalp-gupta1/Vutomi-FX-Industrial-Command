export function logEvent(
  event: string,
  metadata: Record<string, unknown> = {},
) {
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      service: "relay",
      event,
      ...metadata,
    }),
  );
}

export function logError(
  event: string,
  error: unknown,
  metadata: Record<string, unknown> = {},
) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    JSON.stringify({
      at: new Date().toISOString(),
      service: "relay",
      event,
      error: message,
      ...metadata,
    }),
  );
}
