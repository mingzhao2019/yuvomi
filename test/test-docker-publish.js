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

test('custom image publish is isolated to custom', () => {
  assert.match(
    featureWorkflow,
    /branches:\s*\n\s*- custom/,
    'The custom image workflow must only run for the custom branch'
  );
  assert.match(
    featureWorkflow,
    /type=raw,value=custom/,
    'The custom workflow must publish a stable custom image tag'
  );
  assert.match(
    featureWorkflow,
    /platforms:\s*linux\/amd64,linux\/arm64/,
    'The custom image must keep the supported multi-architecture build'
  );
  assert.doesNotMatch(
    featureWorkflow,
    /repository_owner\s*\/\s*oikos/,
    'The custom workflow must not publish the upstream legacy image'
  );
});
