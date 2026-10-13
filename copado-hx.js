#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

require('dotenv').config();

const [,, command, storyId] = process.argv;

const SOURCE_ORG = process.env.SOURCE_ORG || "HackathonDevOrg";
const TARGET_ORG = process.env.TARGET_ORG || "HackathonQaOrg";

if (!command || !storyId) {
  console.log("Usage:");
  console.log("  node copado-hx.js deploy <UserStoryName>");
  console.log("  node copado-hx.js undo <PromotionName>");
  process.exit(1);
}

function runShell(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: 'inherit' });
}

function runShellCapture(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

// ─── DEPLOY ───────────────────────────────────────────────────────────────────
if (command === 'deploy') {
  console.log("\n🛫 [copado-hx] Starting deployment for: " + storyId);

  // Step 1: Set the user story as the active work item
  console.log("\n📌 Step 1: Setting active work item in Agentia...");
  runShell("agentia cicd work set " + storyId);

  // Step 2: Detect changed files from the feature branch vs main
  console.log("\n🔍 Step 2: Detecting changed components in feature branch...");
  let changedFiles = [];
  try {
    const gitOutput = runShellCapture("git diff --name-only origin/main");
    changedFiles = gitOutput.split('\n').filter(f => f.trim() !== '');
    console.log("Changed files detected:");
    changedFiles.forEach(f => console.log("  - " + f));
  } catch (err) {
    console.log("⚠️  Could not detect changed files via git diff. Proceeding without snapshot.");
  }

  // Step 3: Save snapshot of current QA state before deploying
  if (changedFiles.length > 0) {
    const backupPath = path.join(__dirname, '.rollback', storyId);
    fs.mkdirSync(backupPath, { recursive: true });
    console.log("\n📸 Step 3: Taking snapshot of current QA state into .rollback/" + storyId + "...");

    changedFiles.forEach(function(filePath) {
      try {
        runShell("sf project retrieve start --source-dir \"" + filePath + "\" --target-org " + TARGET_ORG);
        if (fs.existsSync(filePath)) {
          const dest = path.join(backupPath, path.basename(filePath));
          fs.copyFileSync(filePath, dest);
          console.log("  ✅ Snapshot saved: " + path.basename(filePath));
        }
      } catch (err) {
        console.log("  ⚠️  Skipping snapshot for: " + path.basename(filePath) + " (may be new)");
      }
    });
  } else {
    console.log("\n⚠️  Step 3: No changed files found, skipping snapshot.");
  }

  // Step 4: Promote via Agentia CLI (this deploys to QA via Copado pipeline)
  console.log("\n🚀 Step 4: Triggering Agentia promotion to QA...");
  runShell("agentia cicd promote");

  console.log("\n✅ Deployment complete for: " + storyId);
  console.log("💡 To undo this deployment, run:");
  console.log("   node copado-hx.js undo <PromotionName>");
  console.log("   Example: node copado-hx.js undo PR-0045");
}

// ─── UNDO / ROLLBACK ──────────────────────────────────────────────────────────
else if (command === 'undo') {
  const promotionId = storyId;
  console.log("\n🔄 [copado-hx] Triggering back-promotion (rollback) for: " + promotionId);

  // This triggers a Copado back-promotion which reverses the deployment in QA
  // It works the same way as clicking Rollback inside the Copado UI promotion record
  console.log("\n📡 Step 1: Running Agentia back-promotion for " + promotionId + "...");
  try {
    runShell("agentia cicd back-promote " + promotionId);
    console.log("\n✅ Rollback complete. QA has been reverted to its previous state.");
    console.log("   The field/component deployed by " + promotionId + " has been removed from QA.");
  } catch (err) {
    console.log("\n❌ Back-promotion failed. Please check the promotion status in Copado UI.");
    console.log("   You can also trigger rollback manually from the Promotion record in Copado.");
    process.exit(1);
  }
}

// ─── UNKNOWN COMMAND ──────────────────────────────────────────────────────────
else {
  console.log("❌ Unknown command: " + command);
  console.log("Valid commands are: deploy, undo");
  process.exit(1);
}

```
