#!/usr/bin/env node
/**
 * build.js — Builds musespark.exe with WINDOWS subsystem (no console window)
 * 
 * 1. Runs pkg to create the base exe
 * 2. Patches the PE header subsystem from CONSOLE (3) to WINDOWS (2)
 *    so the exe runs as a proper GUI application with no console window
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EXE_PATH = path.join(ROOT, 'musespark.exe');

// Step 1: Run pkg
console.log('[build] Running pkg...');
try {
  execSync('npx pkg . --targets node18-win-x64 --output musespark.exe --no-bytecode', {
    cwd: ROOT,
    stdio: 'inherit'
  });
} catch (e) {
  console.error('[build] pkg failed:', e.message);
  process.exit(1);
}

// Step 2: Patch PE subsystem from CONSOLE to WINDOWS
console.log('[build] Patching PE subsystem: CONSOLE -> WINDOWS...');
try {
  const buf = fs.readFileSync(EXE_PATH);
  
  // Find the PE signature. The DOS header has the PE offset at offset 0x3C
  const peOffset = buf.readUInt32LE(0x3C);
  
  // Verify PE signature
  if (buf[peOffset] !== 0x50 || buf[peOffset + 1] !== 0x45) {
    throw new Error('Not a valid PE file');
  }
  
  // COFF header starts at peOffset + 4
  // Optional header starts at peOffset + 24
  // Subsystem field is at offset 68 from the start of the optional header
  const subsystemOffset = peOffset + 24 + 68;
  
  const currentSubsystem = buf.readUInt16LE(subsystemOffset);
  console.log(`[build] Current subsystem: ${currentSubsystem} (3=CONSOLE, 2=WINDOWS)`);
  
  if (currentSubsystem === 2) {
    console.log('[build] Already WINDOWS subsystem, no patch needed.');
  } else {
    // Change subsystem to WINDOWS (2)
    buf.writeUInt16LE(2, subsystemOffset);
    fs.writeFileSync(EXE_PATH, buf);
    console.log('[build] Patched subsystem to WINDOWS (2)');
  }
  
  // Verify
  const verify = fs.readFileSync(EXE_PATH);
  const verifySubsystem = verify.readUInt16LE(subsystemOffset);
  console.log(`[build] Verified subsystem: ${verifySubsystem} (${verifySubsystem === 2 ? 'WINDOWS' : verifySubsystem === 3 ? 'CONSOLE' : 'UNKNOWN'})`);
} catch (e) {
  console.error('[build] PE patch failed:', e.message);
  console.error('[build] The exe will still work but will show a console window.');
}

// Step 3: Report
const stats = fs.statSync(EXE_PATH);
console.log(`[build] Done! musespark.exe ${(stats.size / 1024 / 1024).toFixed(1)} MB`);