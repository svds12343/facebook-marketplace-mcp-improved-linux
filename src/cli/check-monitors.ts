#!/usr/bin/env node
import { FacebookClient } from "../facebook/client.js";
import { runChecks } from "../monitoring/runner.js";
import { automationStatus, AUTOMATED_DAILY_LIMIT } from "../monitoring/control.js";
import { BusyError } from "../storage/state.js";

try {
  const control = automationStatus();
  if (!control.enabled || control.pausedReason || control.requests >= AUTOMATED_DAILY_LIMIT) {
    console.log(JSON.stringify({ skipped: true, reason: !control.enabled ? "disabled" : control.pausedReason || "daily request cap", requestsToday: control.requests }));
    process.exit(0);
  }
  const requestBudget = Number(process.env.FB_MONITOR_REQUEST_BUDGET ?? 6);
  if (!Number.isInteger(requestBudget) || requestBudget < 1 || requestBudget > 6) throw new Error("FB_MONITOR_REQUEST_BUDGET must be an integer from 1 to 6.");
  const report = await runChecks(new FacebookClient({ maxRequestsPerMinute: 3, automated: true, chromeProfile: process.env.CHROME_PROFILE ?? "Default" }), { requestBudget });
  // Avoid placing listing contents or session information in the systemd journal.
  console.log(JSON.stringify({ checkedSearches: report.monitors.length, checkedWatches: report.watched.length,
    requestsUsed: report.requestsUsed, unreadAlerts: report.unreadAlerts, deferredSearches: report.monitorsDeferred,
    deferredWatches: report.watchesDeferred, failedSearches: report.monitors.filter(m => m.errors.length).map(m => m.name),
    partialSearches: report.monitors.filter(m => m.coverage !== "complete").map(m => ({ name: m.name, coverage: m.coverage })) }));
  if (report.monitors.some(m => m.errors.length) || report.watched.some(w => !w.ok)) process.exitCode = 1;
} catch (error) {
  if (error instanceof BusyError) console.log("Another monitor check is active; this scheduled run was skipped.");
  else { console.error(error instanceof Error ? error.message : "Monitor run failed"); process.exitCode = 1; }
}
