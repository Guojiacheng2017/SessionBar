// Synthetic documentation data only; never read account files or user projects.
// 仅用于文档的模拟数据，不读取账户文件或用户项目。
export function sampleData(now = Date.now()) {
  const sessions = [
    ["Codex", "atlas", "Implement search indexing", "working", 38],
    ["Claude Code", "atlas", "Review API pagination", "blocked", 64],
    ["Gemini CLI", "docs", "Update installation examples", "working", 22],
    ["Copilot", "docs", "Check link validation", "idle", 17],
    ["Claude Desktop", "workspace", "Plan release checklist", "idle", 41],
    ["WorkBuddy Desktop", "workspace", "Review desktop integration", "idle", undefined],
  ].map(([session_type, project, task_name, status, context_percent], index) => ({
    session_id: `demo-session-${index + 1}__${project}`,
    session_type, project, task_name, session_name: task_name, status, context_percent,
    project_path: `/demo/projects/${project}`,
    source: session_type === "Claude Desktop" ? "filesystem_snapshot"
      : session_type === "WorkBuddy Desktop" ? "filesystem_registry" : "hook",
    timestamp: now - (index + 1) * 12_000,
    tokens: (index + 1) * 24_000, turns: index + 3,
    activity_tail: ["Read project configuration", status === "working" ? "Run focused tests" : "Waiting for the next task"],
  }));
  const system = {
    cpu_percent: 18.4, load_average: [1.24, 1.18, 1.09],
    memory_used_bytes: 8.6 * 1024 ** 3, memory_total_bytes: 16 * 1024 ** 3,
    memory_percent: 53.8, server_cpu_percent: 0.7, server_memory_bytes: 72 * 1024 ** 2,
    network_down_bytes_per_second: 124 * 1024, network_up_bytes_per_second: 18 * 1024,
    device_temperature_celsius: 42.5, battery_temperature_celsius: 29.4, sampled_at: now,
  };
  const points = [128_000, 184_000, 146_000, 221_000, 196_000, 158_000, 174_000];
  const provider = (name, form, label, remaining, unit, limit, multiplier = 1) => ({
    provider: name, form, label, remaining, unit, limit,
    used: limit === undefined ? undefined : limit - remaining,
    level: "green", pacing: form === "subscription" ? "Within quota" : "Balance available",
    measuredRateLabel: "1.2%/h", cardTiming: "", autoResetIn: form === "subscription" ? "2h 40m" : "",
    sustainableRate: 3.5, actualVsSustainable: null, projectedCapHitAt: null,
    lastSeenAt: now, stale: false,
    usageTrend: { kind: "bars", days: 7, points: points.map(n => n * multiplier), unit: "tokens", source: "Demo fixture" },
    usageTrends: { token: { kind: "bars", days: 7, points: points.map(n => n * multiplier), unit: "tokens", source: "Demo fixture" } },
  });
  const providers = [
    provider("openai", "subscription", "OpenAI Subscription", 78, "%", 100),
    provider("anthropic", "subscription", "Anthropic 5h", 64, "%", 100, 0.8),
    provider("github", "subscription", "GitHub Copilot", 82, "%", 100, 0.35),
    provider("deepseek", "api", "DeepSeek API", 24.5, "CNY", undefined, 0.6),
    provider("kimi", "api", "Kimi API", 36, "CNY", undefined, 0.4),
    provider("workbuddy", "api", "WorkBuddy Desktop", undefined, "credits", undefined, 0.2),
  ];
  return { sessions, providers, system };
}
