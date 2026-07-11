import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import router from "./routes";
import { logger } from "./lib/logger";
import { NewsService } from "./services/news.service";

const app: Express = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const clientDist = path.resolve(__dirname, "../../stock-analyzer/dist/public");
const clientIndex = path.join(clientDist, "index.html");

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/api", (_req, res) => {
  res.json({
    status: "ok",
    version: "news-api-test-001",
  });
});

app.get("/api/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/stocks/:ticker/news", async (req, res) => {
  try {
    const ticker = String(req.params.ticker || "").toUpperCase();

    const news = await NewsService.getNews(ticker);

    if (!news) {
      return res.status(404).json({
        error: "NEWS_NOT_FOUND",
        ticker,
      });
    }

    return res.json(news);
  } catch (error) {
    console.error("direct news route error:", error);

    return res.status(500).json({
      error: "NEWS_ROUTE_ERROR",
    });
  }
});

app.use("/api", router);

if (existsSync(clientDist)) {
  app.use(express.static(clientDist));

  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(clientIndex);
  });
}

export default app;