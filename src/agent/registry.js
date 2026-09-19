import { githubTools, spacesTools, trelloTools } from "../tools/definitions.js";

const READ_ONLY_TOOLS = new Set([
  'listGitHubIssues', 'getPRDiff', 'getFileContent', 'listDirectoryContents', 'searchInFiles',
  'checkWorkflowStatus', 'webSearch', 'webFetch', 'imageSearch', 'songSearch',
  'getTaskPlan', 'recall', 'recallAll',
  'getReminders', 'getTrelloBoard', 'getTrelloLists', 'readLocalFile', 'listLocalDir', 'grepLocalFiles'
]);

const ALL_TOOLS_MAP = new Map();

function registerGroup(group) {
  for (const fn of group.functionDeclarations || []) {
    ALL_TOOLS_MAP.set(fn.name, {
      name: fn.name,
      description: fn.description,
      parameters: fn.parameters,
      isReadOnly: READ_ONLY_TOOLS.has(fn.name)
    });
  }
}

[githubTools, spacesTools, trelloTools].forEach(groupList => {
  for (const group of groupList) {
    registerGroup(group);
  }
});

export function getToolsForMode(isSpaces = false, isPlanOnly = false) {
  const tools = [];
  for (const [name, meta] of ALL_TOOLS_MAP) {
    if (isPlanOnly && !meta.isReadOnly) continue;
    if (!isSpaces && ['cloneRepo', 'readLocalFile', 'listLocalDir', 'grepLocalFiles', 'runCommand'].includes(name)) {
      continue;
    }
    tools.push(meta);
  }
  return tools;
}

export function isReadOnlyTool(name) {
  const meta = ALL_TOOLS_MAP.get(name);
  if (!meta) return false; // tool tak dikenal = anggap berbahaya di mode plan
  return meta.isReadOnly;
}

export function validateToolArgs(name, args) {
  const meta = ALL_TOOLS_MAP.get(name);
  if (!meta) return { valid: false, error: `Tool "${name}" tidak terdaftar.` };
  const required = meta.parameters?.required || [];
  for (const reqField of required) {
    if (args[reqField] === undefined || args[reqField] === null || args[reqField] === '') {
      return { valid: false, error: `Argumen wajib "${reqField}" hilang untuk tool "${name}".` };
    }
  }
  return { valid: true };
}
