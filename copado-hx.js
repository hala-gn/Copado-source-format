```javascript
#!/usr/bin/env node

const { execSync } = require('child_process');
require('dotenv').config();

const [,, command, promotionId] = process.argv;

if (!command || !promotionId) {
  console.log(`
ℹ️  Usage:
  copado-hx undo <PromotionID>   → Reverse a successful Copado deployment via back-promotion
  Example: copado-hx undo PR-0045
  `);
  process.exit(1);
}

function runShell(cmd, silent = false) {
  if (!silent) console.log(`\n▶ Running: ${cmd}`);
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

// ─── UNDO COMMAND (Copado Back-Promotion) ─────────────────────────────────────
if (command === 'undo') {
  console.log(`\n↩️  [copado-hx] Triggering Copado back-promotion for ${promotionId}...`);

  // Step 1: Confirm the promotion exists and show its details
  console.log(`\n🔍 Step 1: Fetching details for promotion ${promotionId}...`);
  try {
    const promotionDetails = runShell(`agentia cicd promotion get ${promotionId}`);
    console.log('\n📋 Promotion Details:\n', promotionDetails);
  } catch (err) {
    console.error(`❌ Could not find promotion ${promotionId}. Please verify the ID.`);
    console.error(`   Run "agentia cicd promotion list" to see all promotions.`);
    process.exit(1);
  }

  // Step 2: Trigger the back-promotion (same as clicking Rollback Page in UI)
  console.log(`\n📡 Step 2: Triggering back-promotion via Agentia...`);
  try {
    const result = runShell(`agentia cicd promotion back-promote --promotion ${promotionId}`);
    console.log('\n✅ Back-promotion triggered successfully:\n', result);
  } catch (err) {
    console.error(`❌ Back-promotion failed:`, err.message);
    console.error(`   Check that the promotion status is "Successful" before rolling back.`);
    process.exit(1);
  }

  // Step 3: List latest job executions to monitor rollback progress
  console.log(`\n📊 Step 3: Checking latest job executions to monitor rollback...`);
  try {
    const jobs = runShell('agentia cicd job list');
    console.log('\n🔄 Latest Jobs:\n', jobs);
  } catch (err) {
    console.log(`⚠️  Could not fetch job list. Check Copado UI for job status.`);
  }

  console.log(`\n✅ Undo process initiated for ${promotionId}.`);
  console.log(`   Monitor progress by running: agentia cicd job list`);
  console.log(`   Or check the Promotion record in Copado UI under the Extension Details tab.`);
}

else {
  console.error(`❌ Unknown command: "${command}". Only "undo" is supported.`);
  console.error(`   Usage: copado-hx undo <PromotionID>`);
  process.exit(1);
}

```