const { readdirSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const root = resolve(__dirname, '..');
const files = [
  ...readdirSync(root).filter(name => name.endsWith('.js')).map(name => join(root, name)),
  ...['scripts', 'tests'].flatMap(directory => readdirSync(join(root, directory))
    .filter(name => name.endsWith('.js')).map(name => join(root, directory, name)))
].sort();

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log(`Syntax OK: ${files.length} JavaScript files`);
