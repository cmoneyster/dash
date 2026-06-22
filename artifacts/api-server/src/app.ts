import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { classifyPath, normalizePath, recordHttpRequest } from "./lib/idle-metrics";

const app: Express = express();

// One trusted proxy hop in front of us (Replit platform proxy). This makes
// `req.ip` resolve to the real client address rather than the edge proxy,
// which is what the demo flow's per-IP rate limiter needs to be accurate.
app.set("trust proxy", 1);

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
// Square webhook signature is HMAC over the EXACT raw request body. Mount a
// raw-body parser for that one path BEFORE express.json so the buffer is
// preserved; the route handler parses the JSON itself.
app.use("/api/webhooks/square", express.raw({ type: "*/*", limit: "1mb" }));
// Instagram webhook: Meta signs POST payloads with HMAC-SHA256 over the raw body.
// Mount the raw parser before express.json so the Buffer is preserved.
app.use("/api/webhooks/instagram", express.raw({ type: "*/*", limit: "1mb" }));
// 2mb covers the menu CSV apply endpoint which echoes parsed CSVs back to
// the server (real exports approach a few hundred KB; the multipart upload
// cap on the same feature is 10MB). All other endpoints send much smaller
// payloads, so this is comfortably below DoS-territory.
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

// Track inbound HTTP traffic for the admin idle-activity dashboard.
// Mounted right before the API router so the count covers every
// request that actually reaches a route handler. We skip the dashboard
// endpoint itself so polling the page doesn't inflate its own number.
app.use("/api", (req, _res, next) => {
  const path = req.baseUrl + (req.path ?? "");
  if (!path.startsWith("/api/admin/idle-activity")) {
    // Normalize the URL into a route template (numeric / UUID segments
    // collapse to ":id") so the per-endpoint breakdown groups hits by
    // route rather than by every distinct order/inquiry ID.
    recordHttpRequest(classifyPath(path), normalizePath(path));
  }
  next();
});

app.use("/api", router);

export default app;
