#!/usr/bin/env tsx
import { FacebookClient } from "../src/facebook/client.js";

const client = new FacebookClient({ chromeProfile: process.env.CHROME_PROFILE });
client.ensureSession().then(() => {
  console.log("Facebook accepted the saved cookies and supplied a Marketplace session token. Search queries still need a separate live test.");
}).catch(error => {
  console.error(error instanceof Error ? error.message : "Session check failed.");
  process.exitCode = 1;
});
