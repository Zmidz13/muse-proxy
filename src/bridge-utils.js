/**
 * bridge-utils.js
 * 
 * Utilitarios para o modo bridge (start2).
 */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

module.exports = { sleep, nowIso };
