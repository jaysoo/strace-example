#!/usr/bin/env node
/**
 * Run I/O tracer on all Nx projects with build targets
 * Outputs results to results/ directory
 */

import { execSync, spawnSync } from 'child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';

const RESULTS_DIR = '/tracer/results';
const TRACER_SCRIPT = '/tracer/tracer-nx.mjs';

// Projects to skip (e2e tests, examples, native binaries, docs)
const SKIP_PATTERNS = [
  /^e2e-/,
  /^examples-/,
  /^linux-/,
  /^win32-/,
  /^darwin-/,
  /^freebsd-/,
  /^astro-docs$/,
  /^docs$/,
  /^nx-dev/,  // skip nx-dev apps for now
  /^ui-/,     // skip ui libs for now
  /^data-access-/,
  /^feature-/,
  /^graph-/,
  /^tools-/,
];

// Only trace these targets
const TARGET_WHITELIST = ['build', 'build-base', 'build-native'];

function shouldSkipProject(project) {
  return SKIP_PATTERNS.some(pattern => pattern.test(project));
}

function getProjects() {
  try {
    const output = execSync('NX_DAEMON=false npx nx show projects', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NX_DAEMON: 'false' },
    });
    return output.trim().split('\n').filter(p => p && !shouldSkipProject(p));
  } catch (err) {
    console.error('Failed to get projects:', err.message);
    return [];
  }
}

function getProjectTargets(project) {
  try {
    const output = execSync(`NX_DAEMON=false npx nx show project ${project} --json`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NX_DAEMON: 'false' },
    });
    const config = JSON.parse(output);
    return Object.keys(config.targets || {}).filter(t => TARGET_WHITELIST.includes(t));
  } catch (err) {
    return [];
  }
}

function runTrace(project, target) {
  const taskId = `${project}:${target}`;
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Tracing: ${taskId}`);
  console.log('='.repeat(60));

  try {
    // Stream output to a temp file to handle large outputs
    const tempOutputFile = join(RESULTS_DIR, `_temp_${project}__${target}.txt`);

    const result = spawnSync('node', [TRACER_SCRIPT, taskId, '--skipNxCache'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 300000, // 5 min timeout
      env: { ...process.env, NX_DAEMON: 'false' },
      maxBuffer: 100 * 1024 * 1024, // 100MB buffer
    });

    const output = (result.stdout || '') + (result.stderr || '');

    // Parse JSON output from tracer - search from the end for better reliability
    // Look for the last "JSON OUTPUT:" in case there are multiple
    const jsonOutputIndex = output.lastIndexOf('JSON OUTPUT:');
    if (jsonOutputIndex !== -1) {
      const jsonPart = output.slice(jsonOutputIndex + 'JSON OUTPUT:'.length).trim();

      // Find the complete JSON object by matching braces
      let braceCount = 0;
      let jsonEnd = -1;
      let inString = false;
      let escapeNext = false;

      for (let i = 0; i < jsonPart.length; i++) {
        const char = jsonPart[i];

        if (escapeNext) {
          escapeNext = false;
          continue;
        }

        if (char === '\\' && inString) {
          escapeNext = true;
          continue;
        }

        if (char === '"' && !escapeNext) {
          inString = !inString;
          continue;
        }

        if (!inString) {
          if (char === '{') braceCount++;
          else if (char === '}') {
            braceCount--;
            if (braceCount === 0) {
              jsonEnd = i + 1;
              break;
            }
          }
        }
      }

      if (jsonEnd > 0) {
        try {
          const jsonStr = jsonPart.slice(0, jsonEnd);
          const jsonData = JSON.parse(jsonStr);
          return {
            taskId,
            success: true,
            exitCode: jsonData.exitCode,
            undeclaredReads: jsonData.undeclaredReads || [],
            undeclaredWrites: jsonData.undeclaredWrites || [],
            rawOutput: output.length > 50000 ? `[Output truncated - ${output.length} chars]` : output,
          };
        } catch (parseErr) {
          return {
            taskId,
            success: false,
            error: `JSON parse error: ${parseErr.message}`,
            rawOutput: output.length > 50000 ? `[Output truncated - ${output.length} chars]` : output,
          };
        }
      }
    }

    return {
      taskId,
      success: false,
      error: 'No JSON output found',
      rawOutput: output.length > 50000 ? `[Output truncated - ${output.length} chars]` : output,
    };
  } catch (err) {
    return {
      taskId,
      success: false,
      error: err.message,
    };
  }
}

function updateResultsFile(issuesFound, totalTasks, successfulTraces) {
  let markdown = `# I/O Tracing Results\n\n`;
  markdown += `**Last Updated**: ${new Date().toISOString()}\n`;
  markdown += `**Total Tasks Traced**: ${totalTasks}\n`;
  markdown += `**Successful Traces**: ${successfulTraces}\n`;
  markdown += `**Tasks with Undeclared I/O**: ${issuesFound.length}\n\n`;

  if (issuesFound.length > 0) {
    markdown += `## Issues Found\n\n`;
    for (const issue of issuesFound) {
      markdown += `### ${issue.taskId}\n\n`;
      if (issue.undeclaredReads.length > 0) {
        markdown += `**Undeclared Reads:**\n`;
        for (const read of issue.undeclaredReads) {
          markdown += `- \`${read}\`\n`;
        }
        markdown += '\n';
      }
      if (issue.undeclaredWrites.length > 0) {
        markdown += `**Undeclared Writes:**\n`;
        for (const write of issue.undeclaredWrites) {
          markdown += `- \`${write}\`\n`;
        }
        markdown += '\n';
      }
    }
  } else {
    markdown += `## ✅ No Issues Found Yet\n\nAll traced tasks so far have correctly declared inputs and outputs.\n`;
  }

  writeFileSync(join(RESULTS_DIR, 'RESULTS.md'), markdown);
}

function main() {
  // Create results directory
  mkdirSync(RESULTS_DIR, { recursive: true });

  console.log('Getting project list...');
  const projects = getProjects();
  console.log(`Found ${projects.length} projects to analyze`);

  const allResults = [];
  const issuesFound = [];

  // Initialize RESULTS.md
  updateResultsFile(issuesFound, 0, 0);

  for (const project of projects) {
    const targets = getProjectTargets(project);
    if (targets.length === 0) continue;

    for (const target of targets) {
      const result = runTrace(project, target);
      allResults.push(result);

      // Save individual result
      const safeTaskId = `${project}__${target}`.replace(/[^a-zA-Z0-9_-]/g, '_');
      writeFileSync(
        join(RESULTS_DIR, `${safeTaskId}.json`),
        JSON.stringify(result, null, 2)
      );

      // Track issues
      if (result.success && (result.undeclaredReads?.length > 0 || result.undeclaredWrites?.length > 0)) {
        issuesFound.push({
          taskId: result.taskId,
          undeclaredReads: result.undeclaredReads,
          undeclaredWrites: result.undeclaredWrites,
        });
        console.log(`⚠️  Found ${result.undeclaredReads.length} undeclared reads, ${result.undeclaredWrites.length} undeclared writes`);
      } else if (result.success) {
        console.log(`✅ All I/O declared correctly`);
      } else {
        console.log(`❌ Error: ${result.error}`);
      }

      // Update RESULTS.md incrementally after each task
      const successCount = allResults.filter(r => r.success).length;
      updateResultsFile(issuesFound, allResults.length, successCount);
    }
  }

  // Write final summary JSON
  const summary = {
    timestamp: new Date().toISOString(),
    totalTasks: allResults.length,
    successfulTraces: allResults.filter(r => r.success).length,
    tasksWithIssues: issuesFound.length,
    issues: issuesFound,
  };

  writeFileSync(join(RESULTS_DIR, 'summary.json'), JSON.stringify(summary, null, 2));

  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total tasks traced: ${summary.totalTasks}`);
  console.log(`Successful traces: ${summary.successfulTraces}`);
  console.log(`Tasks with issues: ${summary.tasksWithIssues}`);
  console.log(`\nResults saved to ${RESULTS_DIR}/`);
}

main();
