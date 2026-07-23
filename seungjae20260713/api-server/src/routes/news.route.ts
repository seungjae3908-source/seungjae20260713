import { Router } from "express";
import { NewsService, NewsProviderError } from "../services/news.service";

const router = Router();

router.get("/news/:ticker", async (req, res) => {
  const fetchedAt = new Date().toISOString();
  try {
    const ticker = String(req.params.ticker || "").toUpperCase();

    if (!ticker) {
      return res.status(400).json({ ok: false, error: "TICKER_REQUIRED" });
    }

    const data = await NewsService.getNews(ticker);

    if (!data) {
      return res.status(404).json({ ok: false, error: "TICKER_NOT_FOUND" });
    }

    const provider = /^\d{6}$/.test(ticker) ? "google-news" : "finnhub/google-news";
    return res.json({ ok: true, provider, fetchedAt, ...data });
  } catch (error) {
    if (error instanceof NewsProviderError) {
      // 공급자 실패 — 가짜 뉴스를 만들지 않고 오류로 알린다.
      return res.status(502).json({ ok: false, error: "NEWS_PROVIDER_ERROR", message: error.message });
    }
    console.error("news route error:", error);
    return res.status(500).json({ ok: false, error: "NEWS_ROUTE_ERROR" });
  }
});

export default router;