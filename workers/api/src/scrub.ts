/** Removes everything that could carry patient-sensitive or credential data from an error event before it leaves the Worker. */
export function scrubEvent<T extends { request?: Record<string, unknown>; user?: unknown }>(event: T): T {
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    delete event.request.headers;
    delete event.request.query_string;
  }
  delete event.user;
  return event;
}
