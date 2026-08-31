const { randomBytes } = require('node:crypto');
const os = require('node:os');
const { app, safeStorage } = require('electron');

app.whenReady().then(() => {
  const available = safeStorage.isEncryptionAvailable();
  if (!available) {
    process.stdout.write(`${JSON.stringify({ available: false })}\n`);
    process.exitCode = 1;
    app.quit();
    return;
  }
  const secret = randomBytes(32).toString('hex');
  const encrypted = safeStorage.encryptString(secret);
  const decrypted = safeStorage.decryptString(encrypted);
  if (decrypted !== secret || encrypted.includes(Buffer.from(secret))) {
    throw new Error('Electron safeStorage round trip failed');
  }
  process.stdout.write(`${JSON.stringify({
    available: true,
    encryptedBytes: encrypted.length,
    plaintextPersisted: false,
    runtime: {
      os: os.platform(),
      osVersion: os.release(),
      architecture: os.arch(),
      nodeVersion: process.versions.node,
      electronVersion: process.versions.electron
    }
  })}\n`);
  app.quit();
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
  app.quit();
});
