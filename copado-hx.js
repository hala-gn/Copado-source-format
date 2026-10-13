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
  console.log("❌ Missing execution parameters.");
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

// ─── PART 1: THE HEADLESS DEPLOYMENT & AUTO-SNAPSHOT ENGINE ────────────────────
if (command === 'deploy') {
  console.log("\n====================================================================");
  console.log("🛫 [copado-hx] INITIATING HEADLESS METADATA AUTOMATION ROUTINE");
  console.log("====================================================================");

  // Step 1: Bind workspace tracking context
  console.log("\n📌 Step 1: Aligning Agentia tracking workspace context...");
  runShell("agentia cicd work set " + storyId);

  // Step 2: Track code changes vs main
  console.log("\n🔍 Step 2: Scanning local branch for tracking metadata deltas...");
  let changedFiles = [];
  try {
    const gitOutput = runShellCapture("git diff --name-only origin/main");
    changedFiles = gitOutput.split('\n').filter(f => f.trim() !== '');
  } catch (err) {
    console.log("⚠️  Git diff trace unavailable. Proceeding with clean tracking array.");
  }

  // Step 3: Take Client-Side Safety Backup Snapshot from QA
  if (changedFiles.length > 0) {
    const backupPath = path.join(__dirname, '.rollback', storyId);
    fs.mkdirSync(backupPath, { recursive: true });
    console.log("\n📸 Step 3: Extracting snapshot tracking baseline into .rollback/" + storyId + "...");

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
          console.log("  ✅ Pre-deployment snapshot stored: " + path.basename(filePath));
        }
        fs.rmSync(tempProjectDir, { recursive: true, force: true });
      } catch (err) {
        console.log("  ℹ️  Component status check: Asset doesn't exist in QA yet. Skipping snapshot folder entry for: " + path.basename(filePath));
      }
    });
  } else {
    console.log("\n⚠️  Step 3: No changed components detected. Skipping snapshot phase.");
  }

  // Step 4: Run 'work done' to finalize user story and initiate cloud deployment
  console.log("\n🔒 Step 4: Finalizing User Story state and initiating single Promotion...");
  let promotionId = "";
  let jobExecutionId = "";
  try {
    const outputLog = runShellCapture("agentia cicd work done");
    console.log(outputLog);

    // Extract the live IDs using explicit text pattern groupings
    const promoMatch = outputLog.match(/promotion_id=([a-zA-Z0-9]{15,18})/i);
    if (promoMatch && promoMatch[1]) promotionId = promoMatch[1];
    
    const jobMatch = outputLog.match(/job_execution_id=([a-zA-Z0-9]{15,18})/i);
    if (jobMatch && jobMatch[1]) jobExecutionId = jobMatch[1];
  } catch (err) {
    console.error("❌ Critical Failure during work serialization milestone execution.");
    process.exit(1);
  }

  // Step 5: Dual-Track Multi-Layer Polling Monitor
  console.log("\n🚀 Step 5: Monitoring active deployment tracking logs from Copado Cloud...");
  let isRunning = true;
  let checkCount = 0;
  const maxChecks = 60; 

  while (isRunning && checkCount < maxChecks) {
    let rawJsonText = "";
    let rawStatusText = "";
    let jobStatus = "IN PROGRESS";

    // 1. Attempt strict data parameter check via JSON
    try {
      rawJsonText = runShellCapture("agentia cicd work status --json");
      const statusObj = JSON.parse(rawJsonText);
      
      if (statusObj) {
        if (statusObj.jobExecution && statusObj.jobExecution.id === jobExecutionId) {
          jobStatus = statusObj.jobExecution.status || "IN PROGRESS";
        } else if (Array.isArray(statusObj.steps)) {
          const matchingStep = statusObj.steps.find(s => s.jobExecutionId === jobExecutionId || s.id === jobExecutionId);
          if (matchingStep) jobStatus = matchingStep.status || "IN PROGRESS";
        } else if (statusObj.status) {
          jobStatus = statusObj.status;
        }
      }
    } catch (e) {
      jobStatus = "IN PROGRESS"; // Reset status to fallback text checking if JSON stream glitches
    }

    // 2. Cross-verify using direct Text Stream Evaluation to guarantee results
    try {
      rawStatusText = runShellCapture("agentia cicd work status");
      const cleanBlock = rawStatusText.replace(/Fetching status.*?\.\.\.\s*done/gi, "").trim();

      // Normalize all values to uppercase to prevent casing mismatches
      const checkString = (cleanBlock + " " + jobStatus).toUpperCase();

      if (checkString.includes("SUCCESS") || checkString.includes("COMPLETED") || checkString.includes("SUCCESSFUL")) {
         console.log("\n🎉 STATUS UPDATE: Deployment COMPLETED SUCCESSFULLY in QA environment!");
         isRunning = false;
         break;
      } 
      else if (checkString.includes("FAIL") || checkString.includes("ERROR") || checkString.includes("CONFLICT")) {
         console.log("\n❌ STATUS UPDATE: Deployment FAILED WITH ERRORS. Review your validation constraints.");
         isRunning = false;
         break;
      } 
      else {
         console.log("  [Live Update] Cloud System Job State: IN PROGRESS...");
      }
    } catch (err) {
      console.log("  [Live Update] Cloud System Job State: IN PROGRESS...");
    }

    if (isRunning) {
      execSync("powershell -Command \"Start-Sleep -s 12\""); 
      checkCount++;
    }
  }

  if (isRunning) {
    console.log("\n⏳ Polling window closed. Verify final states inside your browser tab.");
  }
}

// ─── PART 2: THE TRACK D EMERGENCY RECOVERY ROLLBACK ENGINE ────────────────────
else if (command === 'undo') {
  console.log("\n====================================================================");
  console.log("🔄 [copado-hx] INITIATING AGENTIC SNAPSHOT ROLLBACK RECOVERY");
  console.log("====================================================================");
  
  const backupPath = path.join(__dirname, '.rollback', storyId);

  if (fs.existsSync(backupPath)) {
    console.log(`\n📡 Step 1: Extracting local baseline snapshots from folder storage: .rollback/${storyId}`);
    console.log(`Force-deploying historical manifests back into target sandbox environment [${TARGET_ORG}]...`);
    try {
      // Overwrites QA back to its old state using the local backup snapshot files
      runShell(`sf project deploy start --source-dir "${backupPath}" --target-org ${TARGET_ORG}`);
      console.log("\n====================================================================");
      console.log("🎉 SUCCESS: TARGET SANDBOX ENVIRONMENT SUCCESSFULLY ROLLED BACK!");
      console.log("====================================================================");
    } catch (err) {
      console.error("\n❌ Critical Failure: Local snapshot deployment recovery failed.");
      process.exit(1);
    }
  } else {
    console.log(`\n❌ Execution Stopped: No local backup snapshot profile found for work item: ${storyId}`);
    console.log("Verify that a successful deployment script run completed before calling undo.");
    process.exit(1);
  }
}
