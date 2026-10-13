
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

try {
  require("dotenv").config();
} catch (_) {}

const [, , command, storyId] = process.argv;

const SOURCE_ORG = process.env.SOURCE_ORG || "dev1";
const TARGET_ORG = process.env.TARGET_ORG || "qa";
const PROMOTION_MANIFEST = process.env.PROMOTION_MANIFEST;
const API_VERSION = process.env.SF_API_VERSION || "66.0";

const ROOT = __dirname;
const HISTORY = path.join(ROOT, ".rollback", storyId || "unknown");

function fail(message) {
  throw new Error(message);
}

function cli(program, args) {
  console.log("\n>", program, ...args);

  const result = spawnSync(program, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "inherit",
    shell: false
  });

  if (result.error) throw result.error;

  if (result.status !== 0) {
    fail(`${program} exited with status ${result.status}`);
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function checkInputs() {
  if (!["deploy", "undo"].includes(command) || !storyId) {
    fail(
      "Usage: node copado-hx.js deploy US-0000025\n" +
      "       node copado-hx.js undo US-0000025"
    );
  }

  if (!/^US-[A-Za-z0-9_-]+$/.test(storyId)) {
    fail("Invalid user story ID.");
  }
}

function latestRun() {
  const runsRoot = path.join(HISTORY, "runs");

  if (!fs.existsSync(runsRoot)) {
    fail("No rollback history exists for " + storyId);
  }

  const runs = fs.readdirSync(runsRoot)
    .filter(name =>
      fs.existsSync(path.join(runsRoot, name, "record.json"))
    )
    .sort()
    .reverse();

  if (!runs.length) fail("No deployment snapshot found.");

  return path.join(runsRoot, runs[0]);
}

function deploy() {
  if (!PROMOTION_MANIFEST) {
    fail(
      "Set PROMOTION_MANIFEST to the package.xml containing " +
      "the exact components in this promotion."
    );
  }

  const manifest = path.resolve(ROOT, PROMOTION_MANIFEST);

  if (!fs.existsSync(manifest)) {
    fail("Promotion manifest not found: " + manifest);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(HISTORY, "runs", stamp);
  const snapshotDir = path.join(runDir, "snapshot-mdapi");

  fs.mkdirSync(snapshotDir, { recursive: true });

  const record = {
    storyId,
    sourceOrg: SOURCE_ORG,
    targetOrg: TARGET_ORG,
    manifest,
    createdAt: new Date().toISOString(),
    snapshotStatus: "STARTED",
    promotionStatus: "NOT_STARTED",
    rollbackStatus: "NOT_STARTED",
    warning:
      "The manifest must match the exact Copado promotion scope."
  };

  writeJson(path.join(runDir, "record.json"), record);

  // Save previous QA state before running the promotion.
  console.log("\nStep 1: Snapshotting QA metadata");

  cli("sf", [
    "project", "retrieve", "start",
    "--manifest", manifest,
    "--target-org", TARGET_ORG,
    "--target-metadata-dir", snapshotDir,
    "--unzip",
    "--api-version", API_VERSION,
    "--wait", "30"
  ]);

  const snapshotPackage = path.join(snapshotDir, "package.xml");

  if (!fs.existsSync(snapshotPackage)) {
    fail("Snapshot package.xml is missing. Promotion cancelled.");
  }

  record.snapshotStatus = "COMPLETE";
  writeJson(path.join(runDir, "record.json"), record);

  // Run the existing Agentia workflow.
  // Promotion discovery/execution must match your installed CLI.
  console.log("\nStep 2: Setting Agentia work item");

  cli("agentia", ["cicd", "work", "set", storyId]);

  console.log("\nStep 3: Running Agentia work done");

  record.promotionStatus = "COMMAND_STARTED";
  writeJson(path.join(runDir, "record.json"), record);

  cli("agentia", ["cicd", "work", "done"]);

  record.promotionStatus = "COMMAND_COMPLETED_UNVERIFIED";
  record.completedAt = new Date().toISOString();
  writeJson(path.join(runDir, "record.json"), record);

  console.log("\nAgentia command completed.");
  console.log("Verify the promotion result in Copado.");
  console.log("Snapshot: " + snapshotDir);
}

function undo() {
  const runDir = latestRun();
  const recordFile = path.join(runDir, "record.json");
  const record = readJson(recordFile);
  const snapshotDir = path.join(runDir, "snapshot-mdapi");

  if (record.targetOrg !== TARGET_ORG) {
    fail("Target org does not match the saved snapshot.");
  }

  if (record.snapshotStatus !== "COMPLETE") {
    fail("Snapshot was not completed. Cannot safely undo.");
  }

  if (record.rollbackStatus === "COMPLETED") {
    fail("This run has already been rolled back.");
  }

  if (!fs.existsSync(path.join(snapshotDir, "package.xml"))) {
    fail("Snapshot package.xml is missing.");
  }

  console.log("\nRestoring saved metadata to QA.");

  console.log(
    "Only metadata included in the snapshot is restored. " +
    "New components require a verified destructive manifest."
  );

  record.rollbackStatus = "STARTED";
  writeJson(recordFile, record);

  try {
    cli("sf", [
      "project", "deploy", "start",
      "--metadata-dir", snapshotDir,
      "--target-org", TARGET_ORG,
      "--wait", "30",
      "--api-version", API_VERSION
    ]);

    record.rollbackStatus = "COMPLETED";
    record.rollbackCompletedAt = new Date().toISOString();
    writeJson(recordFile, record);

    console.log("\nMetadata restoration deployment succeeded.");
    console.log("Verify the resulting state in QA.");
  } catch (error) {
    record.rollbackStatus = "FAILED";
    record.rollbackError = error.message;
    writeJson(recordFile, record);
    throw error;
  }
}

try {
  checkInputs();

  if (command === "deploy") deploy();
  else undo();
} catch (error) {
  console.error("\nERROR:", error.message);
  process.exitCode = 1;
}
