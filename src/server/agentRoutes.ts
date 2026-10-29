import { Router } from "express";
import { AgentService, AgentServiceError } from "../agents/agentService.js";
import type { CodexAvatarSource } from "../agents/codexNativeAvatars.js";

/** Mount behind the local request boundary / 挂载在本地同源请求边界之后。 */
export function createAgentRouter(service: AgentService, avatars?: Pick<CodexAvatarSource, "getAsset">): Router {
  const router = Router();
  router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  router.get("/avatar", async (req, res) => {
    try {
      const id = req.query.asset_id;
      const theme = req.query.theme ?? "light";
      if (typeof id !== "string" || !/^[a-zA-Z0-9_.:-]{1,256}$/.test(id)
        || (theme !== "light" && theme !== "dark")) throw new AgentServiceError(400, "invalid_request");
      const svg = await avatars?.getAsset(id, theme);
      if (!svg) throw new AgentServiceError(404, "avatar_not_found");
      // Successful artwork IDs include the content hash. Browser-private caching
      // avoids fetching the same built-in icon on every session-age refresh.
      res.setHeader("Cache-Control", "private, max-age=86400, immutable");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.type("image/svg+xml").send(svg);
    } catch (error) { respond(error, res); }
  });
  router.get("/live", async (_req, res) => {
    try { res.json(await service.snapshot()); }
    catch (error) { respond(error, res); }
  });
  router.get("/execution", async (req, res) => {
    try {
      const sessionId = req.query.session_id;
      if (typeof sessionId !== "string" || !sessionId.trim() || sessionId.length > 256) throw new AgentServiceError(400, "invalid_request");
      res.json(await service.execution(sessionId));
    } catch (error) { respond(error, res); }
  });
  router.get("/detail", async (req, res) => {
    try {
      const field = (name: string, max: number, optional = false): string | undefined => {
        const value = req.query[name];
        if (value === undefined && optional) return undefined;
        if (typeof value !== "string" || !value.trim() || value.length > max) throw new AgentServiceError(400, "invalid_request");
        return value;
      };
      const revisionText = field("revision", 16)!;
      const revision = Number(revisionText);
      if (!/^(0|[1-9]\d*)$/.test(revisionText) || !Number.isSafeInteger(revision)) throw new AgentServiceError(400, "invalid_request");
      res.json(await service.detail({
        stream_id: field("stream_id", 256)!, revision,
        session_id: field("session_id", 256)!, agent_id: field("agent_id", 8192)!,
        conversation_cursor: field("conversation_cursor", 2048, true),
        workflow_cursor: field("workflow_cursor", 2048, true),
      }));
    } catch (error) { respond(error, res); }
  });
  return router;
}

function respond(error: unknown, res: import("express").Response): void {
  if (error instanceof AgentServiceError) { res.status(error.status).json({ error: error.code }); return; }
  // Never return local transcript paths or provider data in an error response.
  res.status(503).json({ error: "agents_unavailable" });
}
