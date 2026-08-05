import { Router, type IRouter, type Request } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { MarketDataService } from "../services/market-data.service";

const router: IRouter = Router();

function isDirectLoopbackProbe(req: Request): boolean {
  const remoteAddress = req.socket.remoteAddress ?? "";
  const host = String(req.headers.host ?? "").trim().toLowerCase();
  const loopbackRemote =
    remoteAddress === "127.0.0.1" ||
    remoteAddress === "::1" ||
    remoteAddress === "::ffff:127.0.0.1";
  const loopbackHost = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host);
  return loopbackRemote && loopbackHost;
}

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/healthz/data-plane", async (req, res) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");

  // This endpoint exists only for the deployment script's direct loopback
  // canary/live checks. Public proxy requests must not expose or trigger the
  // underlying market-data provider call.
  if (!isDirectLoopbackProbe(req)) {
    return res.status(404).json({ ok: false, error: "NOT_FOUND" });
  }

  const checkedAt = new Date().toISOString();

  try {
    const quotes = await MarketDataService.getQuotes(["005930"]);
    const quote = quotes.find((row) =>
      row.ticker === "005930" &&
      Number.isFinite(row.price) &&
      row.price > 0 &&
      Number.isFinite(Date.parse(row.updatedAt)),
    );

    if (!quote) {
      return res.status(503).json({
        ok: false,
        dataPlane: "market-quotes",
        available: 0,
        error: "QUOTE_UNAVAILABLE",
        checkedAt,
      });
    }

    return res.status(200).json({
      ok: true,
      dataPlane: "market-quotes",
      symbol: quote.ticker,
      market: quote.market,
      currency: quote.currency,
      available: 1,
      priceValidated: true,
      providerUpdatedAt: quote.updatedAt,
      checkedAt,
    });
  } catch {
    // Keep the warning deterministic and secret-free. Request-level logging
    // still records the resulting 503 without coupling this router to Pino's
    // development transport in isolated smoke-test bundles.
    console.warn("production data-plane readiness probe failed");
    return res.status(503).json({
      ok: false,
      dataPlane: "market-quotes",
      available: 0,
      error: "DATA_PLANE_UNAVAILABLE",
      checkedAt,
    });
  }
});

export default router;
