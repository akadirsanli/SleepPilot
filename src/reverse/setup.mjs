import fsp from 'node:fs/promises';
import path from 'node:path';
import { buildTargetMirror, MIRROR_DIR } from '../project/target-mirror.mjs';
import { runRecon, RECON_DIR } from './recon.mjs';
import { scaffoldRustProject, detectCargo, crateNameFrom } from './rust.mjs';
import { reverseObjective, reverseRules, reverseChecks, isRustMode, REVERSE_MODES } from './playbook.mjs';

const MODE_IDS = new Set(REVERSE_MODES.map((m) => m.id));

/**
 * Create or refresh a reverse-engineering workspace. Steps:
 *   1. validate the target and workspace
 *   2. mirror the target's text (read-only, line-preserving)
 *   3. run the binary/text reconnaissance and write _recon/
 *   4. scaffold a Cargo project (Analyze + Rust mode)
 *   5. store the objective, rules and checks on the project
 */
export async function buildReverseProject({ store, engine, settings, options = {} }) {
  const {
    name,
    targetDir,
    targetPath,
    workDir,
    goals,
    mode = 'rust',
    language = 'en',
    ack,
    engine: engineId,
    durationMin = 480,
    unattended = true,
    permissionProfile = 'full',
  } = options;
  if (!ack) throw new Error('Confirm that you have the right to analyse this target before continuing.');
  const chosenMode = MODE_IDS.has(mode) ? mode : 'rust';
  const target = path.resolve(targetPath || targetDir || '');
  if (!target) throw new Error('The target path is required.');
  if (!workDir || !path.isAbsolute(workDir)) throw new Error('The absolute path of the workspace folder is required.');
  const work = path.resolve(workDir);
  const tstat = await fsp.stat(target).catch(() => null);
  if (!tstat) throw new Error(`The target was not found: ${target}`);
  if (!tstat.isFile() && !tstat.isDirectory()) throw new Error('The target must be a file or a folder.');
  const same = target.toLowerCase() === work.toLowerCase();
  const workInsideTarget = tstat.isDirectory() && work.toLowerCase().startsWith(target.toLowerCase() + path.sep);
  const targetInsideWork = target.toLowerCase().startsWith(work.toLowerCase() + path.sep);
  if (same || workInsideTarget) throw new Error('The workspace cannot be the target or inside it; choose a separate folder.');
  if (targetInsideWork) throw new Error('The target cannot be inside the workspace; choose a separate workspace folder.');
  await fsp.mkdir(work, { recursive: true });

  const mirror = await buildTargetMirror({ targetDir: tstat.isDirectory() ? target : undefined, targetFile: tstat.isFile() ? target : undefined, workDir: work });
  const recon = await runRecon({ targetPath: target, workDir: work, map: mirror });
  const cargo = await detectCargo();
  let rust = null;
  if (isRustMode(chosenMode)) {
    rust = await scaffoldRustProject({ projectDir: work, name: name || path.basename(target) });
  }

  const existing = await store.findProjectByDir(work);
  const project = existing || (await store.createProject({ name: name || `${isRustMode(chosenMode) ? 'Reverse & Rust' : 'Reverse'} — ${path.basename(target)}`, dir: work }));
  project.kind = isRustMode(chosenMode) ? 'reverse-rust' : 'reverse';
  project.name = String(name || project.name).slice(0, 120);
  project.reverse = {
    targetPath: target,
    targetIsFile: tstat.isFile(),
    targetDir: tstat.isDirectory() ? target : path.dirname(target),
    workDir: work,
    mode: chosenMode,
    mirror: MIRROR_DIR,
    recon: RECON_DIR,
    files: mirror.files.length,
    binaries: recon.binaries,
    builtAt: mirror.builtAt,
    cargo: { available: !!cargo.found, version: cargo.version || null, scaffolded: !!rust?.scaffolded },
  };
  const engineObj = engine || null;
  const defaultModel = engineObj?.defaultModel || engineObj?.models?.[0] || null;
  const currentModels = project.settings?.models || {};
  const pick = (m) => (m && engineObj?.models?.some((x) => x.providerID === m.providerID && x.id === m.id) ? m : defaultModel);
  project.settings = {
    ...project.settings,
    engine: engineId || engineObj?.id || project.settings?.engine || settings?.engine || null,
    models: {
      manager: pick(currentModels.manager),
      developer: pick(currentModels.developer),
      reviewer: pick(currentModels.reviewer),
    },
    language: language === 'tr' ? 'tr' : 'en',
    durationMin: Math.max(15, Math.min(10_080, Number(durationMin) || 480)),
    maxIterations: 80,
    maxAttemptsSameFailure: 3,
    reviewerEnabled: true,
    parallelDevelopers: 1,
    unattended: !!unattended,
    permissionProfile,
    protectedPaths: [...new Set([...(project.settings?.protectedPaths || []), target, MIRROR_DIR, RECON_DIR])],
    scopeMode: 'strict',
    backupBeforeRun: true,
    closingReport: true,
    finalGraceMin: 30,
    carryOverTasks: false,
    improvementMode: false,
  };
  project.rules = reverseRules();
  project.checks = reverseChecks(chosenMode, { cargo: !!cargo.found });
  store.setObjective(project, reverseObjective({ targetPath: target, workDir: work, goals, mode: chosenMode, language, recon: recon.recon }), { source: 'user' });
  project.setup = {
    mode: chosenMode,
    crate: rust?.crate || (isRustMode(chosenMode) ? crateNameFrom(name || path.basename(target)) : null),
    reconAt: Date.now(),
    cargo: cargo.found ? cargo.version : null,
  };
  await store.saveProject(project);
  return project;
}

/** Quick summary for the UI after creation. */
export function reverseSummary(project) {
  return {
    mode: project.reverse?.mode,
    target: project.reverse?.targetPath,
    files: project.reverse?.files,
    binaries: project.reverse?.binaries,
    cargo: project.reverse?.cargo,
    crate: project.setup?.crate,
    checks: (project.checks || []).map((c) => ({ name: c.name, enabled: c.enabled })),
  };
}
