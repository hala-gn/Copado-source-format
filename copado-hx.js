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

  // Step 3: Capture snapshot of current QA state safely (FIXED SF CLI SYNTAX)
  if (changedFiles.length > 0) {
    const backupPath = path.join(__dirname, '.rollback', storyId);
    fs.mkdirSync(backupPath, { recursive: true });
    console.log("\n📸 Step 3: Extracting snapshot tracking baseline into .rollback/" + storyId + "...");

    changedFiles.forEach(function(filePath) {
      // Basic safeguard: don't snapshot your own script files
      if (filePath.includes('copado-hx.js') || filePath.includes('.env')) return;

      try {
        // FIXED: Create an isolated workspace directory mimicking a clean SF project layout
        const tempProjectDir = path.join(__dirname, '.temp_sf_project_' + Math.random().toString(36).substring(7));
        fs.mkdirSync(path.join(tempProjectDir, 'force-app'), { recursive: true });
        
        // Copy the project file structure metadata so 'sf' accepts it as an isolated environment
        if (fs.existsSync('sfdx-project.json')) {
          fs.copyFileSync('sfdx-project.json', path.join(tempProjectDir, 'sfdx-project.json'));
        }

        // Run retrieve using ONLY --source-dir targeted at our isolated mock folder project
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
        
        // Wipe out the clean temporary folder space
        fs.rmSync(tempProjectDir, { recursive: true, force: true });
      } catch (err) {
        console.log("  ℹ️  Component skipped: Asset does not exist in target QA environment yet.");
      }
    });
  }

  // Step 4: Run 'work done' and capture the live terminal output to extract the true Promotion ID
  console.log("\n🔒 Step 4: Finalizing User Story state and capturing single Promotion ID...");
  let promotionId = "";
  try {
    const outputLog = runShellCapture("agentia cicd work done");
    console.log(outputLog);

    const match = outputLog.match(/promotion_id=([a-zA-Z0-9]{15,18})/i);
    if (match && match[1]) {
      promotionId = match[1];
    }
  } catch (err) {
    console.error("❌ Failed to complete work done milestone configuration.");
    process.exit(1);
  }

  // Step 5: Push promotion and monitor status directly in VS Code
  if (promotionId) {
    console.log("\n🚀 Step 5: Running single Promotion execution [" + promotionId + "] to QA...");
    try {
      // Trigger the promotion run
      runShell("agentia cicd promotion run " + promotionId + " --operation merge_and_deploy -y");
      
      // MONITORING BLOCK: Actively poll the Copado background execution status
      console.log("\n⏳ Monitoring deployment progress live from Copado Cloud API...");
      let isRunning = true;
      let checkCount = 0;

      while (isRunning && checkCount < 30) { // Safety timeout limit after ~5 minutes
        const statusReport = runShellCapture("agentia cicd work status");
        
        if (statusReport.includes("Completed") || statusReport.includes("Success")) {
          console.log("\n🎉 STATUS UPDATE: Deployment COMPLETED SUCCESSFULLY in QA!");
          isRunning = false;
        } else if (statusReport.includes("Failed") || statusReport.includes("Error")) {
          console.log("\n❌ STATUS UPDATE: Deployment FAILED WITH ERRORS. Review validation rules.");
          isRunning = false;
        } else {
          process.stdout.write("."); // Print running dots to show activity
          execSync("powershell -Command \"Start-Sleep -s 10\""); // Wait 10 seconds before polling again
          checkCount++;
        }
      }
    } catch (err) {
      console.error("❌ Promotion pipeline deployment run failed.");
      process.exit(1);
    }
  } else {
    console.error("\n❌ Critical Failure: Could not catch the auto-generated Promotion ID from Step 4.");
    process.exit(1);
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
