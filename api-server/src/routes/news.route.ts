import { Router } from "express";
import { NewsService } from "../services/news.service";

const router = Router();

router.get("/news/:ticker", async (req, res) => {
  try {
    const ticker = String(req.params.ticker || "").toUpperCase();

    if (!ticker) {
      return res.status(400).json({ error: "ticker required" });
    }

    const data = await NewsService.getNews(ticker);

    if (!data) {
      return res.status(404).json({ error: "news not found" });
    }

    return res.json(data);
  } catch (error) {
    console.error("news route error:", error);
    return res.status(500).json({ error: "news server error" });
  }
});

export default router;