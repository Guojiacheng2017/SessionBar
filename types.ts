export type SessionStatus = "idle" | "working" | "blocked" | "error";

export interface SessionPayload {
  session_id: string;    // unique per session, e.g. "vision-dash-40393"
  session_type: string;  // label, e.g. "Claude Code", "Gemini CLI"
  status: SessionStatus;
  task_name: string;
  progress?: number;     // 0.0 ~ 1.0
  context_percent?: number; // 0 ~ 100, when reported by the agent/hook
  tokens?: number;
  turns?: number;
  timestamp: number;
  project?: string;       // project dir basename, e.g. "vision-dash"
  project_path?: string;  // full project dir, e.g. "/Users/…/Vision-Dash"
}
