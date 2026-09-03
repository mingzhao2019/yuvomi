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
const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');

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

test('Docker publishing injects the immutable Git revision into the image', () => {
  const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf('\nFROM ') + 1);
  assert.match(runtimeStage, /^ARG APP_BUILD_REVISION$/m);
  assert.match(runtimeStage, /^ENV APP_BUILD_REVISION=\$\{APP_BUILD_REVISION\}$/m);
  assert.ok(
    runtimeStage.indexOf('ARG APP_BUILD_REVISION') > runtimeStage.lastIndexOf('\nRUN ')
      && runtimeStage.indexOf('ARG APP_BUILD_REVISION') > runtimeStage.lastIndexOf('\nCOPY '),
    'The per-commit revision must not invalidate stable runtime filesystem layers',
  );

  const buildStepStart = workflow.indexOf('      - name: Build and push');
  assert.notEqual(buildStepStart, -1, 'The Docker build-and-push step must exist');
  const nextStep = workflow.indexOf('\n      - name:', buildStepStart + 1);
  const buildStep = workflow.slice(buildStepStart, nextStep === -1 ? undefined : nextStep);
  assert.match(buildStep, /uses: docker\/build-push-action@v7/);
  assert.match(
    buildStep,
    /build-args:\s*\|\s*APP_BUILD_REVISION=\$\{\{ github\.sha \}\}/,
  );
});
