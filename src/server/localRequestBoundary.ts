import type { Request, Response, NextFunction } from "express";

export function isLoopbackHost(host: string): boolean {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host);
}

export function browserOriginAllowed(origin: string | undefined, host: string, protocol: string): boolean {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return url.origin === `${protocol}://${host}`;
  } catch { return false; }
}

export function localRequestBoundary(req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https://cdn.jsdelivr.net https://www.google.com data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if (!isLoopbackHost(req.hostname)) {
    res.status(421).json({ ok: false, error: "untrusted host" });
    return;
  }
  if (req.headers["sec-fetch-site"] === "cross-site" || !browserOriginAllowed(req.headers.origin, req.get("host") ?? "", req.protocol)) {
    res.status(403).json({ ok: false, error: "untrusted origin" });
    return;
  }
  next();
}
