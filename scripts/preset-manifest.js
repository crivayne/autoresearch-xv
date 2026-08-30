'use strict';

const fs = require('fs');
const path = require('path');

const PRESET_MANIFEST_FILE = '.ai-preset.json';
const PRESET_MANIFEST_KEYS = ['schemaVersion', 'name', 'version', 'source'];
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function isSemVer(value) {
  if (typeof value !== 'string' || !SEMVER_PATTERN.test(value)) return false;
  const plusIndex = value.indexOf('+');
  const dashIndex = value.indexOf('-');
  if (dashIndex < 0 || (plusIndex >= 0 && dashIndex > plusIndex)) return true;
  const prerelease = value.slice(dashIndex + 1, plusIndex >= 0 ? plusIndex : undefined);
  return prerelease.split('.').every((identifier) => !/^\d+$/.test(identifier) || !/^0\d+/.test(identifier));
}

function inspectPresetManifest(manifest) {
  const issues = [];
  if (!manifest || Array.isArray(manifest) || typeof manifest !== 'object') {
    return ['최상위 값은 JSON object여야 합니다.'];
  }
  const keys = Object.keys(manifest);
  PRESET_MANIFEST_KEYS.filter((key) => !keys.includes(key)).forEach((key) => issues.push(`필수 key 누락: ${key}`));
  keys.filter((key) => !PRESET_MANIFEST_KEYS.includes(key)).forEach((key) => issues.push(`알 수 없는 key: ${key}`));
  if (manifest.schemaVersion !== 1) issues.push('schemaVersion은 숫자 1이어야 합니다.');
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) issues.push('name은 비어 있지 않은 문자열이어야 합니다.');
  if (!isSemVer(manifest.version)) {
    issues.push('version은 유효한 SemVer 문자열이어야 합니다.');
  }
  if (typeof manifest.source !== 'string' || !manifest.source.trim()) {
    issues.push('source는 비어 있지 않은 HTTP(S) URL이어야 합니다.');
  } else {
    try {
      const url = new URL(manifest.source);
      if (!['http:', 'https:'].includes(url.protocol)) issues.push('source는 HTTP(S) URL이어야 합니다.');
    } catch (_) {
      issues.push('source는 유효한 절대 URL이어야 합니다.');
    }
  }
  return issues;
}

function loadPresetManifest(repoRoot) {
  const manifestPath = path.join(repoRoot, PRESET_MANIFEST_FILE);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  return { manifest, issues: inspectPresetManifest(manifest) };
}

module.exports = { PRESET_MANIFEST_FILE, loadPresetManifest };
