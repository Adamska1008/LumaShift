import { readFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function validateRelease(tag, versions) {
  const match = /^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?)$/.exec(tag ?? '');
  if (!match) throw new Error('Expected a version tag such as v0.1.0 or v0.1.0-rc.1');
  const version = match[1];
  for (const [file, actual] of Object.entries(versions)) {
    if (actual !== version) throw new Error(`${file}: version ${actual} does not match tag ${tag}. Set the version explicitly before tagging.`);
  }
  return { version, prerelease: version.includes('-') };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const json = path => JSON.parse(readFileSync(path, 'utf8'));
  const lock = json('package-lock.json');
  const cargo = readFileSync('src-tauri/Cargo.toml', 'utf8');
  const cargoLock = readFileSync('src-tauri/Cargo.lock', 'utf8');
  const { version, prerelease } = validateRelease(process.env.TAG_NAME, {
    'package.json': json('package.json').version,
    'package-lock.json': lock.version,
    'package-lock.json root': lock.packages[''].version,
    'tauri.conf.json': json('src-tauri/tauri.conf.json').version,
    'Cargo.toml': cargo.match(/\[package\]([\s\S]*?)(?=\n\[|$)/)?.[1].match(/^version\s*=\s*"([^"]+)"/m)?.[1],
    'Cargo.lock': cargoLock.match(/\[\[package\]\]\r?\nname = "lumashift"\r?\nversion = "([^"]+)"/)?.[1],
  });
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\nprerelease=${prerelease}\n`);
  console.log(`Release version verified: ${version}`);
}
