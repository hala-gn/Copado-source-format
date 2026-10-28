
#!/usr/bin/env node

"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

try {
  require("dotenv").config();
} catch (_) {
  // dotenv is optional. Environment variables can be set externally.
}

const [, , command, storyId] = process.argv;

const SOURCE_ORG = process.env.SOURCE_ORG || "dev1";
const TARGET_ORG = process.env.TARGET_ORG || "qa";

const ROOT = __dirname;
const ROLLBACK_ROOT = path.join(ROOT, ".rollback");
const TEMP_ROOT = path.join(ROOT, ".rollback-temp");

const STORY_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const PROMOTION_ID_PATTERN = /^[A-Za-z0-9]{15,18}$/;

function saveJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function run(executable, args, options = {}) {
  console.log("\n$ " + executable + " " + args.join(" "));

  const result = spawnSync(executable, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: options.capture ? ["inherit", "pipe", "pipe"] : "inherit",
    timeout: options.timeout || 0,
    maxBuffer: 20 * 1024 * 1024
  });

  if (options.capture) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }

  if (result.error) {
    throw new Error(result.error.message);
  }

  if (result.status !== 0) {
    const error = new Error(
      `${executable} exited with code ${result.status}`
    );
    error.stdout = result.stdout || "";
    error.stderr = result.stderr || "";
    throw error;
  }

  return result.stdout || "";
}

function copyTree(source, destination) {
  if (!fs.existsSync(source)) return;

  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);

    if (entry.isDirectory()) {
      copyTree(from, to);
    } else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
  }
}

function listFiles(directory) {
  if (!fs.existsSync(directory)) return [];

  let files = [];

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files = files.concat(listFiles(fullPath));
    } else {
      files.push(fullPath);
    }
  }

  return files;
}

function getChangedFiles() {
  // Include staged, unstaged, and untracked files.
  const changed = run("git", [
    "diff", "--name-only", "--diff-filter=ACDMRTUXB", "origin/main"
  ], { capture: true });

  const untracked = run("git", [
    "ls-files", "--others", "--exclude-standard"
  ], { capture: true });

  return [...new Set(
    (changed + "\n" + untracked)
      .split(/\r?\n/)
      .map(file => file.trim())
      .filter(Boolean)
  )];
}

function safeProjectFile(file) {
  const absolute = path.resolve(ROOT, file);
  const relative = path.relative(ROOT, absolute);

  if (
    !relative ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !fs.existsSync(absolute) ||
    !fs.statSync(absolute).isFile()
  ) {
    return false;
  }

  // Avoid snapshotting rollback data, dependencies, and temporary files.
  if (
    relative.startsWith(".rollback" + path.sep) ||
    relative.startsWith("node_modules" + path.sep) ||
    relative.startsWith(".temp_sf_pull" + path.sep)
  ) {
    return false;
  }

  return true;
}

function getStoryPaths(id) {
  const storyRoot = path.join(ROLLBACK_ROOT, id);

  return {
    storyRoot,
    snapshotRoot: path.join(storyRoot, "snapshot"),
    recordPath: path.join(storyRoot, "deployment.json")
  };
}

function loadOrCreateRecord(id) {
  const paths = getStoryPaths(id);

  if (fs.existsSync(paths.recordPath)) {
    return readJson(paths.recordPath);
  }

  return {
    storyId: id,
    sourceOrg: SOURCE_ORG,
    targetOrg: TARGET_ORG,
    createdAt: new Date().toISOString(),
    status: "INITIALIZED",
    changedFiles: [],
    snapshotFiles: [],
    potentiallyNewFiles: [],
    warnings: [],
    promotionId: null,
    history: []
  };
}

function updateStatus(record, status, details = {}) {
  record.status = status;
  record.updatedAt = new Date().toISOString();
  record.history = record.history || [];

  record.history.push({
    at: new Date().toISOString(),
    status,
    details
  });

  saveJson(getStoryPaths(record.storyId).recordPath, record);
}

function snapshotExists(id) {
  const paths = getStoryPaths(id);
  return fs.existsSync(paths.snapshotRoot) &&
    listFiles(paths.snapshotRoot).length > 0;
}

function createSnapshot(record, changedFiles) {
  const paths = getStoryPaths(record.storyId);

  if (snapshotExists(record.storyId)) {
    throw new Error(
      "A snapshot already exists. It must be reused, not overwritten."
    );
  }

  fs.mkdirSync(paths.snapshotRoot, { recursive: true });
  fs.mkdirSync(TEMP_ROOT, { recursive: true });

  record.changedFiles = changedFiles;
  record.snapshotFiles = [];
  record.potentiallyNewFiles = [];
  record.warnings = [];

  updateStatus(record, "SNAPSHOT_IN_PROGRESS");

  try {
    for (const file of changedFiles) {
      if (!safeProjectFile(file)) {
        record.warnings.push("Skipped invalid or missing file: " + file);
        continue;
      }

      const tempDir = path.join(
        TEMP_ROOT,
        Buffer.from(file).toString("hex")
      );

      fs.rmSync(tempDir, { recursive: true, force: true });
      fs.mkdirSync(tempDir, { recursive: true });

      try {
        // Retrieve the target org's previous version into a separate folder.
        run("sf", [
          "project", "retrieve", "start",
          "--source-dir", file,
          "--target-org", TARGET_ORG,
          "--output-dir", tempDir
        ]);

        const retrievedFiles = listFiles(tempDir);

        if (retrievedFiles.length === 0) {
          record.potentiallyNewFiles.push(file);
          continue;
        }

        // Preserve the retrieved directory structure.
        copyTree(tempDir, paths.snapshotRoot);

        for (const retrievedFile of retrievedFiles) {
          const relative = path.relative(tempDir, retrievedFile);
          const saved = path.join(paths.snapshotRoot, relative);

          if (fs.existsSync(saved)) {
            const savedRelative = path.relative(paths.snapshotRoot, saved);

            if (!record.snapshotFiles.includes(savedRelative)) {
              record.snapshotFiles.push(savedRelative);
            }
          }
        }
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }

    if (record.snapshotFiles.length === 0) {
      throw new Error(
        "No snapshot files were retrieved from the target org. " +
        "Deployment blocked to avoid losing the previous state."
      );
    }

    if (record.potentiallyNewFiles.length > 0) {
      record.warnings.push(
        "Some changed files had no retrieved counterpart in the target org. " +
        "They may be new components. This script does not automatically " +
        "delete newly created metadata during undo."
      );
    }

    record.snapshotCompletedAt = new Date().toISOString();
    updateStatus(record, "SNAPSHOT_COMPLETE", {
      snapshotFileCount: record.snapshotFiles.length,
      possibleNewFileCount: record.potentiallyNewFiles.length
    });

    return record;
  } catch (error) {
    record.error = error.message;
    updateStatus(record, "SNAPSHOT_FAILED", { error: error.message });
    throw error;
  } finally {
    fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  }
}

function getPromotionId(output) {
  const match = output.match(
    /\bpromotion_id\s*=\s*([A-Za-z0-9]{15,18})\b/i
  );

  return match ? match[1] : null;
}

function deployStory(id) {
  const paths = getStoryPaths(id);
  const record = loadOrCreateRecord(id);

  if (
    record.targetOrg !== TARGET_ORG ||
    record.sourceOrg !== SOURCE_ORG
  ) {
    throw new Error(
      "The existing record uses different org aliases. " +
      "Check SOURCE_ORG and TARGET_ORG before continuing."
    );
  }

  // Do not create a second promotion if the previous run may have submitted one.
  if (record.promotionId) {
    throw new Error(
      "A promotion ID is already recorded: " + record.promotionId +
      ". Check the actual promotion status in Copado first. " +
      "Do not blindly run another promotion."
    );
  }

  console.log("\nStarting deployment for " + id);

  if (snapshotExists(id)) {
    console.log("Reusing the original snapshot.");
    if (record.status !== "SNAPSHOT_COMPLETE") {
      updateStatus(record, "SNAPSHOT_COMPLETE", {
        note: "Existing snapshot reused"
      });
    }
  } else {
    console.log("Finding changed files...");
    const changedFiles = getChangedFiles();

    if (changedFiles.length === 0) {
      throw new Error(
        "No changed files found against origin/main. " +
        "Check your Git branch and diff."
      );
    }

    console.log("\nChanged files:");
    changedFiles.forEach(file => console.log(" - " + file));

    console.log("\nSaving target-org snapshot...");
    createSnapshot(record, changedFiles);
  }

  // Confirm the snapshot is present before invoking Agentia.
  if (!snapshotExists(id)) {
    throw new Error("Snapshot is missing. Deployment has been blocked.");
  }

  run("agentia", ["cicd", "work", "set", id]);

  let workOutput;

  try {
    workOutput = run("agentia", ["cicd", "work", "done"], {
      capture: true
    });
  } catch (error) {
    record.error = error.message;
    updateStatus(record, "WORK_DONE_STATUS_UNKNOWN", {
      error: error.message
    });
    throw error;
  }

  const promotionId =
    process.env.PROMOTION_ID || getPromotionId(workOutput);

  if (!promotionId || !PROMOTION_ID_PATTERN.test(promotionId)) {
    record.error =
      "Could not determine the promotion ID from Agentia output.";
    updateStatus(record, "PROMOTION_ID_UNKNOWN", {
      error: record.error
    });
    throw new Error(
      record.error +
      " Check Agentia/Copado before running work done again."
    );
  }

  // Persist the ID BEFORE starting the promotion. This prevents a retry
  // from unknowingly creating a second promotion after a timeout.
  record.promotionId = promotionId;
  record.promotionSubmittedAt = new Date().toISOString();
  updateStatus(record, "PROMOTION_SUBMISSION_PENDING", { promotionId });

  try {
    const output = run("agentia", [
      "cicd", "promotion", "run", promotionId
    ], { capture: true });

    record.promotionOutput = output;

    // Command completion is not proof that the Salesforce deployment succeeded.
    updateStatus(record, "PROMOTION_COMMAND_COMPLETED", {
      promotionId,
      note: "Verify the final deployment status in Copado."
    });

    console.log("\nPromotion command completed.");
    console.log("Verify the final deployment result in Copado.");
    console.log("Rollback record: .rollback/" + id);
  } catch (error) {
    record.error = error.message;
    updateStatus(record, "PROMOTION_STATUS_UNKNOWN", {
      promotionId,
      error: error.message,
      note: "Check Copado before attempting another promotion."
    });

    throw new Error(
      "Promotion command failed or timed out. Its actual status may be " +
      "unknown. Check Copado before retrying. " + error.message
    );
  }
}

function findDeployRoots(snapshotRoot) {
  const roots = [];

  function walk(directory) {
    if (!fs.existsSync(directory)) return;

    const entries = fs.readdirSync(directory, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const full = path.join(directory, entry.name);

      if (
        entry.name === "default" &&
        path.basename(path.dirname(full)) === "main"
      ) {
        roots.push(full);
      } else {
        walk(full);
      }
    }
  }

  walk(snapshotRoot);
  return [...new Set(roots)];
}

function undoStory(id) {
  const paths = getStoryPaths(id);

  if (!fs.existsSync(paths.recordPath)) {
    throw new Error("No deployment record found for " + id);
  }

  const record = readJson(paths.recordPath);

  if (record.targetOrg !== TARGET_ORG) {
    throw new Error(
      "Target org mismatch. Record target is " + record.targetOrg +
      ", configured target is " + TARGET_ORG
    );
  }

  if (!snapshotExists(id)) {
    throw new Error("No usable snapshot found for " + id);
  }

  if (!record.snapshotFiles || record.snapshotFiles.length === 0) {
    throw new Error("The record contains no verified snapshot files.");
  }

  const deployRoots = findDeployRoots(paths.snapshotRoot);

  if (deployRoots.length === 0) {
    throw new Error(
      "Could not locate a Salesforce source-format package directory " +
      "inside the snapshot. Review the snapshot structure before undo. " +
      "No restore deployment was started."
    );
  }

  console.log("\nRollback preview for " + id);
  console.log("Target org: " + TARGET_ORG);
  console.log("Snapshot files: " + record.snapshotFiles.length);

  if (record.potentiallyNewFiles && record.potentiallyNewFiles.length) {
    console.log("\nWARNING: Possible newly created files were recorded:");
    record.potentiallyNewFiles.forEach(file => console.log(" - " + file));
    console.log(
      "This version does not automatically delete those components. " +
      "Create and review a destructive-changes manifest if deletion is needed."
    );
  }

  console.log("\nThe following snapshot package directories will be deployed:");
  deployRoots.forEach(root => console.log(" - " + root));

  console.log(
    "\nUndo restores saved metadata files. Review the snapshot and target org " +
    "before proceeding. This command does not restore Salesforce record data."
  );

  const confirm = process.env.CONFIRM_UNDO;

  if (confirm !== id) {
    console.log(
      "\nRollback NOT started. After reviewing the snapshot, run:\n" +
      "  CONFIRM_UNDO=" + id + " node copado-hx.js undo " + id
    );
    console.log(
      "On Windows PowerShell:\n" +
      "  $env:CONFIRM_UNDO='" + id + "'; " +
      "node copado-hx.js undo " + id
    );
    return;
  }

  updateStatus(record, "UNDO_IN_PROGRESS", {
    targetOrg: TARGET_ORG,
    deployRoots
  });

  try {
    for (const root of deployRoots) {
      run("sf", [
        "project", "deploy", "start",
        "--source-dir", root,
        "--target-org", TARGET_ORG
      ]);
    }

    updateStatus(record, "UNDO_COMMAND_COMPLETED", {
      note: "Verify the restore result in Salesforce CLI/Copado."
    });

    console.log("\nRestore command completed.");
    console.log("Verify the deployment result and run post-rollback tests.");
  } catch (error) {
    record.error = error.message;
    updateStatus(record, "UNDO_STATUS_UNKNOWN", {
      error: error.message,
      note: "Check the target org before retrying the restore."
    });
    throw error;
  }
}

function main() {
  if (!command || !storyId) {
    console.log("Usage:");
    console.log("  node copado-hx.js deploy <UserStoryId>");
    console.log("  node copado-hx.js undo <UserStoryId>");
    process.exitCode = 1;
    return;
  }

  if (!STORY_ID_PATTERN.test(storyId)) {
    throw new Error("Invalid user story ID. Use letters, numbers, _ or -.");
  }

  if (command === "deploy") {
    deployStory(storyId);
  } else if (command === "undo") {
    undoStory(storyId);
  } else {
    throw new Error("Unknown command: " + command);
  }
}

try {
  main();
} catch (error) {
  console.error("\nERROR: " + error.message);
  process.exitCode = 1;
}
