#!/usr/bin/env node
'use strict';

/**
 * copado-hx.js : headless Copado deploy + local snapshot rollback
 *
 *   node copado-hx.js deploy <UserStoryName>
 *   node copado-hx.js undo   <UserStoryName> [--delete-new]
 *
 * Env (.env supported):
 *   TARGET_ORG         sf alias of the org the promotion deploys to (default: qa)
 *   COPADO_UI_URL      e.g. https://yourorg.lightning.force.com  (prints UI links)
 *   POLL_INTERVAL_MS   status poll interval (default 10000)
 *   MAX_POLL_MINUTES   give up polling after N minutes (default 30)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

try { require('dotenv').config(); } catch (e) { /* dotenv optional */ }

const [,, command, storyId, ...flags] = process.argv;

const TARGET_ORG       = process.env.TARGET_ORG || 'qa';
const COPADO_UI_URL    = (process.env.COPADO_UI_URL || '').replace(/\/$/, '');
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 10000);
const MAX_POLL_MINUTES = Number(process.env.MAX_POLL_MINUTES || 30);

const TERMINAL_OK   = ['SUCCESS', 'COMPLETED'];
const TERMINAL_FAIL = ['FAIL', 'ERROR', 'CANCEL', 'ABORT'];

const line = (c = '=') => console.log(c.repeat(68));

if (!command || !storyId) {
  line();
  console.log('ERROR: Missing execution parameters.');
  console.log('Usage:');
  console.log('  node copado-hx.js deploy <UserStoryName>                 -> Headless promotion + snapshot');
  console.log('  node copado-hx.js undo   <UserStoryName> [--delete-new]  -> Local automated rollback');
  line();
  process.exit(1);
}

// storyId ends up in shell commands and file paths: whitelist it.
if (!/^[A-Za-z0-9_.-]+$/.test(storyId)) {
  console.error(`Invalid user story name "${storyId}". Allowed: letters, digits, _ . -`);
  process.exit(1);
}

// ─── helpers ─────────────────────────────────────────────────────────────────
function run(cmd, opts = {}) {
  execSync(cmd, { stdio: 'inherit', ...opts });
}

// Returns { ok, out, err }. Never throws. Keeps stdout even on non-zero exit,
// because `sf ... --json` prints its error payload to stdout.
function capture(cmd, opts = {}) {
  try {
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    return { ok: true, out: out.trim(), err: '' };
  } catch (e) {
    return { ok: false, out: (e.stdout || '').toString().trim(), err: (e.stderr || e.message || '').toString().trim() };
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); // cross-platform, no powershell
}

function tryJson(text) {
  try { return JSON.parse(text); } catch (_) {
    // CLI sometimes prints warnings before the JSON body
    const i = text.indexOf('{');
    if (i > 0) { try { return JSON.parse(text.slice(i)); } catch (_) { /* fallthrough */ } }
    return null;
  }
}

// Depth-first search for the first value under any of the given key names.
function findKey(obj, names) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const n of names) if (obj[n] !== undefined && obj[n] !== null && obj[n] !== '') return obj[n];
  for (const k of Object.keys(obj)) {
    const v = findKey(obj[k], names);
    if (v !== undefined) return v;
  }
  return undefined;
}

function classify(status) {
  const s = (status || '').toUpperCase();
  if (TERMINAL_FAIL.some(t => s.includes(t))) return 'FAILED';
  if (TERMINAL_OK.some(t => s.includes(t)))   return 'SUCCESS';
  return 'RUNNING';
}

// Windows/OneDrive/antivirus can briefly lock freshly written folders (EPERM/EBUSY).
// Retry, and never let cleanup crash the run.
function safeRm(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  } catch (e) {
    console.log(`  (could not delete temp folder ${path.basename(target)}: ${e.code || e.message}; safe to remove later)`);
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ─── file path -> metadata member mapping (needed for per-component snapshot) ─
function toMetadata(file) {
  const p = file.replace(/\\/g, '/');
  const m = p.match(/main\/default\/([^/]+)\/(.+)$/);
  if (!m) return null;
  const [, folder, rest] = m;
  const base = path.posix.basename(rest).replace(/-meta\.xml$/, '').replace(/\.[^.]+$/, '');
  const simple = {
    classes: 'ApexClass', triggers: 'ApexTrigger', pages: 'ApexPage', components: 'ApexComponent',
    flexipages: 'FlexiPage', layouts: 'Layout', permissionsets: 'PermissionSet', flows: 'Flow',
    tabs: 'CustomTab', staticresources: 'StaticResource', customMetadata: 'CustomMetadata',
    profiles: 'Profile', labels: 'CustomLabels', applications: 'CustomApplication'
  };
  if (simple[folder]) return { type: simple[folder], name: base };
  if (folder === 'lwc')  return { type: 'LightningComponentBundle', name: rest.split('/')[0] };
  if (folder === 'aura') return { type: 'AuraDefinitionBundle',     name: rest.split('/')[0] };
  if (folder === 'objects') {
    const parts = rest.split('/');
    if (parts.length <= 2) return { type: 'CustomObject', name: parts[0] };
    const sub = { fields: 'CustomField', validationRules: 'ValidationRule', recordTypes: 'RecordType',
                  listViews: 'ListView', webLinks: 'WebLink', compactLayouts: 'CompactLayout' }[parts[1]];
    if (sub) return { type: sub, name: `${parts[0]}.${base}` };
  }
  return null;
}

// ─── Copado status display ───────────────────────────────────────────────────
// Official: sf copado job status --jobid <id> --json  -> { jobStatus, steps[] }
function fetchJob(jobExecutionId) {
  const r = capture(`sf copado job status --jobid ${jobExecutionId} --json`);
  const parsed = tryJson(r.out);
  if (!parsed) return { error: r.err || r.out || 'empty response' };
  return {
    status: (findKey(parsed, ['jobStatus', 'status']) || 'UNKNOWN').toString().toUpperCase(),
    steps: (() => { const s = findKey(parsed, ['steps']); return Array.isArray(s) ? s : []; })()
  };
}

function renderJob(jobExecutionId, job) {
  line('-');
  console.log(`  JOB EXECUTION ID : ${jobExecutionId}`);
  console.log(`  OVERALL STATUS   : ${job.status}`);
  if (job.steps.length) {
    console.log('  STEP BREAKDOWN (same order as the Copado UI):');
    job.steps.forEach((step, i) => {
      const name = String(step.Name || step.name || step.apiName || step.copado__Name__c || `Step ${i + 1}`).padEnd(40);
      const st = String(step.copado__Status__c || step.status || 'UNKNOWN').toUpperCase();
      const c = classify(st);
      const icon = c === 'SUCCESS' ? ' OK ' : c === 'FAILED' ? 'FAIL' : st.includes('SKIP') ? 'SKIP' : '....';
      console.log(`    [${icon}] ${name} -> ${st}`);
    });
  } else {
    console.log('  (No step data returned yet.)');
  }
  line('-');
}

// Polls Copado and prints ONLY when something changed, so the terminal mirrors the UI.
function pollUntilDone(jobExecutionId) {
  const deadline = Date.now() + MAX_POLL_MINUTES * 60 * 1000;
  let lastSig = '';
  let consecutiveErrors = 0;

  while (Date.now() < deadline) {
    const job = fetchJob(jobExecutionId);

    if (job.error) {
      consecutiveErrors++;
      console.log(`  [poll] status query failed (${consecutiveErrors}/5): ${String(job.error).split('\n')[0]}`);
      if (consecutiveErrors >= 5) return { state: 'UNKNOWN', job: null };
    } else {
      consecutiveErrors = 0;
      const sig = job.status + '|' + job.steps.map(s => `${s.Name || s.name}:${s.copado__Status__c || s.status}`).join(',');
      if (sig !== lastSig) {
        console.log(`\n[${new Date().toLocaleTimeString()}] Status update`);
        renderJob(jobExecutionId, job);
        lastSig = sig;
      }
      const c = classify(job.status);
      if (c !== 'RUNNING') return { state: c, job };
    }
    sleep(POLL_INTERVAL_MS);
  }
  return { state: 'TIMEOUT', job: null };
}

// ─── submit (new syntax first, legacy fallback) ──────────────────────────────
function submitStory() {
  // COPADO_SUBMIT_CMD in .env overrides everything (use the exact command that works in your terminal).
  const cmds = process.env.COPADO_SUBMIT_CMD
    ? [process.env.COPADO_SUBMIT_CMD]
    : [
        'sf copado story submit --promote --deploy --json',   // CLI v3.12+
        'sf copado:work:submit --promote --deploy --json'     // CLI < v3.12
      ];
  const errors = [];
  for (const cmd of cmds) {
    console.log(`  Trying: ${cmd}`);
    const r = capture(cmd);
    if (r.ok) return r.out;
    const msg = `${r.err}\n${r.out}`.trim();
    console.log('  --- CLI said ---');
    console.log('  ' + msg.split('\n').slice(0, 12).join('\n  '));
    console.log('  ----------------');
    errors.push(`${cmd}\n${msg}`);
    // keep trying the next syntax only when the command itself is unknown
    if (!/is not a sf command|not a valid command|command .* not found|Unknown command/i.test(msg)) break;
  }
  throw new Error(
    'Story submit failed. Run these in your terminal to find the right command, then set COPADO_SUBMIT_CMD in .env:\n' +
    '  sf plugins\n  sf copado --help\n  sf copado story --help\n\n' + errors.join('\n\n'));
}

// ═════════════════════════════════════════════════════════════════════════════
// DEPLOY
// ═════════════════════════════════════════════════════════════════════════════
if (command === 'deploy') {
  line();
  console.log('[copado-hx] HEADLESS PROMOTION + AUTO-SNAPSHOT');
  line();

  const rbDir      = path.join(__dirname, '.rollback', storyId);
  const projectDir = path.join(rbDir, 'project');          // self-contained sfdx project holding the snapshot
  const manifestFp = path.join(rbDir, 'manifest.json');

  // Step 1 ── bind workspace
  console.log('\nStep 1: Setting active user story context...');
  try { run(`agentia cicd work set ${storyId}`); }
  catch (e) { console.error('Critical: could not set work item context.'); process.exit(1); }

  // Step 2 ── detect changed metadata
  console.log('\nStep 2: Scanning branch for metadata changes vs origin/main...');
  let changedFiles = [];
  let d = capture('git diff --name-only --diff-filter=ACMR origin/main...HEAD');
  if (!d.ok) d = capture('git diff --name-only --diff-filter=ACMR origin/main');
  if (d.ok) {
    changedFiles = d.out.split('\n').map(f => f.trim()).filter(f => f && f.replace(/\\/g, '/').includes('/main/default/'));
  } else {
    console.log('  Git diff unavailable; continuing without snapshot.');
  }

  const components = [];
  const seen = new Set();
  changedFiles.forEach(f => {
    const md = toMetadata(f);
    if (md && !seen.has(`${md.type}:${md.name}`)) { seen.add(`${md.type}:${md.name}`); components.push(md); }
  });
  console.log(`  ${changedFiles.length} changed file(s) -> ${components.length} metadata component(s).`);

  // Step 3 ── snapshot what is CURRENTLY in the target org
  const manifest = {
    storyId, targetOrg: TARGET_ORG, createdAt: new Date().toISOString(),
    snapshotted: [], createdNew: [], skipped: [],
    promotionId: '', jobExecutionId: '', finalStatus: 'NOT_SUBMITTED'
  };

  if (components.length) {
    console.log(`\nStep 3: Snapshotting current state of ${TARGET_ORG} into .rollback/${storyId}/ ...`);
    safeRm(rbDir);
    fs.mkdirSync(path.join(projectDir, 'force-app'), { recursive: true });

    let apiVersion = '61.0';
    try { apiVersion = JSON.parse(fs.readFileSync('sfdx-project.json', 'utf8')).sourceApiVersion || apiVersion; } catch (_) {}
    const projJson = { packageDirectories: [{ path: 'force-app', default: true }], sourceApiVersion: apiVersion };
    writeJson(path.join(projectDir, 'sfdx-project.json'), projJson);

    for (const c of components) {
      const key = `${c.type}:${c.name}`;
      // system temp dir: outside OneDrive, so no sync locks
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'copado-hx-'));
      try {
        fs.mkdirSync(path.join(tmp, 'force-app'), { recursive: true });
        writeJson(path.join(tmp, 'sfdx-project.json'), projJson);

        const r = capture(`sf project retrieve start --metadata "${key}" --target-org ${TARGET_ORG} --json`, { cwd: tmp });
        const got = fs.existsSync(path.join(tmp, 'force-app')) && fs.readdirSync(path.join(tmp, 'force-app')).length > 0;

        if (r.ok && got) {
          fs.cpSync(path.join(tmp, 'force-app'), path.join(projectDir, 'force-app'), { recursive: true });
          manifest.snapshotted.push(c);
          console.log(`  [saved] ${key}`);
        } else if (!r.ok && /auth|expired|no authorization|invalid_grant/i.test(r.out + r.err)) {
          console.error(`\nCritical: cannot reach org "${TARGET_ORG}" (auth problem). Aborting before deploying.`);
          console.error(r.err || r.out);
          process.exit(1);
        } else {
          manifest.createdNew.push(c);
          console.log(`  [new in ${TARGET_ORG}] ${key}`);
        }
      } finally {
        safeRm(tmp);
      }
    }
    writeJson(manifestFp, manifest);
  } else {
    console.log('\nStep 3: No mappable metadata changes. Skipping snapshot (undo will not be available).');
  }

  // Step 4 ── submit
  console.log('\nStep 4: Submitting User Story for Promotion + Deployment...');
  let submitOutput;
  try { submitOutput = submitStory(); }
  catch (e) {
    console.error('\nCritical: story submit failed.\n' + e.message);
    process.exit(1);
  }

  const parsed = tryJson(submitOutput);
  let jobExecutionId = '', promotionId = '';
  if (parsed) {
    jobExecutionId = findKey(parsed, ['jobExecutionId', 'job_execution_id', 'jobExecutionID']) || '';
    promotionId    = findKey(parsed, ['promotionId', 'promotion_id']) || '';
  } else {
    const jm = submitOutput.match(/job_?execution_?id[=:\s]+([a-zA-Z0-9]{15,18})/i);
    const pm = submitOutput.match(/promotion_?id[=:\s]+([a-zA-Z0-9]{15,18})/i);
    jobExecutionId = jm ? jm[1] : '';
    promotionId    = pm ? pm[1] : '';
  }

  manifest.promotionId = promotionId;
  manifest.jobExecutionId = jobExecutionId;
  manifest.finalStatus = 'SUBMITTED';
  if (components.length) writeJson(manifestFp, manifest);

  console.log('');
  if (promotionId) {
    console.log(`  Promotion ID     : ${promotionId}`);
    if (COPADO_UI_URL) console.log(`  Promotion in UI  : ${COPADO_UI_URL}/lightning/r/copado__Promotion__c/${promotionId}/view`);
  }
  if (jobExecutionId) {
    console.log(`  Job Execution ID : ${jobExecutionId}`);
    if (COPADO_UI_URL) console.log(`  Job in UI        : ${COPADO_UI_URL}/lightning/r/copado__JobExecution__c/${jobExecutionId}/view`);
  }

  if (!jobExecutionId) {
    console.log('\nWARNING: No Job Execution ID in the CLI output, so live status cannot be mirrored.');
    console.log('Raw CLI output:\n' + submitOutput);
    console.log('Check the promotion in the Copado UI.');
    process.exit(2);
  }

  // Step 5 ── mirror Copado UI status in the terminal until the job finishes
  console.log('\nStep 5: Mirroring Copado job status (Ctrl+C is safe, the job keeps running in Copado)...');
  const { state } = pollUntilDone(jobExecutionId);

  manifest.finalStatus = state;
  if (components.length) writeJson(manifestFp, manifest);

  console.log('');
  line();
  if (state === 'SUCCESS') {
    console.log(`DEPLOYMENT COMPLETED SUCCESSFULLY in ${TARGET_ORG}.`);
    if (components.length) console.log(`Rollback available:  node copado-hx.js undo ${storyId}`);
    line();
  } else if (state === 'FAILED') {
    console.log('DEPLOYMENT FAILED OR CANCELLED. Review the failing step above or in the Copado UI.');
    if (components.length) console.log(`If the org was partially changed:  node copado-hx.js undo ${storyId}`);
    line();
    process.exit(1);
  } else {
    console.log(`Polling ended without a final status (${state}).`);
    console.log(`Check manually:  sf copado job status --jobid ${jobExecutionId} --json`);
    line();
    process.exit(2);
  }

// ═════════════════════════════════════════════════════════════════════════════
// UNDO
// ═════════════════════════════════════════════════════════════════════════════
} else if (command === 'undo') {
  line();
  console.log('[copado-hx] SNAPSHOT ROLLBACK');
  line();

  const rbDir      = path.join(__dirname, '.rollback', storyId);
  const projectDir = path.join(rbDir, 'project');
  const manifestFp = path.join(rbDir, 'manifest.json');

  if (!fs.existsSync(manifestFp)) {
    console.log(`\nStopped: no snapshot found for "${storyId}" (.rollback/${storyId}/manifest.json).`);
    console.log('Run "deploy" first; a snapshot is taken automatically before each promotion.');
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestFp, 'utf8'));
  const org = manifest.targetOrg || TARGET_ORG;
  const deleteNew = flags.includes('--delete-new');

  console.log(`\nSnapshot taken : ${manifest.createdAt}`);
  console.log(`Target org     : ${org}`);
  console.log(`Restore        : ${manifest.snapshotted.length} component(s)`);
  console.log(`New in deploy  : ${manifest.createdNew.length} component(s) ${deleteNew ? '(WILL be deleted)' : '(kept; pass --delete-new to remove)'}`);

  // 1) restore previous versions
  if (manifest.snapshotted.length) {
    console.log('\nStep 1: Re-deploying pre-deployment versions...');
    try {
      run(`sf project deploy start --source-dir force-app --target-org ${org}`, { cwd: projectDir });
    } catch (e) {
      console.error('\nCritical: restore deployment failed. Snapshot is untouched in ' + projectDir);
      process.exit(1);
    }
  }

  // 2) optionally remove components that did not exist before the deploy
  if (deleteNew && manifest.createdNew.length) {
    console.log('\nStep 2: Removing components that were newly created by the deployment...');
    const destDir = path.join(rbDir, 'destructive');
    fs.mkdirSync(destDir, { recursive: true });
    const apiV = (JSON.parse(fs.readFileSync(path.join(projectDir, 'sfdx-project.json'), 'utf8')).sourceApiVersion) || '61.0';
    const byType = {};
    manifest.createdNew.forEach(c => { (byType[c.type] = byType[c.type] || []).push(c.name); });
    const types = Object.keys(byType).map(t =>
      `  <types>\n${byType[t].map(n => `    <members>${n}</members>`).join('\n')}\n    <name>${t}</name>\n  </types>`).join('\n');
    fs.writeFileSync(path.join(destDir, 'destructiveChangesPost.xml'),
      `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n${types}\n  <version>${apiV}</version>\n</Package>\n`);
    fs.writeFileSync(path.join(destDir, 'package.xml'),
      `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n  <version>${apiV}</version>\n</Package>\n`);
    try {
      run(`sf project deploy start --manifest package.xml --post-destructive-changes destructiveChangesPost.xml --target-org ${org}`, { cwd: destDir });
    } catch (e) {
      console.error('\nCritical: destructive rollback failed.');
      process.exit(1);
    }
  }

  manifest.rolledBackAt = new Date().toISOString();
  writeJson(manifestFp, manifest);

  line();
  console.log(`SUCCESS: ${org} rolled back to its pre-deployment state.`);
  line();
  console.log('Note: the Copado promotion record still shows the original deploy. Add a note or');
  console.log('a reverting promotion in Copado if your team needs the UI history to reflect the rollback.');

} else {
  console.log(`\nUnknown command: "${command}". Use "deploy" or "undo".`);
  process.exit(1);
}
