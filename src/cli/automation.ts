#!/usr/bin/env node
import { automationStatus, configureAutomation, AUTOMATED_DAILY_LIMIT } from "../monitoring/control.js";
const action = process.argv[2] ?? "status";
try {
  if (!["status", "enable", "pause", "resume"].includes(action)) throw new Error("Use status, enable, pause or resume.");
  const state = action === "status" ? automationStatus() : await configureAutomation(action as "enable" | "pause" | "resume");
  console.log(JSON.stringify({ ...state, dailyLimit: AUTOMATED_DAILY_LIMIT, note: "These caps reduce unattended activity; they do not guarantee that Facebook will not restrict the account. The timer must also be installed." }, null, 2));
} catch (error) { console.error(error instanceof Error ? error.message : "Automation control failed"); process.exitCode = 1; }
