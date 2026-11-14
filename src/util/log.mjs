import fs from 'node:fs';
import path from 'node:path';
import { dataRoot } from './paths.mjs';
import { redact } from './redact.mjs';

let stream = null;
let streamDay = null;

/** Today's log file; a process that runs past midnight switches to the new day's file. */
function out() {
  const day = new Date().toISOString().slice(0, 10);
  if (stream && streamDay === day) return stream;
  try {
    stream?.end();
    fs.mkdirSync(path.join(dataRoot(), 'logs'), { recursive: true });
    stream = fs.createWriteStream(path.join(dataRoot(), 'logs', `sleeppilot-${day}.log`), { flags: 'a' });
    streamDay = day;
  } catch {
    stream = null;
  }
  return stream;
}

function write(level, scope, msg, extra) {
  const line = `${new Date().toISOString()} ${level.padEnd(5)} [${scope}] ${redact(msg)}${
    extra !== undefined ? ' ' + redact(typeof extra === 'string' ? extra : JSON.stringify(extra)) : ''
  }`;
  if (process.env.SLEEPPILOT_QUIET !== '1') (level === 'ERROR' ? console.error : console.log)(line);
  out()?.write(line + '\n');
}

export function logger(scope) {
  return {
    info: (m, e) => write('INFO', scope, m, e),
    warn: (m, e) => write('WARN', scope, m, e),
    error: (m, e) => write('ERROR', scope, m, e),
    debug: (m, e) => process.env.SLEEPPILOT_DEBUG === '1' && write('DEBUG', scope, m, e),
  };
}
