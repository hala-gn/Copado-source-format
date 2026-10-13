#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

try { require('dotenv').config(); } catch (e) {}

const [,, command, storyId] = process.argv;

const SOURCE_ORG = process.env.SOURCE_ORG || "dev1"; 
const TARGET_ORG = process.env.TARGET_ORG || "qa";        

if (!command || !storyId) {
  console.log("Usage: node copado-hx.js deploy <UserStoryName>");
  process.exit(1);
}

function runShell(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: 'inherit' });
}

function runShellCapture(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

// ─── DEPLOY TRACK ─────────────────────────────────────────────────────────────
if (command === 'deploy') {
  console.log("\n🛫 [copado-hx] Starting deployment execution for: " + storyId);

  // Step 1: Align workspace context
  console.log("\n📌 Step 1: Aligning Agentia tracking workspace context...");
  runShell("agentia cicd work set " + storyId);

  // Step 2: Detect changed files for snapshot verification
  console.log("\n🔍 Step 2: Scanning local branch for tracking metadata deltas...");
  let changedFiles = [];
  try {
    const gitOutput = runShellCapture("git diff --name-only origin/main");
    changedFiles = gitOutput.split('\n').filter(f => f.trim() !== '');
  } catch (err) {}

  // Step 3: Capture snapshot of current QA state safely
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
          console.log("  ✅ Snapshot saved successfully: " + path.basename(filePath));
        }
        
        fs.rmSync(tempProjectDir, { recursive: true, force: true });
      } catch (err) {
        console.log("  ℹ️  Component skipped: Asset does not exist in target QA environment yet.");
      }
    });
  }

  // Step 4: Run 'work done' to trigger the single promotion & deployment instantly
  console.log("\n🔒 Step 4: Finalizing User Story state and initiating single Promotion...");
  let promotionId = "";
  try {
    const outputLog = runShellCapture("agentia cicd work done");
    console.log(outputLog);

    const match = outputLog.match(/promotion_id=([a-zA-Z0-9]{15,18})/i);
    if (match && match) {
      promotionId = match;
    }
  } catch (err) {
    console.error("❌ Failed to complete work done milestone configuration.");
    process.exit(1);
  }

  // Step 5: Real-time Cloud Deployment Status Polling
  console.log("\n🚀 Step 5: Monitoring active deployment tracking logs from Copado Cloud...");
  
  let isRunning = true;
  let checkCount = 0;
  const maxChecks = 60; // 60 checks * 10s sleep = 10 minutes maximum window limit

  while (isRunning && checkCount < maxChecks) {
    try {
      // Pull down the comprehensive text logs from the active work status channel
      const rawStatusText = runShellCapture("agentia cicd work status");
      
      // Clean out the background terminal task headers to look exclusively at the execution results
      const statusBlock = rawStatusText.replace(/Fetching status.*?\.\.\.\s*done/gi, "").trim();

      // Case 1: Detect explicit Active deployment tracks
      if (statusBlock.includes("In Progress") || statusBlock.includes("Running") || statusBlock.includes("Submitting")) {
         console.log("  [Live Update] Deployment Status: IN PROGRESS...");
      } 
      // Case 2: Detect clear cloud failure indicators
      else if (statusBlock.includes("Failed") || statusBlock.includes("Error") || statusBlock.includes("with errors")) {
         console.log("\n❌ STATUS UPDATE: Deployment COMPLETED WITH ERRORS. Review your validation rules.");
         isRunning = false;
         break;
      } 
      // Case 3: Detect clear execution success states
      else if (statusBlock.includes("Success") || statusBlock.includes("Completed") || statusBlock.includes("done")) {
         console.log("\n🎉 STATUS UPDATE: Deployment COMPLETED SUCCESSFULLY in QA!");
         isRunning = false;
         break;
      } 
      // Default: If the buffer is completely empty or transient, consider it processing in the pipe
      else {
         console.log("  [Live Update] Deployment Status: IN PROGRESS...");
      }
    } catch (e) {
      // Protect against transient network drops by assuming it's still running
      console.log("  [Live Update] Deployment Status: IN PROGRESS...");
    }

    if (isRunning) {
      execSync("powershell -Command \"Start-Sleep -s 10\""); // Wait 10 seconds before polling the API again
      checkCount++;
    }
  }

  if (isRunning) {
    console.log("\n⏳ Monitoring timeout window reached. Please verify final results in your browser tab.");
  }
}

// ─── UNDO TRACK ───────────────────────────────────────────────────────────────
else if (command === 'undo') {
  console.log("\n🔄 [copado-hx] Running local headless recovery snapshot for: " + storyId);
  const backupPath = path.join(__dirname, '.rollback', storyId);

  if (fs.existsSync(backupPath)) {
    try {
      runShell("sf project deploy start --source-dir \"" + backupPath + "\" --target-org " + TARGET_ORG);
      console.log("\n✅ Success: Custom local snapshot deployed cleanly to QA.");
    } catch (err) {
      console.error("❌ Snapshot restore run failed.");
    }
  }
}
