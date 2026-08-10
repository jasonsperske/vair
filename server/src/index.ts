import express from "express";
import { mkdirSync } from "node:fs";
import { capabilities, env } from "./env.js";
import { assetsRouter } from "./assets/routes.js";
import { sttRouter } from "./stt/routes.js";
import { claudeRouter } from "./claude/routes.js";
import { scenesRouter } from "./scenes/routes.js";
import { latencyRouter } from "./latency/routes.js";

mkdirSync(env.dataDir, { recursive: true });

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_req, res) => {
  // Booleans only — the client uses these to decide what to offer, and a
  // capability probe is not a place to leak configuration.
  res.json({ ok: true, ...capabilities() });
});

app.use("/api/assets", assetsRouter);
app.use("/api/stt", sttRouter);
app.use("/api/claude", claudeRouter);
app.use("/api/scenes", scenesRouter);
app.use("/api/latency", latencyRouter);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[vair]", err);
  res.status(500).json({ error: err instanceof Error ? err.message : "internal error" });
});

app.listen(env.port, () => {
  const caps = capabilities();
  console.log(`[vair] server on http://127.0.0.1:${env.port}`);
  console.log(`[vair] stt=${caps.stt ? env.sttProvider : "not configured"} claude=${caps.claude ? env.anthropicModel : "not configured"}`);
  console.log(`[vair] data dir ${env.dataDir}`);
});
