#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';

const severityRank = {
  none: 0,
  info: 0,
  change: 1,
  warn: 2,
  error: 3,
};

function usage() {
  return `Usage:
  node validate_vue_i18n_messages.mjs --project-root . --locale src/locale/zh-CN.json --keys APEX0001,APEX0002
  node validate_vue_i18n_messages.mjs --project-root . --message "包含特殊字符（如 !@#$%^&*）"

Options:
  --project-root <dir>       Project root that owns node_modules/vue-i18n. Default: cwd
  --locale <file>            Locale JSON file relative to project root. Repeatable or comma-separated
  --keys <list>              Keys to validate. Comma or whitespace separated
  --keys-file <file>         File containing keys. Comma or whitespace separated
  --message <text>           Inline message to validate before it is written to locale JSON. Repeatable
  --all                      Validate all keys from locale files when no key list is supplied
  --strict-placeholders      Treat placeholder/output-changing syntax as warnings
  --allow-html               Do not fail HTML-like message warnings
  --fail-on <level>          none | change | warn | error. Default: warn
  --max-issues <n>           Max issues printed in human output. Default: 50
  --json                     Print JSON report
`;
}

function parseList(value) {
  if (!value) return [];
  return value.split(/[\s,]+/).map(item => item.trim()).filter(Boolean);
}

function parseArgs(argv) {
  const args = {
    projectRoot: process.cwd(),
    locales: [],
    keys: [],
    keyFiles: [],
    messages: [],
    all: false,
    strictPlaceholders: false,
    allowHtml: false,
    failOn: 'warn',
    maxIssues: 50,
    json: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const raw = argv[i];
    const [flag, inlineValue] = raw.includes('=') ? raw.split(/=(.*)/s, 2) : [raw, undefined];
    const readValue = () => {
      if (inlineValue !== undefined) return inlineValue;
      i += 1;
      if (i >= argv.length) throw new Error(`Missing value for ${flag}`);
      return argv[i];
    };

    if (flag === '--help' || flag === '-h') {
      console.log(usage());
      process.exit(0);
    } else if (flag === '--project-root') {
      args.projectRoot = readValue();
    } else if (flag === '--locale') {
      args.locales.push(...parseList(readValue()));
    } else if (flag === '--keys') {
      args.keys.push(...parseList(readValue()));
    } else if (flag === '--keys-file') {
      args.keyFiles.push(readValue());
    } else if (flag === '--message') {
      args.messages.push(readValue());
    } else if (flag === '--all') {
      args.all = true;
    } else if (flag === '--strict-placeholders') {
      args.strictPlaceholders = true;
    } else if (flag === '--allow-html') {
      args.allowHtml = true;
    } else if (flag === '--fail-on') {
      args.failOn = readValue();
    } else if (flag === '--max-issues') {
      args.maxIssues = Number(readValue()) || args.maxIssues;
    } else if (flag === '--json') {
      args.json = true;
    } else {
      throw new Error(`Unknown option: ${raw}`);
    }
  }

  if (!(args.failOn in severityRank)) {
    throw new Error(`Invalid --fail-on value: ${args.failOn}`);
  }

  args.projectRoot = path.resolve(args.projectRoot);
  return args;
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function readJson(filePath) {
  try {
    return JSON.parse(readText(filePath));
  } catch (error) {
    throw new Error(`Failed to parse JSON: ${filePath}: ${error.message}`);
  }
}

async function loadVueI18n(projectRoot) {
  const packageJson = path.join(projectRoot, 'package.json');
  const requireFromProject = createRequire(packageJson);
  try {
    return requireFromProject('vue-i18n');
  } catch (error) {
    try {
      const resolved = requireFromProject.resolve('vue-i18n');
      return await import(pathToFileURL(resolved).href);
    } catch (fallbackError) {
      throw new Error(
        `Cannot load vue-i18n from ${projectRoot}. Original: ${error.message}; fallback: ${fallbackError.message}`,
      );
    }
  }
}

function resolveLocaleFiles(args) {
  if (args.locales.length > 0) {
    return args.locales.map(file => path.resolve(args.projectRoot, file));
  }

  const defaultFile = path.join(args.projectRoot, 'src/locale/zh-CN.json');
  if (fs.existsSync(defaultFile)) return [defaultFile];

  const localeDir = path.join(args.projectRoot, 'src/locale');
  if (!fs.existsSync(localeDir)) return [];
  return fs.readdirSync(localeDir)
    .filter(file => file.endsWith('.json'))
    .map(file => path.join(localeDir, file));
}

function readKeySet(args) {
  const keys = [...args.keys];
  for (const file of args.keyFiles) {
    const resolved = path.resolve(args.projectRoot, file);
    keys.push(...parseList(readText(resolved)));
  }
  return new Set(keys);
}

function stripI18nLiterals(message) {
  return message.replace(/\{\s*'(?:[^'\\]|\\.)*'\s*\}/g, '');
}

function hasHtmlLikeTag(message) {
  return /<\/?[A-Za-z][^>]*>/.test(message);
}

function captureConsole(fn) {
  const logs = [];
  const oldWarn = console.warn;
  const oldError = console.error;
  console.warn = (...items) => logs.push({ level: 'warn', message: items.join(' ') });
  console.error = (...items) => logs.push({ level: 'error', message: items.join(' ') });
  let output = '';
  let thrown = '';
  try {
    output = fn();
  } catch (error) {
    thrown = error?.message || String(error);
  } finally {
    console.warn = oldWarn;
    console.error = oldError;
  }
  return { output, thrown, logs };
}

function addIssue(issues, severity, code, detail) {
  issues.push({ severity, code, detail });
}

function validateMessage(createI18n, entry, options) {
  const issues = [];
  const value = entry.value;
  const stripped = stripI18nLiterals(value);
  const i18n = createI18n({
    legacy: false,
    locale: 'zh',
    missingWarn: false,
    fallbackWarn: false,
    messages: {
      zh: {
        __codex_target__: value,
        __codex_linked__: 'LINKED',
      },
    },
  });

  const render = captureConsole(() => i18n.global.t('__codex_target__'));

  if (render.thrown) {
    addIssue(issues, 'error', 'vue-i18n-throw', render.thrown);
  }

  for (const log of render.logs) {
    const severity = log.level === 'error' ? 'error' : 'warn';
    if (options.allowHtml && /Detected HTML/.test(log.message)) continue;
    addIssue(issues, severity, `vue-i18n-${log.level}`, log.message.split('\n')[0]);
  }

  if (!options.allowHtml && hasHtmlLikeTag(value)) {
    addIssue(issues, 'warn', 'html-like-message', 'HTML-like tags should not be stored as i18n message text.');
  }

  if (/@(?:\.|:)/.test(stripped)) {
    addIssue(issues, 'warn', 'linked-message-syntax', '`@:` or `@.modifier:` will be resolved as linked-message syntax.');
  } else if (stripped.includes('@')) {
    addIssue(issues, 'warn', 'bare-at', 'Bare `@` can be parsed as linked-message syntax. Use literal interpolation or params.');
  }

  if (stripped.includes('|')) {
    addIssue(issues, 'warn', 'choice-pipe', '`|` is parsed as choice/plural syntax. Escape it if it is plain text.');
  }

  if (/[{}]/.test(stripped)) {
    const severity = options.strictPlaceholders ? 'warn' : 'info';
    addIssue(issues, severity, 'placeholder-or-brace', '`{...}` is interpolation syntax. Confirm call-site params or escape plain braces.');
  }

  const onlyLiteralChange = value !== stripped && render.output !== value && render.output === value.replace(/\{\s*'((?:[^'\\]|\\.)*)'\s*\}/g, '$1');
  if (render.output !== value && !onlyLiteralChange) {
    const severity = options.strictPlaceholders ? 'warn' : 'change';
    addIssue(issues, severity, 'output-changed-without-args', `t(key) rendered as: ${render.output}`);
  }

  const maxSeverity = issues.reduce((max, issue) => Math.max(max, severityRank[issue.severity]), 0);
  return {
    ...entry,
    output: render.output,
    issues,
    maxSeverity,
  };
}

function collectEntries(args) {
  const keySet = readKeySet(args);
  const entries = [];
  const shouldReadLocaleFiles = args.locales.length > 0 || keySet.size > 0 || args.all || args.messages.length === 0;

  if (shouldReadLocaleFiles) {
    for (const localeFile of resolveLocaleFiles(args)) {
      const json = readJson(localeFile);
      for (const [key, value] of Object.entries(json)) {
        if (typeof value !== 'string') continue;
        if (keySet.size > 0 && !keySet.has(key)) continue;
        entries.push({ source: path.relative(args.projectRoot, localeFile), key, value });
      }
    }
  }

  args.messages.forEach((message, index) => {
    entries.push({ source: '<inline>', key: `inline-${index + 1}`, value: message });
  });

  if (keySet.size > 0) {
    const found = new Set(entries.map(entry => entry.key));
    for (const key of keySet) {
      if (!found.has(key)) {
        entries.push({ source: '<missing>', key, value: '', missing: true });
      }
    }
  }

  if (shouldReadLocaleFiles && keySet.size === 0 && args.messages.length === 0 && !args.all) {
    console.warn('[i18n-validate] No --keys/--keys-file/--message supplied; validating all locale messages. Use --keys-file for generated-key checks.');
  }

  return entries;
}

function printHuman(results, args) {
  const issueResults = results.filter(result => result.issues.length > 0 || result.missing);
  const issueCount = results.reduce((total, result) => total + result.issues.length + (result.missing ? 1 : 0), 0);
  const failThreshold = severityRank[args.failOn];
  const failing = results.filter(result => result.missing || result.maxSeverity >= failThreshold && failThreshold > 0);

  console.log(`[i18n-validate] Checked ${results.length} message(s). Issue messages: ${issueResults.length}. Issues: ${issueCount}. Failing messages: ${failing.length}.`);

  for (const result of issueResults.slice(0, args.maxIssues)) {
    if (result.missing) {
      console.log(`[ERROR] ${result.key} (${result.source}) missing from selected locale file(s).`);
      continue;
    }
    for (const issue of result.issues) {
      console.log(`[${issue.severity.toUpperCase()}] ${result.source} ${result.key}: ${issue.code} - ${issue.detail}`);
    }
  }

  if (issueResults.length > args.maxIssues) {
    console.log(`[i18n-validate] ${issueResults.length - args.maxIssues} more issue-bearing message(s) omitted.`);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const { createI18n } = await loadVueI18n(args.projectRoot);
  if (typeof createI18n !== 'function') {
    throw new Error('Loaded vue-i18n does not expose createI18n().');
  }

  const entries = collectEntries(args);
  if (entries.length === 0) {
    throw new Error('No messages found to validate.');
  }

  const options = {
    allowHtml: args.allowHtml,
    strictPlaceholders: args.strictPlaceholders,
  };
  const results = entries.map(entry => {
    if (entry.missing) {
      return { ...entry, issues: [{ severity: 'error', code: 'missing-key', detail: 'Key not found.' }], maxSeverity: severityRank.error };
    }
    return validateMessage(createI18n, entry, options);
  });

  const failThreshold = severityRank[args.failOn];
  const failing = results.filter(result => result.missing || result.maxSeverity >= failThreshold && failThreshold > 0);

  if (args.json) {
    console.log(JSON.stringify({ checked: results.length, failing: failing.length, results }, null, 2));
  } else {
    printHuman(results, args);
  }

  if (failing.length > 0) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(`[i18n-validate] ${error.message}`);
  process.exit(2);
});
