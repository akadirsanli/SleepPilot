#!/usr/bin/env node
// Fake Android emulator: -list-avds, and "-avd NAME" adds emulator-5554 to the fake adb's devices.
import fs from 'node:fs';
const args = process.argv.slice(2);
const stateFile = process.env.FAKE_ADB_STATE;
if (args[0] === '-list-avds') {
  process.stdout.write(process.env.FAKE_AVDS ?? 'Pixel_7_API_34\n');
} else if (args[0] === '-avd') {
  setTimeout(() => {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    state.devices.push({ serial: 'emulator-5554', props: 'product:sdk_gphone64 model:sdk_gphone64_x86_64' });
    fs.writeFileSync(stateFile, JSON.stringify(state));
  }, 300);
  setInterval(() => {}, 1000);
}
