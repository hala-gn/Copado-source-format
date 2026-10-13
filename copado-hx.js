
#!/usr/bin/env node

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

try {
  require("dotenv").config();
} catch (_) {}

const [, , command, storyId] = process.argv;

const SOURCE_ORG = process.env.SOURCE_ORG || "dev1";
const TARGET_ORG = process.env.TARGET_ORG || "qa";

const ROOT = __dirname;
const ROLLBACK_ROOT = path.join(ROOT, ".rollback");
const TEMP_ROOT = path.join(ROOT, ".temp_sf_pull");

if (!command || !storyId) {
  console.log("Usage:");
  console.log("  node copado-hx.js deploy <UserStoryName>");
  console.log("  node copado-hx.js undo <UserStoryName>");
  process.exit(1);
}

// Prevent shell injection through user-provided arguments.
if (!/^[A-Za-z0-9_-]+$/.test(storyId)) {
  console.error("Invalid user story ID.");
  process.exit(1);
}

function run(cmd) {
  console.log("\n$ " + cmd);
  execSync(cmd, {
    cwd: ROOT,
    stdio: "inherit",
    encoding: "utf8"
  });
}

function capture(cmd) {
  console.log("\n$ " + cmd);

  const output = execSync(cmd, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"]
  });

  if (output) console.log(output);
  return output;
}

function copyDirContents(source, destination) {
  if (!fs.existsSync(source)) return;

  fs.mkdirSync(destination, { recursive: true });

  for (const entry of fs.readdirSync(source, {
    withFileTypes: true
  })) {
    const src = path.join(source, entry.name);
    const dst = path.join(destination, entry.name);

    if (entry.isDirectory()) {
      copyDirContents(src, dst);
    } else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
  }
}

function walkFiles(directory) {
  if (!fs.existsSync(directory)) return [];

  let files = [];

  for (const entry of fs.readdirSync(directory, {
    withFileTypes: true
  })) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files = files.concat(walkFiles(fullPath));
    } else {
      files.push(fullPath);
    }
  }

  return files;
}

function getChangedFiles() {
  const output = capture(
    "git diff --name-only origin/main"
  );

  return [...new Set(
    output.split(/\r?\n/).filter(Boolean)
  )];
}

function saveSnapshot(storyId, changedFiles) {
  const storyRoot = path.join(ROLLBACK_ROOT, storyId);
  const snapshotRoot = path.join(storyRoot, "snapshot");

  // Never overwrite an existing rollback snapshot.
  if (fs.existsSync(storyRoot)) {
    throw new Error(
      "A rollback record already exists for " + storyId +
      ". Preserve it and investigate before retrying."
    );
  }

  fs.mkdirSync(snapshotRoot, { recursive: true });

  const record = {
    storyId,
    sourceOrg: SOURCE_ORG,
    targetOrg: TARGET_ORG,
    createdAt: new Date().toISOString(),
    status: "SNAPSHOT_IN_PROGRESS",
    changedFiles,
    restoredFiles: [],
    potentiallyNewFiles: [],
    warnings: []
  };

  fs.writeFileSync(
    path.join(storyRoot, "deployment.json"),
    JSON.stringify(record, null, 2)
  );

  try {
    for (const file of changedFiles) {
      const absoluteFile = path.resolve(ROOT, file);

      // Only snapshot files belonging to the local project.
      if (
        !absoluteFile.startsWith(ROOT + path.sep) ||
        !fs.existsSync(absoluteFile) ||
        !fs.statSync(absoluteFile).isFile()
      ) {
        record.warnings.push(
          "Skipped invalid or missing local file: " + file
        );
        continue;
      }

      const tempDir = path.join(
        TEMP_ROOT,
        Buffer.from(file).toString("hex")
      );

      fs.rmSync(tempDir, { recursive: true, force: true });
      fs.mkdirSync(tempDir, { recursive: true });

      try {
        // Retrieve the previous version from QA.
        run(
          "sf project retrieve start --source-dir " +
          JSON.stringify(file) +
          " --target-org " + TARGET_ORG +
          " --output-dir " + JSON.stringify(tempDir)
        );

        const candidates = walkFiles(tempDir);
        const filename = path.basename(file);

        const matchingFiles = candidates.filter(
          candidate => path.basename(candidate) === filename
        );

        if (matchingFiles.length === 0) {
          record.potentiallyNewFiles.push(file);
          console.log(
            "⚠️ No matching snapshot file found for: " + file
          );
          continue;
        }

        for (const retrievedFile of matchingFiles) {
          const destination = path.join(
            snapshotRoot,
            path.relative(tempDir, retrievedFile)
          );

          fs.mkdirSync(path.dirname(destination), {
            recursive: true
          });

          fs.copyFileSync(retrievedFile, destination);
          record.restoredFiles.push(
            path.relative(storyRoot, destination)
          );

          console.log("📸 Snapshot saved: " + file);
        }
      } finally {
        fs.rmSync(tempDir, {
          recursive: true,
          force: true
        });
      }
    }

    if (record.potentiallyNewFiles.length > 0) {
      record.warnings.push(
        "Some files could not be snapshotted. " +
        "Verify whether they are new components before rollback."
      );
    }

    record.status = "SNAPSHOT_COMPLETE";

    fs.writeFileSync(
      path.join(storyRoot, "deployment.json"),
      JSON.stringify(record, null, 2)
    );

    return record;
  } catch (error) {
    record.status = "SNAPSHOT_FAILED";
    record.error = error.message;

    fs.writeFileSync(
      path.join(storyRoot, "deployment.json"),
      JSON.stringify(record, null, 2)
    );

    throw error;
  }
}

// ---------------- DEPLOY ----------------

if (command === "deploy") {
  console.log("\n🚀 Starting deployment: " + storyId);

  try {
    console.log("\n📌 Step 1: Setting work item context");
    run("agentia cicd work set " + storyId);

    console.log("\n🔍 Step 2: Finding changed files");
    const changedFiles = getChangedFiles();

    if (changedFiles.length === 0) {
      throw new Error(
        "No changed files found against origin/main. " +
        "Check your branch and Git diff before deploying."
      );
    }

    console.log("\nChanged files:");
    changedFiles.forEach(file => console.log(" - " + file));

    console.log("\n📸 Step 3: Saving QA snapshot");
    const record = saveSnapshot(storyId, changedFiles);

    if (record.status !== "SNAPSHOT_COMPLETE") {
      throw new Error("QA snapshot was not completed.");
    }

    console.log("\n🚀 Step 4: Preparing Agentia promotion");

    // Capture the output because it may contain the promotion ID.
    const workOutput = capture(
      "agentia cicd work done"
    );

    const promotionMatch = workOutput.match(
      /\bpromotion_id\s*=\s*([A-Za-z0-9]{18})\b/i
    );

    const promotionId =
      process.env.PROMOTION_ID ||
      (promotionMatch && promotionMatch[1]);

    if (
      !promotionId ||
      !/^[A-Za-z0-9]{18}$/.test(promotionId)
    ) {
      throw new Error(
        "Could not find the 18-character promotion ID. " +
        "Check the work done output and set PROMOTION_ID " +
        "to the correct promotion ID if needed."
      );
    }

    console.log("\nPromotion ID: " + promotionId);

    // Use the required positional promotion ID.
    const promotionOutput = capture(
      "agentia cicd promotion run " + promotionId
    );

    record.promotionId = promotionId;
    record.promotionOutput = promotionOutput;
    record.status = "PROMOTION_COMMAND_COMPLETED";
    record.completedAt = new Date().toISOString();

    fs.writeFileSync(
      path.join(ROLLBACK_ROOT, storyId, "deployment.json"),
      JSON.stringify(record, null, 2)
    );

    console.log("\n✅ Promotion command completed.");
    console.log("Verify the actual deployment result in Copado.");
    console.log("Rollback record: .rollback/" + storyId);
  } catch (error) {
    console.error("\n❌ Deployment workflow failed.");
    console.error(error.message);
    console.error(
      "Check Copado before retrying; the promotion may " +
      "already have executed."
    );
    process.exit(1);
  }
}

// ---------------- UNDO ----------------

else if (command === "undo") {
  console.log("\n🔄 Starting rollback for: " + storyId);

  const storyRoot = path.join(ROLLBACK_ROOT, storyId);
  const recordPath = path.join(storyRoot, "deployment.json");
  const snapshotRoot = path.join(storyRoot, "snapshot");

  if (!fs.existsSync(recordPath)) {
    console.error("❌ No deployment record found for " + storyId);
    process.exit(1);
  }

  const record = JSON.parse(
    fs.readFileSync(recordPath, "utf8")
  );

  if (
    record.targetOrg !== TARGET_ORG ||
    !fs.existsSync(snapshotRoot)
  ) {
    console.error("❌ Snapshot or target org does not match.");
    process.exit(1);
  }

  if (
    !record.restoredFiles ||
    record.restoredFiles.length === 0
  ) {
    console.error("❌ No verified snapshot files to restore.");
    process.exit(1);
  }

  console.log(
    "\n⚠️ This restores saved files only. It does not yet " +
    "delete components created by the original deployment."
  );

  console.log(
    "Review the snapshot directory before proceeding: " +
    snapshotRoot
  );

  console.log(
    "\nDo not run the restore until you have confirmed " +
    "the snapshot has valid Salesforce package structure."
  );

  console.log(
    "\nNext step: build a manifest-based restore using the " +
    "recorded metadata types and destructive changes."
  );
}

else {
  console.error("Unknown command: " + command);
  process.exit(1);
}
