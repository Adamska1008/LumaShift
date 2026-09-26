import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRelease } from './check-release.mjs';

test('accepts matching version tags with or without v', () => {
  for (const tag of ['v0.1.0', '0.1.0']) {
    assert.deepEqual(validateRelease(tag, { npm: '0.1.0', cargo: '0.1.0' }), { version: '0.1.0', prerelease: false });
  }
});

test('recognizes explicitly configured prerelease versions', () => {
  assert.deepEqual(validateRelease('v0.1.0-rc.1', { npm: '0.1.0-rc.1' }), { version: '0.1.0-rc.1', prerelease: true });
});

test('rejects missing, mismatched and non-version tags', () => {
  assert.throws(() => validateRelease('v0.2.0', { npm: '0.1.0' }), /does not match/);
  assert.throws(() => validateRelease('v0.1.0', { cargo: undefined }), /does not match/);
  for (const tag of [undefined, 'latest', 'v01.1.0', 'v0.1', 'v0.1.0/other', 'v0.1.0\n']) {
    assert.throws(() => validateRelease(tag, { npm: '0.1.0' }));
  }
});
