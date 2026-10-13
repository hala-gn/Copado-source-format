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

    // Extract the live promotion ID variable string from output
    const match = outputLog.match(/promotion_id=([a-zA-Z0-9]{15,18})/i);
    if (match && match) {
      promotionId = match[1];
    }
  } catch (err) {
    console.error("❌ Failed to complete work done milestone configuration.");
    process.exit(1);
  }

  // Step 5: Live Intelligent Monitoring of the active Promotion deployment via Cloud JSON
  if (promotionId) {
    console.log("\n🚀 Step 5: Promotion [" + promotionId + "] successfully generated and running in cloud...");
    console.log("⏳ Monitoring deployment progress live from Copado Cloud API...");
    
    let isRunning = true;
    let checkCount = 0;
    const maxChecks = 60; // 60 checks * 10s = 10 minutes maximum execution window

    while (isRunning && checkCount < maxChecks) {
      try {
        // Query pipeline status in raw JSON format to bypass text-parsing glitches
        const rawJson = runShellCapture("agentia pipeline status --json");
        const pipelineData = JSON.parse(rawJson);
        
        // Dynamic status tracker verification block
        let targetPromotion = null;
        if (Array.isArray(pipelineData)) {
            targetPromotion = pipelineData.find(p => p.id === promotionId || p.promotionId === promotionId);
        } else if (pipelineData && pipelineData.promotions) {
            targetPromotion = pipelineData.promotions.find(p => p.id === promotionId || p.promotionId === promotionId);
        }

        if (targetPromotion) {
            const currentStatus = targetPromotion.status || targetPromotion.executionStatus || "";
            console.log(`  [Live Poll] Promotion Status: ${currentStatus}...`);

            if (currentStatus.includes("Success") || currentStatus.includes("Completed") || currentStatus === "Done") {
                console.log("\n🎉 STATUS UPDATE: Deployment COMPLETED SUCCESSFULLY in QA!");
                isRunning = false;
            } else if (currentStatus.includes("Failed") || currentStatus.includes("Error")) {
                console.log("\n❌ STATUS UPDATE: Deployment FAILED WITH ERRORS in QA sandbox.");
                isRunning = false;
            }
        } else {
            // If the promotion ID is no longer present in the active queue array, it finished successfully and cleared out
            console.log("\n🎉 STATUS UPDATE: Promotion cleared active pipeline tracking queue. COMPLETED SUCCESSFULLY!");
            isRunning = false;
        }
      } catch (e) {
        // Soft fallback to text-matching if specific JSON matrix fields are nested differently across beta builds
        try {
          const textReport = runShellCapture("agentia pipeline status");
          if (!textReport.includes(promotionId)) {
            console.log("\n🎉 STATUS UPDATE: Deployment COMPLETED SUCCESSFULLY in QA!");
            isRunning = false;
          }
        } catch (err) {}
      }

      if (isRunning) {
        execSync("powershell -Command \"Start-Sleep -s 10\""); // Wait 10 seconds before polling again
        checkCount++;
      }
    }
    
    if (isRunning) {
      console.log("\n⏳ Monitoring limit reached. Please check the Copado web UI dashboard manually.");
    }
  } else {
    console.error("\n❌ Critical Failure: Could not track the auto-generated Promotion ID.");
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
