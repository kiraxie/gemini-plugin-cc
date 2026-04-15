/**
 * analyze command — quick project structure scan using DiscoveryEngine.
 *
 * No AI calls. Just filesystem scanning for project metadata.
 * Ported from gemini-plugin-cc-bkp/src/lib/discovery-engine.ts.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ProjectMetadata {
  rootPath: string;
  primaryLanguage: string;
  entryPoints: string[];
  projectName: string;
  description?: string;
  topLevelDirs: string[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

const PRUNE_DIRS = new Set([
  'node_modules', 'dist', 'build', '.git', '.next', '.nuxt',
  'coverage', '.cache', '__pycache__', 'venv', '.venv', 'vendor',
  'target', 'out', '.turbo', '.yarn',
]);

const METADATA_PROBES = [
  { file: 'package.json', lang: 'TypeScript/JavaScript' },
  { file: 'go.mod', lang: 'Go' },
  { file: 'pyproject.toml', lang: 'Python' },
  { file: 'requirements.txt', lang: 'Python' },
  { file: 'Cargo.toml', lang: 'Rust' },
  { file: 'pom.xml', lang: 'Java' },
  { file: 'build.gradle', lang: 'Java/Kotlin' },
  { file: 'build.gradle.kts', lang: 'Kotlin' },
  { file: 'CMakeLists.txt', lang: 'C/C++' },
  { file: 'Gemfile', lang: 'Ruby' },
  { file: 'composer.json', lang: 'PHP' },
];

const COMMON_ENTRIES = [
  'src/index.ts', 'src/index.js', 'src/main.ts', 'src/main.js',
  'index.ts', 'index.js', 'main.go', 'main.py', 'app.py', 'lib/index.js',
];

// ─── Discovery Engine ────────────────────────────────────────────────────────

function discover(startPath: string): ProjectMetadata {
  const rootPath = resolve(startPath);
  let primaryLanguage = 'Unknown';
  let projectName = 'unknown-project';
  let description: string | undefined;
  const entryPoints: string[] = [];

  for (const { file, lang } of METADATA_PROBES) {
    const filePath = join(rootPath, file);
    if (!existsSync(filePath)) continue;

    primaryLanguage = lang;

    if (file === 'package.json') {
      try {
        const pkg = JSON.parse(readFileSync(filePath, 'utf-8'));
        if (pkg.name) projectName = pkg.name;
        if (pkg.description) description = pkg.description;
        if (pkg.main) entryPoints.push(pkg.main);
        if (pkg.bin && typeof pkg.bin === 'object') {
          for (const bin of Object.values(pkg.bin)) entryPoints.push(bin as string);
        }
      } catch {
        // Ignore malformed package.json
      }
    }

    if (file === 'go.mod') {
      const content = readFileSync(filePath, 'utf-8');
      const match = /^module\s+(.+)$/m.exec(content);
      if (match?.[1]) projectName = match[1].split('/').pop() ?? projectName;
    }

    if (file === 'Cargo.toml') {
      const content = readFileSync(filePath, 'utf-8');
      const match = /^name\s*=\s*"(.+)"/m.exec(content);
      if (match?.[1]) projectName = match[1];
    }

    break;
  }

  // Prepend README if present
  for (const readme of ['README.md', 'README.rst', 'README.txt', 'README']) {
    if (existsSync(join(rootPath, readme))) {
      entryPoints.unshift(readme);
      break;
    }
  }

  // Add common source entry points
  for (const entry of COMMON_ENTRIES) {
    if (existsSync(join(rootPath, entry)) && !entryPoints.includes(entry)) {
      entryPoints.push(entry);
    }
  }

  const topLevelDirs = getTopLevelDirs(rootPath);

  return { rootPath, primaryLanguage, entryPoints, projectName, description, topLevelDirs };
}

function getTopLevelDirs(rootPath: string): string[] {
  try {
    return readdirSync(rootPath)
      .filter(name => {
        if (PRUNE_DIRS.has(name) || name.startsWith('.')) return false;
        try {
          return statSync(join(rootPath, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

// ─── Command ─────────────────────────────────────────────────────────────────

export async function runAnalyze(options: { path?: string; focus?: string }): Promise<void> {
  const projectPath = resolve(options.path ?? process.cwd());
  const metadata = discover(projectPath);

  console.log(`## Project Analysis: ${metadata.projectName}

**Path:** ${metadata.rootPath}
**Language:** ${metadata.primaryLanguage}
${metadata.description ? `**Description:** ${metadata.description}\n` : ''}
### Entry Points
${metadata.entryPoints.length > 0 ? metadata.entryPoints.map(e => `- ${e}`).join('\n') : '(none detected)'}

### Top-Level Directories
${metadata.topLevelDirs.length > 0 ? metadata.topLevelDirs.map(d => `- ${d}/`).join('\n') : '(none)'}
`);

  if (options.focus) {
    const focusPath = resolve(projectPath, options.focus);
    if (existsSync(focusPath)) {
      const focusDirs = getTopLevelDirs(focusPath);
      console.log(`### Focus: ${options.focus}
${focusDirs.length > 0 ? focusDirs.map(d => `- ${d}/`).join('\n') : '(no subdirectories)'}
`);
    } else {
      console.log(`### Focus: ${options.focus}\n(path not found)\n`);
    }
  }
}
