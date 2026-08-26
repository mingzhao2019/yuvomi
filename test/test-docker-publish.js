import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(
  new URL('../.github/workflows/docker-publish.yml', import.meta.url),
  'utf8'
);
const featureWorkflow = readFileSync(
  new URL('../.github/workflows/docker-publish-feature-work.yml', import.meta.url),
  'utf8'
);

test('Docker publish treats the remote build cache as an optional optimization', () => {
  assert.match(
    workflow,
    /cache-to:\s*type=gha,mode=max,ignore-error=true/,
    'A failed GitHub Actions cache export must not fail an otherwise successful image push'
  );
});

test('feature image publish is isolated to codex/feature-work', () => {
  assert.match(
    featureWorkflow,
    /branches:\s*\n\s*- codex\/feature-work/,
    'The feature image workflow must only run for the custom feature branch'
  );
  assert.match(
    featureWorkflow,
    /type=raw,value=feature-work/,
    'The feature workflow must publish a stable feature-work image tag'
  );
  assert.match(
    featureWorkflow,
    /platforms:\s*linux\/amd64,linux\/arm64/,
    'The feature image must keep the supported multi-architecture build'
  );
  assert.doesNotMatch(
    featureWorkflow,
    /repository_owner\s*\/\s*oikos/,
    'The custom feature workflow must not publish the upstream legacy image'
  );
});
