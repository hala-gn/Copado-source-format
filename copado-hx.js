#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Safe validation framework: skip gracefully if dotenv is missing in the hackathon workspace
try { require('dotenv').config(); } catch (e) {}

const [,, command, storyId] = process.argv;

const SOURCE_ORG = process.env.SOURCE_ORG || "dev1";
const TARGET_ORG = process.env.TARGET_ORG || "qa";

if (!command || !storyId) {
  console.log("====================================================================");
  console.log("ERROR: Missing execution parameters.");
  console.log("Usage:");
  console.log("  node copado-hx.js deploy <UserStoryName>  -> Run Headless Snapshot Release");
  console.log("  node copado-hx.js undo <UserStoryName>    -> Trigger Local Automated Rollback");
  console.log("====================================================================");
  process.exit(1);
}

function runShell(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: 'inherit' });
}

function runShellCapture(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

// ─── PROMOTION STATUS DISPLAY HELPER ──────────────────────────────────────────
// Uses the official Copado CLI command: sf copado job status -i <jobExecutionId> --json
// This returns the same jobStatus + per-step statuses shown in the Copado UI.
function printPromotionStatus(jobExecutionId) {
  if (!jobExecutionId) {
    console.log("  [Status] No Job Execution ID captured. Cannot query precise status.");
    return null;
  }

  let statusObj = null;
  try {
    const rawJson = runShellCapture(`sf copado job status -i ${jobExecutionId} --json`);
    statusObj = JSON.parse(rawJson);
  } catch (err) {
    console.log("  [Status] Could not retrieve job status via Copado CLI:", err.message);
    return null;
  }

  const jobStatus = (statusObj.jobStatus || statusObj.status || "UNKNOWN").toUpperCase();
  const steps     = Array.isArray(statusObj.steps) ? statusObj.steps : [];

  console.log("\n--------------------------------------------------------------------");
  console.log(`  JOB EXECUTION ID : ${jobExecutionId}`);
  console.log(`  OVERALL STATUS   : ${jobStatus}`);

  if (steps.length > 0) {
    console.log("  STEP-BY-STEP BREAKDOWN (mirrors Copado UI):");
    steps.forEach((step, idx) => {
      const stepName   = step.name || step.apiName || `Step ${idx + 1}`;
      const stepStatus = (step.status || "UNKNOWN").toUpperCase();
      const stepIcon   = stepStatus.includes("SUCCESS") || stepStatus.includes("COMPLET") ? "OK"
                       : stepStatus.includes("FAIL")    || stepStatus.includes("ERROR")   ? "FAIL"
                       : stepStatus.includes("SKIP")                                       ? "SKIP"
                       : "....";
      console.log(`    [${stepIcon}] ${stepName.padEnd(40)} -> ${stepStatus}`);
    });
  } else {
    console.log("  (No individual step data returned by the CLI for this execution.)");
  }
  console.log("--------------------------------------------------------------------\n");

  return jobStatus;
}

// ─── PART 1: THE HEADLESS DEPLOYMENT & AUTO-SNAPSHOT ENGINE ───────────────────
if (command === 'deploy') {
  console.log("\n====================================================================");
  console.log("[copado-hx] INITIATING HEADLESS METADATA AUTOMATION ROUTINE");
  console.log("====================================================================");

  // Step 1: Bind workspace tracking context
  console.log("\nStep 1: Aligning Agentia tracking workspace context...");
  runShell("agentia cicd work set " + storyId);

  // Step 2: Track code changes vs main
  console.log("\nStep 2: Scanning local branch for tracking metadata deltas...");
  let changedFiles = [];
  try {
    const gitOutput = runShellCapture("git diff --name-only origin/main");
    changedFiles = gitOutput.split('\n').filter(f => f.trim() !== '');
  } catch (err) {
    console.log("  Git diff trace unavailable. Proceeding with clean tracking array.");
  }

  // Step 3: Take Client-Side Safety Backup Snapshot from QA
  if (changedFiles.length > 0) {
    const backupPath = path.join(__dirname, '.rollback', storyId);
    fs.mkdirSync(backupPath, { recursive: true });
    console.log(`\nStep 3: Extracting snapshot tracking baseline into .rollback/${storyId}...`);

    changedFiles.forEach(function(filePath) {
      if (filePath.includes('copado-hx.js') || filePath.includes('.env')) return;

      try {
        const tempProjectDir = path.join(__dirname, '.temp_sf_project_' + Math.random().toString(36).substring(7));
        fs.mkdirSync(path.join(tempProjectDir, 'force-app'), { recursive: true });

        if (fs.existsSync('sfdx-project.json')) {
          fs.copyFileSync('sfdx-project.json', path.join(tempProjectDir, 'sfdx-project.json'));
        }

        execSync(`sf project retrieve start --source-dir "${filePath}" --target-org ${TARGET_ORG}`, {
          cwd: tempProjectDir,
          encoding: 'utf8',
          stdio: 'pipe'
        });

        const pulledFilePath = path.join(tempProjectDir, filePath);
        if (fs.existsSync(pulledFilePath)) {
          const dest = path.join(backupPath, path.basename(filePath));
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(pulledFilePath, dest);
          console.log("  Pre-deployment snapshot stored: " + path.basename(filePath));
        }
        fs.rmSync(tempProjectDir, { recursive: true, force: true });
      } catch (err) {
        console.log("  Component doesn't exist in QA yet. Skipping snapshot for: " + path.basename(filePath));
      }
    });
  } else {
    console.log("\nStep 3: No changed components detected. Skipping snapshot phase.");
  }

  // Step 4: Run 'work done' to finalize user story and initiate cloud deployment
  console.log("\nStep 4: Finalizing User Story state and initiating Promotion...");
  let promotionId    = "";
  let jobExecutionId = "";

  try {
    const outputLog = runShellCapture("agentia cicd work done");
    console.log(outputLog);

    // Extract IDs from the work done output
    const promoMatch = outputLog.match(/promotion_id=([a-zA-Z0-9]{15,18})/i);
    if (promoMatch && promoMatch[1]) promotionId = promoMatch[1];

    const jobMatch = outputLog.match(/job_execution_id=([a-zA-Z0-9]{15,18})/i);
    if (jobMatch && jobMatch[1]) jobExecutionId = jobMatch[1];

    // Fallback: also try to parse as JSON in case agentia outputs JSON
    if (!jobExecutionId) {
      try {
        const parsed = JSON.parse(outputLog);
        jobExecutionId = parsed.jobExecutionId || parsed.job_execution_id || parsed.jobExecution?.id || "";
        promotionId    = promotionId || parsed.promotionId || parsed.promotion_id || parsed.promotion?.id || "";
      } catch (_) { /* not JSON, that is fine */ }
    }
  } catch (err) {
    console.error("Critical Failure during work serialization milestone execution.");
    process.exit(1);
  }

  if (promotionId)    console.log(`\n  Promotion ID      : ${promotionId}`);
  if (jobExecutionId) console.log(`  Job Execution ID  : ${jobExecutionId}`);

  // Step 5: Precise Promotion Status Polling using sf copado job status
  // This is the same data source the Copado UI reads, so statuses will match exactly.
  console.log("\nStep 5: Polling promotion status via Copado CLI (sf copado job status)...");
  console.log("        This mirrors the exact status shown in the Copado UI.\n");

  let isRunning  = true;
  let checkCount = 0;
  const maxChecks = 60;

  while (isRunning && checkCount < maxChecks) {
    const jobStatus = printPromotionStatus(jobExecutionId);

    if (jobStatus === null) {
      // CLI query failed; fall back to generic work status for this tick only
      try {
        const fallback = runShellCapture("agentia cicd work status");
        console.log("  [Fallback] Generic work status:", fallback.split('\n')[0]);
      } catch (_) {}
    }

    if (jobStatus && (
      jobStatus.includes("SUCCESS") ||
      jobStatus.includes("COMPLET") ||
      jobStatus.includes("SUCCESSFUL")
    )) {
      console.log("DEPLOYMENT COMPLETED SUCCESSFULLY in QA environment!");
      isRunning = false;
      break;
    }

    if (jobStatus && (
      jobStatus.includes("FAIL") ||
      jobStatus.includes("ERROR") ||
      jobStatus.includes("CONFLICT")
    )) {
      console.log("DEPLOYMENT FAILED WITH ERRORS. Review your validation constraints.");
      isRunning = false;
      break;
    }

    if (isRunning) {
      console.log(`  [Tick ${checkCount + 1}/${maxChecks}] Status still IN PROGRESS. Waiting 12s...\n`);
      execSync("powershell -Command \"Start-Sleep -s 12\"");
      checkCount++;
    }
  }

  if (isRunning) {
    console.log("\nPolling window closed. Run the command below to check the final status manually:");
    if (jobExecutionId) {
      console.log(`  sf copado job status -i ${jobExecutionId} --json`);
    }
    console.log("Or open the Promotion record in the Copado UI.");
  }
}

// ─── PART 2: THE EMERGENCY RECOVERY ROLLBACK ENGINE ───────────────────────────
else if (command === 'undo') {
  console.log("\n====================================================================");
  console.log("[copado-hx] INITIATING AGENTIC SNAPSHOT ROLLBACK RECOVERY");
  console.log("====================================================================");

  const backupPath = path.join(__dirname, '.rollback', storyId);

  if (fs.existsSync(backupPath)) {
    console.log(`\nStep 1: Extracting local baseline snapshots from .rollback/${storyId}`);
    console.log(`Force-deploying historical manifests back into target sandbox [${TARGET_ORG}]...`);
    try {
      runShell(`sf project deploy start --source-dir "${backupPath}" --target-org ${TARGET_ORG}`);
      console.log("\n====================================================================");
      console.log("SUCCESS: TARGET SANDBOX ENVIRONMENT SUCCESSFULLY ROLLED BACK!");
      console.log("====================================================================");
    } catch (err) {
      console.error("\nCritical Failure: Local snapshot deployment recovery failed.");
      process.exit(1);
    }
  } else {
    console.log(`\nExecution Stopped: No local backup snapshot found for work item: ${storyId}`);
    console.log("Verify that a successful deployment script run completed before calling undo.");
    process.exit(1);
  }
}
