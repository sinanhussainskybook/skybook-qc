import { describe, expect, it } from "vitest";
import { clientIpFromHeaders, ipThrottleKey, normalizeIp } from "@/lib/auth/client-ip";

const forwarded = (value?: string) => new Headers(value === undefined ? {} : { "x-forwarded-for": value });

describe("the client IP for the sign-in limit", () => {
  it("takes the address the proxy added: the LAST X-Forwarded-For entry", () => {
    expect(clientIpFromHeaders(forwarded("203.0.113.7"))).toBe("203.0.113.7");
    expect(clientIpFromHeaders(forwarded("198.51.100.1, 203.0.113.7"))).toBe("203.0.113.7");
  });

  it("ignores addresses a visitor makes up in front of the real one", () => {
    // A visitor sends "X-Forwarded-For: 10.0.0.1"; the proxy appends what it really saw.
    expect(clientIpFromHeaders(forwarded("10.0.0.1, 1.1.1.1, 203.0.113.7"))).toBe("203.0.113.7");
  });

  it("ignores other client-supplied headers", () => {
    const headers = new Headers({ "x-real-ip": "10.0.0.1", "cf-connecting-ip": "10.0.0.2", "true-client-ip": "10.0.0.3" });
    expect(clientIpFromHeaders(headers)).toBeNull();
  });

  it("gives null (limit skipped) with no header, an empty one or a malformed last entry", () => {
    expect(clientIpFromHeaders(forwarded())).toBeNull();
    expect(clientIpFromHeaders(forwarded(""))).toBeNull();
    expect(clientIpFromHeaders(forwarded(" , "))).toBeNull();
    expect(clientIpFromHeaders(forwarded("203.0.113.7, not-an-ip"))).toBeNull();
    expect(clientIpFromHeaders(forwarded("203.0.113.7, 999.1.1.1"))).toBeNull();
  });

  it("reads IPv6, addresses with a port and IPv4 written as IPv6 the same way", () => {
    expect(clientIpFromHeaders(forwarded("2001:DB8::1"))).toBe("2001:db8::1");
    expect(normalizeIp("[2001:db8::1]:443")).toBe("2001:db8::1");
    expect(normalizeIp("203.0.113.7:51234")).toBe("203.0.113.7");
    expect(normalizeIp("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(normalizeIp("  203.0.113.7 ")).toBe("203.0.113.7");
  });

  it("counts IPv4 per address", () => {
    expect(ipThrottleKey("203.0.113.7")).toBe("ip:203.0.113.7");
    expect(ipThrottleKey("203.0.113.8")).not.toBe(ipThrottleKey("203.0.113.7"));
  });

  it("counts IPv6 per /64 network, however the address is written", () => {
    const key = ipThrottleKey("2001:db8:1:2::1");
    expect(key).toBe("ip:2001:db8:1:2::/64");
    expect(ipThrottleKey("2001:db8:1:2:ffff:eeee:dddd:cccc")).toBe(key);
    expect(ipThrottleKey("2001:0db8:0001:0002:0:0:0:9")).toBe(key);
    expect(ipThrottleKey("2001:db8:1:3::1")).not.toBe(key);
    expect(ipThrottleKey("::1")).toBe("ip:0:0:0:0::/64");
    expect(ipThrottleKey("2001:db8::")).toBe("ip:2001:db8:0:0::/64");
    expect(ipThrottleKey("64:ff9b::192.0.2.1")).toBe("ip:64:ff9b:0:0::/64");
  });
});
