import { sampleData } from "./sampleData.mjs";
import { runLandingMenu } from "../../dist/cli/landingMenu.js";
import { runOpenTuiMonitor } from "../../dist/tui/openTuiMonitor.js";
import { age, agentName } from "../../dist/tui/displayUtils.js";

const data = sampleData();
const port = Number(process.env.SESSIONBAR_PREVIEW_PORT);
if (!Number.isInteger(port) || port <= 0) throw new Error("Missing preview port");

if (process.argv[2] === "landing") {
  await runLandingMenu({
    tty: true, colorEnabled: true, formatAge: age, agentName,
    projectLabel: s => s.project,
    statusShort: status => ({ working: "WORK", blocked: "WAIT", idle: "IDLE", error: "ERROR" })[status],
    statusStyle: status => ({
      c: status === "working" ? "\x1b[34m" : status === "blocked" ? "\x1b[33m" : "\x1b[32m",
      icon: status === "idle" ? "○" : "●", label: status,
    }),
    ensureAppRunning: async () => true, fetchSessions: async () => ({ sessions: data.sessions }),
    fetchWebStatus: async () => true, pidAlive: () => true, getPort: () => port,
    launchMonitor: async () => {}, launchSetup: async () => {}, launchStatus: async () => {},
    launchSettings: async () => {}, launchWeb: async () => {}, teardownHooks: async () => {},
  });
} else {
  await runOpenTuiMonitor({
    fetchSessions: async () => ({ sessions: data.sessions }),
    fetchSystem: async () => data.system, fetchProviders: async () => data.providers,
    openWebDashboard: async () => {}, renderMs: 500, pollMs: 1000, animate: false,
    port, apiHost: "127.0.0.1", stateDir: "~/.sessionbar", closeTransport: () => {},
  });
}
