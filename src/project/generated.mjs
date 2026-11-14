/**
 * Generated files: build output, packaged dependencies, lock files. They are still tracked as
 * changes, but they are not "code written" — counting them made one real run report +363,534
 * lines, almost all of it PyInstaller output (dist/, build/, .tcl, .enc, .toc). They are also
 * left out of the reviewer's diff (they cost tokens and say nothing about the change).
 */
const GENERATED_DIRS = new Set(['dist', 'build', 'out', 'target', 'coverage', 'htmlcov', '.next', '.nuxt', '.parcel-cache', '.pytest_cache', '.mypy_cache', '__pycache__', '.tox', 'node_modules', 'bin', 'obj', '.gradle', '.venv', 'venv', '_target', '_recon']);
const GENERATED_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'poetry.lock', 'pipfile.lock', 'cargo.lock', 'composer.lock']);
const GENERATED_EXT = /\.(pyc|pyo|class|o|obj|so|dll|exe|map|min\.js|min\.css|toc|pyz|pkg|whl)$/i;

export function isGeneratedPath(file) {
  const parts = String(file).replace(/\\/g, '/').split('/');
  const name = parts.at(-1).toLowerCase();
  if (GENERATED_FILES.has(name) || GENERATED_EXT.test(name)) return true;
  return parts.slice(0, -1).some((p) => GENERATED_DIRS.has(p.toLowerCase()) || p.toLowerCase().endsWith('.egg-info'));
}
