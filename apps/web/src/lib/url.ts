export function getBaseUrl() {
  if (typeof window !== "undefined") {
    return window.location.origin;
  }
  // eslint-disable-next-line no-restricted-properties
  return `http://localhost:${process.env.PORT ?? 3000}`;
}
