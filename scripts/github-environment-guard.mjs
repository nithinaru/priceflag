#!/usr/bin/env node

const API_VERSION = '2022-11-28';

function fail(message) {
  throw new Error(`GitHub Environment safety check failed: ${message}`);
}

export function assertEnvironmentConfiguration(environment, branchPolicies, options) {
  if (environment === null || typeof environment !== 'object' || environment.name !== options.environment) {
    fail('the expected environment does not exist');
  }

  const deploymentPolicy = environment.deployment_branch_policy;
  if (
    deploymentPolicy === null ||
    typeof deploymentPolicy !== 'object' ||
    deploymentPolicy.custom_branch_policies !== true ||
    deploymentPolicy.protected_branches !== false
  ) {
    fail('custom deployment-branch policies are not enabled');
  }

  const policies = Array.isArray(branchPolicies?.branch_policies) ? branchPolicies.branch_policies : [];
  const names = policies.map((policy) => policy?.name).filter((name) => typeof name === 'string').sort();
  const expectedNames = [...options.branches].sort();
  if (names.length !== expectedNames.length || names.some((name, index) => name !== expectedNames[index])) {
    fail('the deployment-branch allowlist is not exact');
  }

  const rules = Array.isArray(environment.protection_rules) ? environment.protection_rules : [];
  const reviewerRule = rules.find((rule) => rule?.type === 'required_reviewers');
  if (options.requireReviewer) {
    if (environment.can_admins_bypass !== false) {
      fail('administrator bypass is not disabled');
    }
    if (
      reviewerRule === undefined ||
      reviewerRule.prevent_self_review !== true ||
      !Array.isArray(reviewerRule.reviewers) ||
      reviewerRule.reviewers.length < 1
    ) {
      fail('required reviewers with self-review prevention are not configured');
    }
  }
}

async function getJson(url, token) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': 'priceflag-environment-guard',
    },
    redirect: 'error',
  });
  if (!response.ok) fail(`GitHub returned HTTP ${response.status}`);
  const body = await response.json();
  if (body === null || typeof body !== 'object') fail('GitHub returned an invalid response');
  return body;
}

async function main() {
  const [environment, branch, reviewMode] = process.argv.slice(2);
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!environment || !branch || !['required', 'optional'].includes(reviewMode ?? '')) {
    fail('usage: github-environment-guard.mjs <environment> <exact-branch> <required|optional>');
  }
  if (repository !== 'nithinaru/priceflag' || !token) {
    fail('the pinned repository identity and GITHUB_TOKEN are required');
  }

  const encodedEnvironment = encodeURIComponent(environment);
  const base = `https://api.github.com/repos/${repository}/environments/${encodedEnvironment}`;
  const [environmentBody, policyBody] = await Promise.all([
    getJson(base, token),
    getJson(`${base}/deployment-branch-policies?per_page=100`, token),
  ]);
  assertEnvironmentConfiguration(environmentBody, policyBody, {
    environment,
    branches: [branch],
    requireReviewer: reviewMode === 'required',
  });
  process.stdout.write(`GitHub Environment ${environment} has the required release boundary.\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
