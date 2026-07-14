#!/usr/bin/env node

const SCOPE_OUTPUTS = ["quality", "build", "database", "browser", "containers", "dependencies"];

function isTrue(value) {
  return value === "true";
}

export function rejectedJobs(jobs, eventName) {
  const scope = jobs.scope;
  if (!scope || scope.result !== "success") {
    return [`scope=${scope?.result ?? "missing"} (required success)`];
  }

  const outputs = scope.outputs ?? {};
  const invalidOutputs = SCOPE_OUTPUTS.filter((key) => !["true", "false"].includes(outputs[key]));
  if (invalidOutputs.length) {
    return invalidOutputs.map((key) => `scope.${key}=${outputs[key] ?? "missing"} (required boolean output)`);
  }

  const required = {
    scope: true,
    hygiene: true,
    quality: isTrue(outputs.quality),
    "application-build": isTrue(outputs.build),
    "database-integration": isTrue(outputs.database),
    "railway-containers": isTrue(outputs.containers),
    browser: isTrue(outputs.browser),
    "dependency-audit": isTrue(outputs.dependencies),
    "compatibility-node20": eventName === "push" || eventName === "schedule",
    coverage: eventName === "schedule",
  };

  return Object.entries(required).flatMap(([name, mustRun]) => {
    const result = jobs[name]?.result ?? "missing";
    if (result === "success") return [];
    if (!mustRun && result === "skipped") return [];
    return [`${name}=${result} (${mustRun ? "required success" : "expected success or intentional skip"})`];
  });
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const jobs = JSON.parse(process.env.JOB_RESULTS ?? "{}");
    const failures = rejectedJobs(jobs, process.env.EVENT_NAME ?? "");
    if (failures.length) {
      console.error("CI Gate rejected:", failures.join(", "));
      process.exit(1);
    }
    console.log("CI Gate accepted all required jobs and scope-approved skips.");
  } catch (error) {
    console.error(`[ci-gate] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
