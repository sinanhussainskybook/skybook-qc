import { isIP } from "node:net";

/**
 * The client's IP address, for the per-IP sign-in limit only (never for access decisions).
 *
 * Render's proxy sits in front of the app and forwards the client address in `X-Forwarded-For`.
 * A visitor can send their own `X-Forwarded-For` too, but a proxy adds the address it saw at the
 * END of the list, so only the LAST entry can't be made up by the visitor. Anything else
 * (earlier entries, `X-Real-IP`, `CF-Connecting-IP`, …) is ignored for that reason.
 *
 * Returns null when there is no usable address (e.g. local development without a proxy); the
 * per-IP limit is then skipped rather than putting everyone under one shared counter.
 */
export function clientIpFromHeaders(headers: Pick<Headers, "get">): string | null {
  const forwarded = headers.get("x-forwarded-for");
  if (!forwarded) return null;
  const entries = forwarded.split(",").map((entry) => entry.trim()).filter(Boolean);
  return normalizeIp(entries.at(-1) ?? "");
}

/** A valid IPv4 / IPv6 address in one standard form, or null. */
export function normalizeIp(value: string): string | null {
  let ip = value.trim();
  // "[2001:db8::1]:443" and "203.0.113.7:51234" (address with a port).
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
  if (bracketed) ip = bracketed[1];
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(":"));
  ip = ip.toLowerCase();
  // An IPv4 address written as IPv6 ("::ffff:203.0.113.7") is the IPv4 address.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (mapped) ip = mapped[1];
  return isIP(ip) ? ip : null;
}

/**
 * The counter key for an address. IPv6 is counted per /64 network: one home or office line
 * usually gets a whole /64, so changing the last half of the address doesn't reset the limit.
 */
export function ipThrottleKey(ip: string): string {
  if (isIP(ip) !== 6) return `ip:${ip}`;
  return `ip:${expandIpv6(ip).slice(0, 4).join(":")}::/64`;
}

/** The eight 16-bit groups of an IPv6 address, as lower-case hex without leading zeros. */
function expandIpv6(ip: string): string[] {
  let address = ip.toLowerCase();
  // A trailing IPv4 part ("64:ff9b::192.0.2.1") becomes two groups.
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    address = address.slice(0, v4.index) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = address.includes("::") ? address.split("::") : [address, undefined];
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const middle = tail === undefined ? [] : Array(8 - left.length - right.length).fill("0");
  return [...left, ...middle, ...right].map((group) => parseInt(group, 16).toString(16));
}
