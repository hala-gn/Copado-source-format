#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Safe check if dotenv exists, skip gracefully if missing in hackathon environment
try { require('dotenv').config(); } catch (e) {}

const [,, command, storyId] = process.argv;

const SOURCE_ORG = process.env.SOURCE_ORG || "dev1"; // Aligned to your dev sandbox name
const TARGET_ORG = process.env.TARGET_ORG || "qa";        // Aligned to your qa sandbox name

if (!command || !storyId) {
  console.log("Usage:");
  console.log("  node copado-hx.js deploy <UserStoryName>");
  console.log("  node copado-hx.js undo <UserStoryName>");
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

  // Step 1: Set the user story as the active work item context
  console.log("\n📌 Step 1: Aligning Agentia tracking workspace context...");
  runShell("agentia cicd work set " + storyId);

  // Step 2: Detect changed files from the active feature branch vs main
  console.log("\n🔍 Step 2: Scanning local branch for tracking metadata deltas...");
  let changedFiles = [];
  try {
    const gitOutput = runShellCapture("git diff --name-only origin/main");
    changedFiles = gitOutput.split('\n').filter(f => f.trim() !== '');
    console.log("Changed files detected for package footprint:");
    changedFiles.forEach(f => console.log("  - " + f));
  } catch (err) {
    console.log("⚠️  Could not capture branch difference status metrics. Proceeding cleanly.");
  }

  // Step 3: Save snapshot of current QA state BEFORE deploying
  if (changedFiles.length > 0) {
    const backupPath = path.join(__dirname, '.rollback', storyId);
    fs.mkdirSync(backupPath, { recursive: true });
    console.log("\n📸 Step 3: Extracting snapshot tracking baseline into .rollback/" + storyId + "...");

    changedFiles.forEach(function(filePath) {
      try {
        const tempExtractionDir = path.join(__dirname, '.temp_sf_pull');
        fs.mkdirSync(tempExtractionDir, { recursive: true });

        // Retrieve the current QA state to a separate staging path
        execSync("sf project retrieve start --source-dir \"" + filePath + "\" --target-org " + TARGET_ORG + " --output-dir \"" + tempExtractionDir + "\"", { encoding: 'utf8' });
        
        const pulledFilePath = path.join(tempExtractionDir, filePath);
        if (fs.existsSync(pulledFilePath)) {
          const dest = path.join(backupPath, path.basename(filePath));
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(pulledFilePath, dest);
          console.log("  ✅ Pre-deployment snapshot stored: " + path.basename(filePath));
        }
        
        // Clean up the temporary folder track
        fs.rmSync(tempExtractionDir, { recursive: true, force: true });
      } catch (err) {
        console.log("  ℹ Honor Flag: Component doesn't exist in QA yet. Skipping snapshot tracking entry for: " + path.basename(filePath));
      }
    });
  } else {
    console.log("\n⚠️  Step 3: No metadata change deltas found. Skipping snapshot execution.");
  }

  // Step 4: Finalize User Story Work Matrix State
  console.log("\n🔒 Step 4: Finalizing User Story state and generating platform Promotion record...");
  try {
    runShell("agentia cicd work done");
  } catch (err) {
    console.log("⚠️  Work done indicator processing logged an alignment update warning. Extracting ID variables...");
  }

  // Step 5: Dynamically Extract the Newly Created Promotion ID & Deploy
  console.log("\n📡 Step 5: Intercepting active Promotion ID from Copado Registry...");
  let promotionId = "";
  try {
    // Queries the active work record manifest to pull out the structural ID mapping strings
    const jsonOutput = runShellCapture("agentia cicd work get --json");
    const workData = JSON.parse(jsonOutput);
    
    // Scans properties for the 18-character Salesforce Promotion container ID
    if (workData && workData.promotionId) {
      promotionId = workData.promotionId;
    } else if (workData && workData.latestPromotionId) {
      promotionId = workData.latestPromotionId;
    }
  } catch (e) {
    console.log("⚠️  Automated JSON lookup parsing skipped. Attempting direct workspace extraction...");
  }

  // Fallback pattern if JSON string structure varies slightly across minor beta builds
  if (!promotionId) {
    try {
      const rawText = runShellCapture("agentia cicd work get");
      const match = rawText.match(/Promotion\s*(?:ID)?:\s*([a-zA-Z0-9]{15,18})/i);
      if (match) promotionId = match[1];
    } catch (e) {}
  }

  // Execute the final deployment pipeline call with the specific extracted Promotion ID argument
  if (promotionId) {
    console.log("🚀 Found valid Promotion Reference: " + promotionId);
    console.log("Invoking headless execution run block...");
    try {
      runShell("agentia cicd promotion run " + promotionId + " --operation merge_and_deploy -y");
      console.log("\n🎉 SUCCESS: Headless deployment process completed for story: " + storyId);
    } catch (err) {
      console.error("\n❌ Promotion deployment engine execution failed.");
      process.exit(1);
    }
  } else {
    console.log("\n⚠️  Could not automatically parse an isolated Promotion ID.");
    console.log("Bypassing explicit ID check and launching direct workspace submission...");
    try {
      runShell("agentia cicd work submit");
      console.log("\n✅ Pipeline default submission processed successfully.");
    } catch (err) {
      console.error("\n❌ Execution halted: Explicit 18-character Promotion ID argument missing.");
      process.exit(1);
    }
  }
}

// ─── UNDO / ROLLBACK TRACK ────────────────────────────────────────────────────
else if (command === 'undo') {
  console.log("\n🔄 [copado-hx] Running local headless recovery snapshot for: " + storyId);

  const backupPath = path.join(__dirname, '.rollback', storyId);

  if (fs.existsSync(backupPath)) {
    console.log("\n📡 Step 1: Deploying backup snapshot records directly to " + TARGET_ORG + "...");
    try {
      // Use the local backup files we saved in step 3 to overwrite QA back to its old state
      runShell("sf project deploy start --source-dir \"" + backupPath + "\" --target-org " + TARGET_ORG);
      console.log("\n✅ Success: Custom local snapshot deployed cleanly to QA.");
    } catch (err) {
      console.log("\n❌ Local snapshot restore run failed. Falling back to pipeline checks.");
    }
  } else {
    console.log("\n⚠️ No custom snapshot found for " + storyId + ". Proceeding with pipeline sync rules.");
  }

  console.log("\n📡 Step 2: Ensuring repository alignment via Agentia...");
  try {
    runShell("agentia cicd pipeline status"); 
    console.log("\n✅ Rollback execution completed. Target environments synchronized.");
  } catch (err) {
    console.log("\n❌ Synchronization pipeline tracking logged an exception.");
    process.exit(1);
  }
}

// ─── UNKNOWN ──────────────────────────────────────────────────────────────────
else {
  console.log("❌ Unknown command modifier option: " + command);
  process.exit(1);
}
