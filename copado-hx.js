#!/usr/bin/env node

"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

try {
  require("dotenv").config();
} catch (_) {
  // dotenv is optional.
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
    stdio: options.capture
      ? ["inherit", "pipe", "pipe"]
      : "inherit",
    timeout: options.timeout || 0,
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true
  });

  if (result.error) {
    if (result.error.code === "ENOENT") {
      throw new Error(
        "Cannot find executable '" + executable + "'. " +
        "If this is Salesforce CLI, open CMD and run " +
        "'sf --version' and 'where sf'. Install Salesforce CLI " +
        "or correct PATH, then restart your terminal."
      );
    }

    throw new Error(
      "Failed to start '" + executable + "': " +
      result.error.message
    );
  }

  if (options.capture) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }

  if (result.status !== 0) {
    const error = new Error(
      executable + " exited with code " + result.status
    );
    error.stdout = result.stdout || "";
    error.stderr = result.stderr || "";
    throw error;
  }

  return result.stdout || "";
}

function copyTree(source, destination) {
  if (!fs.existsSync(source)) return;

  fs.mkdirSync(destination, { recursive: true });

  for (const entry of fs.readdirSync(source, {
    withFileTypes: true
  })) {
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

  for (const entry of fs.readdirSync(directory, {
    withFileTypes: true
  })) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files = files.concat(listFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

function getChangedFiles() {
  const changed = run("git", [
    "diff",
    "--name-only",
    "--diff-filter=ACDMRTUXB",
    "origin/main"
  ], { capture: true });

  const untracked = run("git", [
    "ls-files",
    "--others",
    "--exclude-standard"
  ], { capture: true });

  return [...new Set(
    (changed + "\n" + untracked)
      .split(/\r?\n/)
      .map(file => file.trim())
      .filter(Boolean)
  )];
}

/*
 * Only consider real project files.
 * Explicitly exclude Agentia configuration, rollback data,
 * dependencies, and temporary snapshot files.
 */
function safeProjectFile(file) {
  const absolute = path.resolve(ROOT, file);
  const relative = path.relative(ROOT, absolute);

  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(".." + path.sep) ||
    path.isAbsolute(relative) ||
    !fs.existsSync(absolute) ||
    !fs.statSync(absolute).isFile()
  ) {
    return false;
  }

  const normalized = relative.split(path.sep).join("/");

  const excludedPaths = [
    ".agentia",
    ".rollback",
    ".rollback-temp",
    ".temp_sf_pull",
    "node_modules",
    ".git"
  ];

  for (const excluded of excludedPaths) {
    if (
      normalized === excluded ||
      normalized.startsWith(excluded + "/")
    ) {
      return false;
    }
  }

  // Exclude project/config files that are not Salesforce metadata.
  const excludedFiles = new Set([
    "sfdx-project.json",
    "package.json",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    ".gitignore",
    ".env"
  ]);

  if (excludedFiles.has(normalized)) {
    return false;
  }

  // Salesforce metadata source formats are usually stored under
  // a directory such as force-app/main/default.
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

  saveJson(
    getStoryPaths(record.storyId).recordPath,
    record
  );
}

function snapshotExists(id) {
  const paths = getStoryPaths(id);

  return (
    fs.existsSync(paths.snapshotRoot) &&
    listFiles(paths.snapshotRoot).length > 0
  );
}

function createSnapshot(record, changedFiles) {
  const paths = getStoryPaths(record.storyId);

  if (snapshotExists(record.storyId)) {
    throw new Error(
      "A snapshot already exists. Reuse the original snapshot; " +
      "do not overwrite it."
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
        console.log("Skipping non-metadata/config file: " + file);
        continue;
      }

      const tempDir = path.join(
        TEMP_ROOT,
        Buffer.from(file).toString("hex")
      );

      fs.rmSync(tempDir, {
        recursive: true,
        force: true
      });

      fs.mkdirSync(tempDir, { recursive: true });

      try {
        run("sf", [
          "project",
          "retrieve",
          "start",
          "--source-dir",
          file,
          "--target-org",
          TARGET_ORG,
          "--output-dir",
          tempDir
        ]);

        const retrievedFiles = listFiles(tempDir);

        if (retrievedFiles.length === 0) {
          record.potentiallyNewFiles.push(file);
          console.log(
            "No previous target-org file found for: " + file
          );
          continue;
        }

        copyTree(tempDir, paths.snapshotRoot);

        for (const retrievedFile of retrievedFiles) {
          const relative = path.relative(tempDir, retrievedFile);
          const saved = path.join(paths.snapshotRoot, relative);

          if (fs.existsSync(saved)) {
            const savedRelative = path.relative(
              paths.snapshotRoot,
              saved
            );

            if (!record.snapshotFiles.includes(savedRelative)) {
              record.snapshotFiles.push(savedRelative);
            }
          }
        }
      } finally {
        fs.rmSync(tempDir, {
          recursive: true,
          force: true
        });
      }
    }

    if (record.snapshotFiles.length === 0) {
      throw new Error(
        "No snapshot files were retrieved from QA. " +
        "Deployment blocked to protect the existing metadata."
      );
    }

    if (record.potentiallyNewFiles.length > 0) {
      record.warnings.push(
        "Some changed files had no matching retrieved file. " +
        "They may be new components. Undo does not automatically " +
        "delete newly created metadata."
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

    updateStatus(record, "SNAPSHOT_FAILED", {
      error: error.message
    });

    throw error;
  } finally {
    fs.rmSync(TEMP_ROOT, {
      recursive: true,
      force: true
    });
  }
}

function getPromotionId(output) {
  const match = output.match(
    /\bpromotion_id\s*=\s*([A-Za-z0-9]{15,18})\b/i
  );

  return match ? match[1] : null;
}

function deployStory(id) {
  const record = loadOrCreateRecord(id);

  if (
    record.targetOrg !== TARGET_ORG ||
    record.sourceOrg !== SOURCE_ORG
  ) {
    throw new Error(
      "The existing record uses different org aliases. " +
      "Check SOURCE_ORG and TARGET_ORG."
    );
  }

  if (record.promotionId) {
    throw new Error(
      "A promotion ID is already recorded: " +
      record.promotionId +
      ". Check its status in Copado before starting another promotion."
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
    console.log("\nFinding changed files...");

    const changedFiles = getChangedFiles()
      .filter(safeProjectFile);

    if (changedFiles.length === 0) {
      throw new Error(
        "No eligible Salesforce project files found. " +
        "Check your Git branch and metadata paths."
      );
    }

    console.log("\nEligible changed files:");
    changedFiles.forEach(file => console.log(" - " + file));

    console.log("\nSaving target-org snapshot...");
    createSnapshot(record, changedFiles);
  }

  if (!snapshotExists(id)) {
    throw new Error(
      "Snapshot is missing. Deployment has been blocked."
    );
  }

  run("agentia", ["cicd", "work", "set", id]);

  let workOutput;

  try {
    workOutput = run(
      "agentia",
      ["cicd", "work", "done"],
      { capture: true }
    );
  } catch (error) {
    record.error = error.message;

    updateStatus(record, "WORK_DONE_STATUS_UNKNOWN", {
      error: error.message
    });

    throw error;
  }

  const promotionId =
    process.env.PROMOTION_ID || getPromotionId(workOutput);

  if (
    !promotionId ||
    !PROMOTION_ID_PATTERN.test(promotionId)
  ) {
    record.error =
      "Could not determine the promotion ID from Agentia output.";

    updateStatus(record, "PROMOTION_ID_UNKNOWN", {
      error: record.error
    });

    throw new Error(
      record.error +
      " Check Agentia/Copado before retrying."
    );
  }

  // Save promotion ID before running it to reduce duplicate submissions
  // when the CLI times out or the connection drops.
  record.promotionId = promotionId;
  record.promotionSubmittedAt = new Date().toISOString();

  updateStatus(record, "PROMOTION_SUBMISSION_PENDING", {
    promotionId
  });

  try {
    const output = run(
      "agentia",
      ["cicd", "promotion", "run", promotionId],
      { capture: true }
    );

    record.promotionOutput = output;

    updateStatus(record, "PROMOTION_COMMAND_COMPLETED", {
      promotionId,
      note: "Verify the actual deployment status in Copado."
    });

    console.log("\nPromotion command completed.");
    console.log("Verify the deployment result in Copado.");
    console.log("Rollback record: .rollback/" + id);
  } catch (error) {
    record.error = error.message;

    updateStatus(record, "PROMOTION_STATUS_UNKNOWN", {
      promotionId,
      error: error.message,
      note: "Check Copado before retrying."
    });

    throw new Error(
      "Promotion failed or timed out. Its actual status may be unknown. " +
      "Check Copado before retrying. " + error.message
    );
  }
}

function findDeployRoots(snapshotRoot) {
  const roots = [];

  function walk(directory) {
    if (!fs.existsSync(directory)) return;

    const entries = fs.readdirSync(directory, {
      withFileTypes: true
    });

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
      "Target org mismatch. Record target: " +
      record.targetOrg + "; configured target: " + TARGET_ORG
    );
  }

  if (!snapshotExists(id)) {
    throw new Error("No usable snapshot found for " + id);
  }

  if (
    !record.snapshotFiles ||
    record.snapshotFiles.length === 0
  ) {
    throw new Error("No verified snapshot files were recorded.");
  }

  const deployRoots = findDeployRoots(paths.snapshotRoot);

  if (deployRoots.length === 0) {
    throw new Error(
      "No Salesforce source-format main/default directory was found " +
      "inside the snapshot. No restore deployment was started."
    );
  }

  console.log("\nRollback preview for " + id);
  console.log("Target org: " + TARGET_ORG);
  console.log("Snapshot files: " + record.snapshotFiles.length);

  if (
    record.potentiallyNewFiles &&
    record.potentiallyNewFiles.length > 0
  ) {
    console.log("\nPossible newly created metadata:");
    record.potentiallyNewFiles.forEach(file => {
      console.log(" - " + file);
    });

    console.log(
      "This script does not automatically delete new components. " +
      "Review a destructive-changes manifest separately."
    );
  }

  console.log("\nRestore package directories:");

  deployRoots.forEach(root => console.log(" - " + root));

  console.log(
    "\nThis restores saved metadata only. It does not restore " +
    "Salesforce record data or automatically delete new components."
  );

  if (process.env.CONFIRM_UNDO !== id) {
    console.log(
      "\nRollback NOT started. Review the snapshot, then run:"
    );

    console.log(
      "  set CONFIRM_UNDO=" + id +
      " && node copado-hx.js undo " + id
    );

    console.log(
      "\nPowerShell alternative:\n" +
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
        "project",
        "deploy",
        "start",
        "--source-dir",
        root,
        "--target-org",
        TARGET_ORG
      ]);
    }

    updateStatus(record, "UNDO_COMMAND_COMPLETED", {
      note: "Verify the restore in Salesforce/Copado."
    });

    console.log("\nRestore command completed.");
    console.log("Verify the deployment and run post-rollback tests.");
  } catch (error) {
    record.error = error.message;

    updateStatus(record, "UNDO_STATUS_UNKNOWN", {
      error: error.message,
      note: "Check QA before retrying the restore."
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
    throw new Error(
      "Invalid story ID. Use letters, numbers, underscores or hyphens."
    );
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