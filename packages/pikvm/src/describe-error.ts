/**
 * `ws` (and Node's own DNS resolution) sometimes surfaces connection failures as an
 * `AggregateError` with an empty top-level `.message` and the real detail nested in
 * `.errors` (one per resolved address, e.g. IPv6 and IPv4 both refusing the connection).
 * Without this, a real connection failure logs as an unhelpful empty string.
 */
export function describeError(err: Error): string {
  const nested = (err as { errors?: Error[] }).errors;
  if (err.message) return err.message;
  if (nested?.length) return nested.map((e) => e.message).join("; ");
  return err.toString();
}
