export function normalizeEmailAddress(value: unknown): string {
  const input = String(value ?? "").trim();
  const angleMatch = input.match(/<([^>]+)>/);
  return (angleMatch?.[1] ?? input).trim().toLowerCase();
}
