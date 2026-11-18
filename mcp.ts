// MCP endpoint: JSON-RPC 2.0 over streamable HTTP with JSON answers.

import {
  createRepoRec,
  getRepo,
  issueJson,
  pullJson,
  repoJson,
  type RepoRec,
} from './store.ts';
import { HttpError, type Ctx, type Router } from './app.ts';
import { createIssueRec } from './issues.ts';
import { createPullRec, mergePullRec } from './pulls.ts';

const SERVER_INFO = { name: 'forge-mcp', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        private: { type: 'boolean' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        pull_number: { type: 'number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

type Json = Record<string, unknown>;

function toolError(text: string): Json {
  return { content: [{ type: 'text', text }], isError: true };
}

function toolOk(value: unknown): Json {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function resolveRepo(args: Json): RepoRec {
  const repo = getRepo(args.owner as string, args.repo as string);
  if (repo === undefined) throw new Error('repository not found');
  return repo;
}

function callTool(name: string, args: Json): Json {
  try {
    switch (name) {
      case 'create_repo': {
        const rec = createRepoRec(args.name as string, {
          isPrivate: args.private === true,
          description: typeof args.description === 'string' ? args.description : '',
        });
        return toolOk(repoJson(rec));
      }
      case 'get_repo':
        return toolOk(repoJson(resolveRepo(args)));
      case 'create_issue': {
        const repo = resolveRepo(args);
        const issue = createIssueRec(repo, {
          title: args.title as string,
          body: typeof args.body === 'string' ? args.body : undefined,
        });
        return toolOk(issueJson(repo, issue));
      }
      case 'list_issues': {
        const repo = resolveRepo(args);
        let issues = [...repo.issues.values()];
        if (args.state === 'open' || args.state === 'closed') {
          issues = issues.filter((i) => i.state === args.state);
        }
        issues.sort((a, b) => a.number - b.number);
        return toolOk(issues.map((i) => issueJson(repo, i)));
      }
      case 'create_pull_request': {
        const repo = resolveRepo(args);
        const pull = createPullRec(repo, {
          head: args.head as string,
          base: args.base as string,
          title: args.title as string,
          body: typeof args.body === 'string' ? args.body : undefined,
        });
        return toolOk(pullJson(repo, pull));
      }
      case 'merge_pull_request': {
        const repo = resolveRepo(args);
        const pull = repo.pulls.get(args.pull_number as number);
        if (pull === undefined) throw new Error('pull request not found');
        mergePullRec(repo, pull);
        return toolOk(pullJson(repo, pull));
      }
      default:
        return toolError(`Unknown tool: ${name}`);
    }
  } catch (err) {
    if (err instanceof HttpError || err instanceof Error) {
      return toolError(err.message);
    }
    return toolError('tool error');
  }
}

function rpcResult(id: unknown, result: unknown): Json {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string): Json {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function handleEntry(entry: unknown): Json | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const req = entry as Json;
  if (req.id === undefined) return null;
  const id = req.id;
  const method = req.method;
  if (typeof method !== 'string') {
    return rpcError(id, -32600, 'Invalid Request');
  }
  const params =
    typeof req.params === 'object' && req.params !== null && !Array.isArray(req.params)
      ? (req.params as Json)
      : {};
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = params.name;
      const tool = typeof name === 'string' ? TOOLS_BY_NAME.get(name) : undefined;
      if (tool === undefined) {
        return rpcError(id, -32602, `Unknown tool: ${String(name)}`);
      }
      const args =
        typeof params.arguments === 'object' &&
        params.arguments !== null &&
        !Array.isArray(params.arguments)
          ? (params.arguments as Json)
          : {};
      for (const prop of tool.inputSchema.required) {
        if (args[prop] === undefined || args[prop] === null) {
          return rpcResult(id, toolError(`missing required argument: ${prop}`));
        }
      }
      return rpcResult(id, callTool(tool.name, args));
    }
    default:
      return rpcError(id, -32601, 'Method not found');
  }
}

export function registerMcp(router: Router): void {
  router.add('POST', '/mcp', (ctx: Ctx) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(ctx.rawBody.toString('utf8'));
    } catch {
      ctx.json(400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
      return;
    }
    if (Array.isArray(parsed)) {
      const responses = parsed
        .map((entry) => handleEntry(entry))
        .filter((r): r is Json => r !== null);
      ctx.json(200, responses);
      return;
    }
    const res = handleEntry(parsed);
    if (res === null) {
      ctx.empty(202);
      return;
    }
    ctx.json(200, res);
  });
}