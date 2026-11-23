#!/usr/bin/env node
import { parseArgs } from "node:util";
import { activityStatus, configureActivity, pauseActivity, resumeActivity } from "../activity/control.js";

try {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    reviewed: { type: "boolean" }, "daily-limit": { type: "string" }, "image-limit": { type: "string" }, "interval-seconds": { type: "string" },
  } });
  const action = positionals[0] ?? "status";
  if (positionals.length > 1) throw new Error("Supply one action: status, pause, resume or configure.");
  if (action === "pause") await pauseActivity();
  else if (action === "resume") await resumeActivity(values.reviewed === true);
  else if (action === "configure") {
    const current = await activityStatus();
    await configureActivity({ authenticatedPer24Hours: Number(values["daily-limit"] ?? current.authenticated.limit),
      imagesPer24Hours: Number(values["image-limit"] ?? current.images.limit),
      minimumIntervalSeconds: Number(values["interval-seconds"] ?? current.minimumIntervalSeconds) });
  } else if (action !== "status") throw new Error("Use status, pause, resume --reviewed or configure --daily-limit N --image-limit N --interval-seconds N.");
  console.log(JSON.stringify(await activityStatus(), null, 2));
} catch (error) { console.error(error instanceof Error ? error.message : "Activity control failed."); process.exitCode = 1; }
