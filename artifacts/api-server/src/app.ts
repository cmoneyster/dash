import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { classifyPath, recordHttpRequest } from "./lib/idle-metrics";

const app: Express = express();

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
    recordHttpRequest(classifyPath(path));
  }
  next();
});

app.use("/api", router);

export default app;
