import { copyFile } from 'node:fs/promises';

// The CLI requires rules to be inside its project directory. Keep the committed
// app rule file as the only source of truth and copy it for this isolated project.
await copyFile(new URL('../firestore.rules', import.meta.url), new URL('./firestore.test.rules', import.meta.url));
