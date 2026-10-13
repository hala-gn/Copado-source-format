#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

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
// Official Copado CLI command per docs: sf copado job status --jobid <id> --json
// Official response fields: jobStatus (string), steps (array of JobStep__c)
function printPromotionStatus(jobExecutionId) {
  if (!jobExecutionId) {
    console.log("  [Status] No Job Execution ID captured. Cannot query precise status.");
    return null;
  }

  let parsed = null;
  try {
    // --jobid is the correct flag name per Copado CLI docs
    const rawJson = runShellCapture(`sf copado job status --jobid ${jobExecutionId} --json`);
    parsed = JSON.parse(rawJson);
  } catch (err) {
    console.log("  [Status] CLI query failed:", err.message);
    return null;
  }

  // Copado returns "jobStatus" at the top level per the Jobs Domain docs
  const jobStatus = (parsed.jobStatus || parsed.status || "UNKNOWN").toUpperCase();
  const steps     = Array.isArray(parsed.steps) ? parsed.steps : [];

  console.log("--------------------------------------------------------------------");
  console.log(`  JOB EXECUTION ID : ${jobExecutionId}`);
  console.log(`  OVERALL STATUS   : ${jobStatus}`);

  if (steps.length > 0) {
    console.log("  STEP BREAKDOWN (mirrors Copado UI):");
    steps.forEach((step, idx) => {
      const name   = (step.Name || step.name || step.apiName || `Step ${idx + 1}`).padEnd(40);
      const status = (step.copado__Status__c || step.status || "UNKNOWN").toUpperCase();
      const icon   = status.includes("SUCCESSFUL") || status.includes("SUCCESS") || status.includes("COMPLET") ? " OK "
                   : status.includes("FAIL")        || status.includes("ERROR")                                ? "FAIL"
                   : status.includes("SKIP")                                                                   ? "SKIP"
                   : "....";
      console.log(`    [${icon}] ${name} -> ${status}`);
    });
  } else {
    console.log("  (No step data returned for this execution yet.)");
  }
  console.log("--------------------------------------------------------------------\n");

  return jobStatus;
}

// ─── PART 1: HEADLESS DEPLOYMENT & AUTO-SNAPSHOT ENGINE ───────────────────────
if (command === 'deploy') {

  console.log("\n====================================================================");
  console.log("[copado-hx] INITIATING HEADLESS METADATA AUTOMATION ROUTINE");
  console.log("====================================================================");

  // Step 1: Bind workspace tracking context
  console.log("\nStep 1: Aligning Agentia tracking workspace context...");
  runShell("agentia cicd work set " + storyId);

  // Step 2: Track code changes vs main
  console.log("\nStep 2: Scanning local branch for metadata deltas...");
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
    console.log(`\nStep 3: Extracting snapshot baseline into .rollback/${storyId}...`);

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
        console.log("  Component not in QA yet. Skipping snapshot for: " + path.basename(filePath));
      }
    });
  } else {
    console.log("\nStep 3: No changed components detected. Skipping snapshot phase.");
  }

  // Step 4: Submit user story with --wait so the CLI blocks until the job finishes.
  // This is the most reliable approach per Copado docs: no manual polling needed.
  // sf copado story submit --promote --deploy --wait --json
  console.log("\nStep 4: Submitting User Story for Promotion and Deployment...");
  console.log("        Using --wait flag: CLI will block until the job completes.");
  console.log("        Status updates will appear below in real time.\n");

  let jobExecutionId = "";
  let promotionId    = "";
  let finalStatus    = "";

  try {
    const submitOutput = runShellCapture("sf copado story submit --promote --deploy --wait --json");
    console.log("\n  Raw CLI response received.");

    try {
      const parsed   = JSON.parse(submitOutput);
      jobExecutionId = parsed.jobExecutionId
                    || parsed.job_execution_id
                    || (parsed.jobExecution && parsed.jobExecution.id)
                    || (parsed.result && parsed.result.jobExecutionId)
                    || "";
      promotionId    = parsed.promotionId
                    || parsed.promotion_id
                    || (parsed.promotion && parsed.promotion.id)
                    || (parsed.result && parsed.result.promotionId)
                    || "";
      finalStatus    = (parsed.jobStatus || parsed.status || "").toUpperCase();
    } catch (_) {
      // Not JSON: try plain text ID extraction as fallback
      const jobMatch   = submitOutput.match(/job_execution_id=([a-zA-Z0-9]{15,18})/i)
                      || submitOutput.match(/jobExecutionId[:\s]+([a-zA-Z0-9]{15,18})/i);
      const promoMatch = submitOutput.match(/promotion_id=([a-zA-Z0-9]{15,18})/i)
                      || submitOutput.match(/promotionId[:\s]+([a-zA-Z0-9]{15,18})/i);
      if (jobMatch)   jobExecutionId = jobMatch[1];
      if (promoMatch) promotionId    = promoMatch[1];
    }

    if (promotionId)    console.log(`  Promotion ID      : ${promotionId}`);
    if (jobExecutionId) console.log(`  Job Execution ID  : ${jobExecutionId}`);

  } catch (err) {
    console.error("\nCritical Failure: story submit command failed.");
    console.error(err.message);
    process.exit(1);
  }

  // Step 5: If --wait returned a terminal status, display it directly.
  // If not (older CLI versions may not support --wait), fall back to polling.
  const TERMINAL_STATES = ["SUCCESSFUL", "SUCCESS", "COMPLETED", "FAILED", "ERROR", "CANCELLED"];

  if (finalStatus && TERMINAL_STATES.some(s => finalStatus.includes(s))) {
    // --wait worked: status is already terminal
    console.log("\nStep 5: Final status received directly from CLI (--wait mode).");
    printPromotionStatus(jobExecutionId);

    if (finalStatus.includes("FAIL") || finalStatus.includes("ERROR") || finalStatus.includes("CANCEL")) {
      console.log("DEPLOYMENT FAILED OR CANCELLED. Review your validation constraints.");
    } else {
      console.log("DEPLOYMENT COMPLETED SUCCESSFULLY in QA environment!");
    }

  } else {
    // --wait not supported or status not yet terminal: fall back to polling loop
    console.log("\nStep 5: --wait did not return a terminal status. Falling back to polling...\n");

    let isRunning  = true;
    let checkCount = 0;
    const maxChecks = 60;

    while (isRunning && checkCount < maxChecks) {
      const polledStatus = printPromotionStatus(jobExecutionId);

      if (polledStatus && TERMINAL_STATES.some(s => polledStatus.includes(s))) {
        if (polledStatus.includes("FAIL") || polledStatus.includes("ERROR") || polledStatus.includes("CANCEL")) {
          console.log("DEPLOYMENT FAILED OR CANCELLED. Review your validation constraints.");
        } else {
          console.log("DEPLOYMENT COMPLETED SUCCESSFULLY in QA environment!");
        }
        isRunning = false;
        break;
      }

      console.log(`  [Tick ${checkCount + 1}/${maxChecks}] Still IN PROGRESS. Waiting 12s...\n`);
      execSync("powershell -Command \"Start-Sleep -s 12\"");
      checkCount++;
    }

    if (isRunning) {
      console.log("\nPolling window closed before a terminal status was reached.");
      if (jobExecutionId) {
        console.log("Check the final status manually with:");
        console.log(`  sf copado job status --jobid ${jobExecutionId} --json`);
      }
    }
  }

// ─── PART 2: EMERGENCY RECOVERY ROLLBACK ENGINE ───────────────────────────────
} else if (command === 'undo') {

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

} else {
  console.log(`\nUnknown command: "${command}". Use "deploy" or "undo".`);
  process.exit(1);
}
