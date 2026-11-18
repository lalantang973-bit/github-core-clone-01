// Minimal GraphQL executor for the documents gh and github-mcp-server send:
// queries/mutations with variables, aliases, inline fragments, input objects,
// enum literals, nulls, lists, batched arrays, and __type introspection.
// Unknown fields are HTTP 200 with an errors array naming the field.

import {
  VIEWER,
  decodeGlobalId,
  flattenTree,
  getObject,
  issueGlobalId,
  parseCommit,
  peelToCommit,
  pullGlobalId,
  commentGlobalId,
  repoGlobalId,
  squashMergePull,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------------------------
// tokenizer + parser (query language subset)
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():!=$=@[]'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      const text = source.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: parseFloat(text) } : { kind: 'int', value: parseInt(text, 10) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

export type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

export interface FieldSelection {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: Value }>;
  selectionSet: Selection[] | null;
}

export interface InlineFragmentSelection {
  kind: 'inline-fragment';
  typeCondition: string | null;
  selectionSet: Selection[];
}

export interface FragmentSpreadSelection {
  kind: 'fragment-spread';
  name: string;
}

export type Selection = FieldSelection | InlineFragmentSelection | FragmentSpreadSelection;

export interface OperationDefinition {
  kind: 'operation';
  operation: 'query' | 'mutation';
  name: string | null;
  variableDefinitions: Array<{ name: string }>;
  selectionSet: Selection[];
}

export interface FragmentDefinition {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selectionSet: Selection[];
}

export type Definition = OperationDefinition | FragmentDefinition;

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${JSON.stringify(value)} in GraphQL document`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    if (value !== undefined && token.value !== value) throw new Error(`expected ${JSON.stringify(value)}`);
    return token.value;
  }

  private peekPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }

  parseDocument(): Definition[] {
    const definitions: Definition[] = [];
    while (this.pos < this.tokens.length) definitions.push(this.parseDefinition());
    return definitions;
  }

  private parseDefinition(): Definition {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === '{') {
      return { kind: 'operation', operation: 'query', name: null, variableDefinitions: [], selectionSet: this.parseSelectionSet() };
    }
    if (token?.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      const operation = this.next().value as 'query' | 'mutation';
      let name: string | null = null;
      if (this.peek()?.kind === 'name') name = this.next().value;
      const variableDefinitions = this.parseVariableDefinitions();
      return { kind: 'operation', operation, name, variableDefinitions, selectionSet: this.parseSelectionSet() };
    }
    if (token?.kind === 'name' && token.value === 'fragment') {
      this.next();
      const name = this.expectName();
      this.expectName('on');
      const typeCondition = this.expectName();
      return { kind: 'fragment', name, typeCondition, selectionSet: this.parseSelectionSet() };
    }
    throw new Error('expected a GraphQL operation or fragment definition');
  }

  private parseVariableDefinitions(): Array<{ name: string }> {
    const defs: Array<{ name: string }> = [];
    if (!this.peekPunct('(')) return defs;
    this.next();
    while (!this.peekPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.peekPunct('=')) {
        this.next();
        this.parseValue();
      }
      defs.push({ name });
    }
    this.expectPunct(')');
    return defs;
  }

  private parseType(): void {
    if (this.peekPunct('[')) {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peekPunct('!')) this.next();
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.peekPunct('}')) selections.push(this.parseSelection());
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    if (this.peekPunct('...')) {
      this.next();
      const token = this.peek();
      if (token?.kind === 'name' && token.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inline-fragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (token?.kind === 'name') {
        return { kind: 'fragment-spread', name: this.next().value };
      }
      return { kind: 'inline-fragment', typeCondition: null, selectionSet: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peekPunct(':')) {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: Value }> = [];
    if (this.peekPunct('(')) {
      this.next();
      while (!this.peekPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    let selectionSet: Selection[] | null = null;
    if (this.peekPunct('{')) selectionSet = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: Value[] = [];
      while (!this.peekPunct(']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (!this.peekPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('expected a GraphQL value');
  }
}

export function parseGraphQL(source: string): Definition[] {
  return new Parser(tokenize(source)).parseDocument();
}

// ---------------------------------------------------------------------------------------------
// values
// ---------------------------------------------------------------------------------------------

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function valueFromAst(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.items.map((item) => valueFromAst(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = valueFromAst(field.value, variables);
      return out;
    }
  }
}

function argsFromAst(args: Array<{ name: string; value: Value }>, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of args) out[arg.name] = valueFromAst(arg.value, variables);
  return out;
}

// ---------------------------------------------------------------------------------------------
// schema (for __type introspection)
// ---------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: [
    'id',
    'databaseId',
    'name',
    'nameWithOwner',
    'owner',
    'defaultBranchRef',
    'viewerPermission',
    'hasIssuesEnabled',
    'issue',
    'issues',
    'pullRequests',
    'pullRequest',
  ],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
};

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

export interface GraphQLContext {
  store: Store;
}

interface ExecutorState {
  errors: Array<{ message: string }>;
  fragments: Map<string, FragmentDefinition>;
  variables: Record<string, unknown>;
  ctx: GraphQLContext;
}

/** A resolved object value, carrying its GraphQL type for nested selection. */
type ResolvedObject = { __typename: string; [key: string]: unknown };

function isObject(value: unknown): value is ResolvedObject {
  return typeof value === 'object' && value !== null && '__typename' in (value as Record<string, unknown>);
}

function executeSelectionSet(
  state: ExecutorState,
  parentType: string,
  parentValue: ResolvedObject,
  selections: Selection[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline-fragment') {
      if (selection.typeCondition === null || selection.typeCondition === parentType) {
        Object.assign(out, executeSelectionSet(state, parentType, parentValue, selection.selectionSet));
      }
      continue;
    }
    if (selection.kind === 'fragment-spread') {
      const fragment = state.fragments.get(selection.name);
      if (fragment && (fragment.typeCondition === parentType || fragment.typeCondition === parentType)) {
        Object.assign(out, executeSelectionSet(state, parentType, parentValue, fragment.selectionSet));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    const value = resolveField(state, parentType, parentValue, selection);
    if (value === undefined) continue;
    if (selection.selectionSet !== null && selection.selectionSet !== undefined) {
      if (value === null) {
        out[key] = null;
      } else if (isObject(value)) {
        out[key] = executeSelectionSet(state, value.__typename, value, selection.selectionSet);
      } else if (Array.isArray(value)) {
        out[key] = value.map((item) => (isObject(item) ? executeSelectionSet(state, item.__typename, item, selection.selectionSet!) : item));
      } else {
        out[key] = value;
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}

function unknownField(state: ExecutorState, parentType: string, fieldName: string): undefined {
  state.errors.push({ message: `Cannot query field "${fieldName}" on type "${parentType}".` });
  return undefined;
}

function repoObject(repo: Repo): ResolvedObject {
  return { __typename: 'Repository', repo };
}

function issueObject(repo: Repo, issue: Repo['issues'] extends Map<number, infer V> ? V : never): ResolvedObject {
  return { __typename: 'Issue', repo, issue };
}

function pullObject(repo: Repo, pull: Repo['pulls'] extends Map<number, infer V> ? V : never): ResolvedObject {
  return { __typename: 'PullRequest', repo, pull };
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number(text.slice('cursor:'.length));
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

function issueStateGql(state: 'open' | 'closed'): string {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullStateGql(pull: Repo['pulls'] extends Map<number, infer V> ? V : never): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function resolveField(state: ExecutorState, parentType: string, parentValue: ResolvedObject, field: FieldSelection): unknown {
  const args = argsFromAst(field.args, state.variables);
  const { ctx } = state;

  if (parentType === 'Query') {
    if (field.name === 'viewer') return { __typename: 'User', login: VIEWER.login };
    if (field.name === 'repository') {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      if (owner !== VIEWER.login) return null;
      const repo = ctx.store.getRepo(owner, name);
      return repo ? repoObject(repo) : null;
    }
    if (field.name === 'node') {
      const id = String(args.id ?? '');
      const decoded = decodeGlobalId(id);
      if (!decoded) return null;
      if (decoded.kind === 'repo') {
        for (const repo of ctx.store.repos.values()) {
          if (repo.id === decoded.repoId) return repoObject(repo);
        }
        return null;
      }
      if (decoded.kind === 'issue') {
        for (const repo of ctx.store.repos.values()) {
          if (repo.id === decoded.repoId) {
            const issue = repo.issues.get(decoded.number);
            return issue ? issueObject(repo, issue) : null;
          }
        }
        return null;
      }
      if (decoded.kind === 'pr') {
        for (const repo of ctx.store.repos.values()) {
          if (repo.id === decoded.repoId) {
            const pull = repo.pulls.get(decoded.number);
            return pull ? pullObject(repo, pull) : null;
          }
        }
        return null;
      }
      return null;
    }
    if (field.name === '__type') {
      const name = String(args.name ?? '');
      return { __typename: '__Type', typeName: name };
    }
    return unknownField(state, parentType, field.name);
  }

  if (parentType === 'User') {
    if (field.name === 'login') return parentValue.login ?? null;
    return unknownField(state, parentType, field.name);
  }

  if (parentType === 'Repository') {
    const repo = parentValue.repo as Repo;
    switch (field.name) {
      case 'id':
        return repoGlobalId(repo);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner':
        return { __typename: 'User', login: repo.owner };
      case 'defaultBranchRef':
        return { __typename: 'Ref', name: repo.defaultBranch };
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'issue': {
        const issue = repo.issues.get(Number(args.number));
        return issue ? issueObject(repo, issue) : null;
      }
      case 'issues': {
        const states = Array.isArray(args.states) ? (args.states as string[]) : null;
        const orderBy = (args.orderBy as Record<string, unknown> | undefined) ?? undefined;
        const first = typeof args.first === 'number' ? args.first : 100;
        const after = decodeCursor(args.after);
        let issues = [...repo.issues.values()];
        if (states) {
          const wanted = new Set(states.map((s) => s.toLowerCase()));
          issues = issues.filter((i) => wanted.has(i.state));
        }
        const direction = orderBy && String(orderBy.direction ?? 'DESC').toUpperCase() === 'ASC' ? 1 : -1;
        issues.sort((a, b) => (a.createdSeq - b.createdSeq) * direction);
        if (after !== null) {
          const index = issues.findIndex((i) => i.number === after);
          if (index >= 0) issues = issues.slice(index + 1);
        }
        const total = issues.length;
        const nodes = issues.slice(0, first);
        const hasNextPage = total > first;
        const endCursor = nodes.length ? encodeCursor(nodes[nodes.length - 1].number) : null;
        return {
          __typename: 'IssueConnection',
          nodes: nodes.map((i) => issueObject(repo, i)),
          pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
        };
      }
      case 'pullRequests': {
        const first = typeof args.first === 'number' ? args.first : 100;
        const pulls = [...repo.pulls.values()].sort((a, b) => b.createdSeq - a.createdSeq).slice(0, first);
        return { __typename: 'PullRequestConnection', nodes: pulls.map((p) => pullObject(repo, p)) };
      }
      case 'pullRequest': {
        const pull = repo.pulls.get(Number(args.number));
        return pull ? pullObject(repo, pull) : null;
      }
      default:
        return unknownField(state, parentType, field.name);
    }
  }

  if (parentType === 'Issue') {
    const repo = parentValue.repo as Repo;
    const issue = parentValue.issue as Repo['issues'] extends Map<number, infer V> ? V : never;
    switch (field.name) {
      case 'id':
        return issueGlobalId(repo, issue.number);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'state':
        return issueStateGql(issue.state);
      case 'body':
        return issue.body;
      default:
        return unknownField(state, parentType, field.name);
    }
  }

  if (parentType === 'PullRequest') {
    const repo = parentValue.repo as Repo;
    const pull = parentValue.pull as Repo['pulls'] extends Map<number, infer V> ? V : never;
    switch (field.name) {
      case 'id':
        return pullGlobalId(repo, pull.number);
      case 'number':
        return pull.number;
      case 'state':
        return pullStateGql(pull);
      case 'merged':
        return pull.merged;
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'mergeable':
        return pull.merged ? 'UNKNOWN' : 'MERGEABLE';
      case 'files': {
        const first = typeof args.first === 'number' ? args.first : 100;
        const baseCommit = peelToCommit(repo, pull.baseSha);
        const headCommit = peelToCommit(repo, pull.headSha);
        const nodes: ResolvedObject[] = [];
        if (baseCommit && headCommit) {
          const baseObj = getObject(repo, baseCommit);
          const headObj = getObject(repo, headCommit);
          if (baseObj && headObj) {
            const baseFiles = flattenTree(repo, parseCommit(baseObj.data).tree);
            const headFiles = flattenTree(repo, parseCommit(headObj.data).tree);
            const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
            for (const p of [...paths].sort()) {
              if (baseFiles.get(p) !== headFiles.get(p)) nodes.push({ __typename: 'PullRequestChangedFile', path: p });
            }
          }
        }
        return { __typename: 'PullRequestChangedFileConnection', nodes: nodes.slice(0, first) };
      }
      default:
        return unknownField(state, parentType, field.name);
    }
  }

  if (parentType === 'IssueConnection') {
    if (field.name === 'nodes') return parentValue.nodes as ResolvedObject[];
    if (field.name === 'pageInfo') return parentValue.pageInfo as ResolvedObject;
    return unknownField(state, parentType, field.name);
  }

  if (parentType === 'PageInfo') {
    if (field.name === 'hasNextPage') return parentValue.hasNextPage ?? false;
    if (field.name === 'endCursor') return parentValue.endCursor ?? null;
    return unknownField(state, parentType, field.name);
  }

  if (parentType === 'PullRequestConnection') {
    if (field.name === 'nodes') return parentValue.nodes as ResolvedObject[];
    return unknownField(state, parentType, field.name);
  }

  if (parentType === 'PullRequestChangedFileConnection') {
    if (field.name === 'nodes') return parentValue.nodes as ResolvedObject[];
    return unknownField(state, parentType, field.name);
  }

  if (parentType === 'PullRequestChangedFile') {
    if (field.name === 'path') return parentValue.path ?? null;
    return unknownField(state, parentType, field.name);
  }

  if (parentType === 'Ref') {
    if (field.name === 'name') return parentValue.name ?? null;
    return unknownField(state, parentType, field.name);
  }

  if (parentType === '__Type') {
    const typeName = String(parentValue.typeName ?? '');
    if (field.name === 'fields') {
      return (TYPE_FIELDS[typeName] ?? []).map((name) => ({ __typename: '__Field', name }));
    }
    if (field.name === 'enumValues') {
      return (TYPE_ENUM_VALUES[typeName] ?? []).map((name) => ({ __typename: '__EnumValue', name }));
    }
    if (field.name === 'name') return typeName;
    return unknownField(state, parentType, field.name);
  }

  if (parentType === '__Field' || parentType === '__EnumValue') {
    if (field.name === 'name') return parentValue.name ?? null;
    return unknownField(state, parentType, field.name);
  }

  if (parentType === 'Mutation') {
    return resolveMutation(state, field);
  }

  if (parentType === 'CreateIssuePayload') {
    if (field.name === 'issue') return parentValue.issue as ResolvedObject;
    return unknownField(state, parentType, field.name);
  }
  if (parentType === 'CloseIssuePayload') {
    if (field.name === 'issue') return parentValue.issue as ResolvedObject;
    return unknownField(state, parentType, field.name);
  }
  if (parentType === 'CreatePullRequestPayload') {
    if (field.name === 'pullRequest') return parentValue.pullRequest as ResolvedObject;
    return unknownField(state, parentType, field.name);
  }
  if (parentType === 'MergePullRequestPayload') {
    if (field.name === 'pullRequest') return parentValue.pullRequest as ResolvedObject;
    return unknownField(state, parentType, field.name);
  }
  if (parentType === 'AddCommentPayload') {
    if (field.name === 'commentEdge') return parentValue.commentEdge as ResolvedObject;
    return unknownField(state, parentType, field.name);
  }
  if (parentType === 'IssueCommentEdge') {
    if (field.name === 'node') return parentValue.node as ResolvedObject;
    return unknownField(state, parentType, field.name);
  }
  if (parentType === 'IssueComment') {
    if (field.name === 'id') return parentValue.id ?? null;
    if (field.name === 'body') return parentValue.body ?? null;
    return unknownField(state, parentType, field.name);
  }

  return unknownField(state, parentType, field.name);
}

function resolveMutation(state: ExecutorState, field: FieldSelection): unknown {
  const args = argsFromAst(field.args, state.variables);
  const { ctx } = state;
  const input = (args.input as Record<string, unknown> | undefined) ?? {};

  if (field.name === 'createIssue') {
    const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
    if (!decoded || decoded.kind !== 'repo') {
      state.errors.push({ message: 'createIssue: unknown repository' });
      return null;
    }
    const repo = [...ctx.store.repos.values()].find((r) => r.id === decoded.repoId);
    if (!repo) {
      state.errors.push({ message: 'createIssue: unknown repository' });
      return null;
    }
    const number = repo.nextIssueNumber++;
    const issue = {
      number,
      title: String(input.title ?? ''),
      body: String(input.body ?? ''),
      state: 'open' as const,
      labels: [] as string[],
      comments: [] as never[],
      createdSeq: ++ctx.store.seq,
    };
    repo.issues.set(number, issue);
    return { __typename: 'CreateIssuePayload', issue: issueObject(repo, issue) };
  }

  if (field.name === 'closeIssue') {
    const decoded = decodeGlobalId(String(input.issueId ?? ''));
    if (!decoded || decoded.kind !== 'issue') {
      state.errors.push({ message: 'closeIssue: unknown issue' });
      return null;
    }
    const repo = [...ctx.store.repos.values()].find((r) => r.id === decoded.repoId);
    const issue = repo?.issues.get(decoded.number);
    if (!repo || !issue) {
      state.errors.push({ message: 'closeIssue: unknown issue' });
      return null;
    }
    issue.state = 'closed';
    return { __typename: 'CloseIssuePayload', issue: issueObject(repo, issue) };
  }

  if (field.name === 'createPullRequest') {
    const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
    if (!decoded || decoded.kind !== 'repo') {
      state.errors.push({ message: 'createPullRequest: unknown repository' });
      return null;
    }
    const repo = [...ctx.store.repos.values()].find((r) => r.id === decoded.repoId);
    if (!repo) {
      state.errors.push({ message: 'createPullRequest: unknown repository' });
      return null;
    }
    const headRef = String(input.headRefName ?? '');
    const baseRef = String(input.baseRefName ?? repo.defaultBranch);
    const headOid = repo.refs.get(`refs/heads/${headRef}`);
    const baseOid = repo.refs.get(`refs/heads/${baseRef}`);
    if (!headOid || !baseOid) {
      state.errors.push({ message: 'createPullRequest: head or base branch does not exist' });
      return null;
    }
    const number = repo.nextPullNumber++;
    const pull = {
      number,
      title: String(input.title ?? ''),
      body: String(input.body ?? ''),
      headRef,
      baseRef,
      headSha: headOid,
      baseSha: baseOid,
      state: 'open' as const,
      merged: false,
      mergedAt: null as string | null,
      mergeCommitSha: null as string | null,
      createdSeq: ++ctx.store.seq,
    };
    repo.pulls.set(number, pull);
    return { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(repo, pull) };
  }

  if (field.name === 'mergePullRequest') {
    const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
    if (!decoded || decoded.kind !== 'pr') {
      state.errors.push({ message: 'mergePullRequest: unknown pull request' });
      return null;
    }
    const repo = [...ctx.store.repos.values()].find((r) => r.id === decoded.repoId);
    const pull = repo?.pulls.get(decoded.number);
    if (!repo || !pull) {
      state.errors.push({ message: 'mergePullRequest: unknown pull request' });
      return null;
    }
    if (!pull.merged) {
      const result = squashMergePull(repo, pull);
      if (!result.ok) {
        state.errors.push({ message: `mergePullRequest: ${result.reason}` });
        return null;
      }
    }
    return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(repo, pull) };
  }

  if (field.name === 'addComment') {
    const decoded = decodeGlobalId(String(input.subjectId ?? ''));
    if (!decoded || decoded.kind !== 'issue') {
      state.errors.push({ message: 'addComment: unknown subject' });
      return null;
    }
    const repo = [...ctx.store.repos.values()].find((r) => r.id === decoded.repoId);
    const issue = repo?.issues.get(decoded.number);
    if (!repo || !issue) {
      state.errors.push({ message: 'addComment: unknown subject' });
      return null;
    }
    const body = String(input.body ?? '');
    const comment = { id: repo.nextCommentId++, body, createdSeq: ++ctx.store.seq };
    issue.comments.push(comment);
    const node: ResolvedObject = {
      __typename: 'IssueComment',
      id: commentGlobalId(repo, issue.number, comment.id),
      body: comment.body,
    };
    return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'IssueCommentEdge', node } };
  }

  return unknownField(state, 'Mutation', field.name);
}

export interface GraphQLOperation {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

/** Execute one GraphQL operation body. Returns {data, errors?}. */
export function executeGraphQL(
  ctx: GraphQLContext,
  operation: GraphQLOperation,
): { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } {
  let definitions: Definition[];
  try {
    definitions = parseGraphQL(operation.query);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] };
  }
  const fragments = new Map<string, FragmentDefinition>();
  const operations: OperationDefinition[] = [];
  for (const definition of definitions) {
    if (definition.kind === 'fragment') fragments.set(definition.name, definition);
    else operations.push(definition);
  }
  let selected = operations[0];
  if (operations.length === 0) return { data: null, errors: [{ message: 'no operation in document' }] };
  if (operation.operationName) {
    selected = operations.find((op) => op.name === operation.operationName) ?? operations[0];
  }
  const state: ExecutorState = {
    errors: [],
    fragments,
    variables: operation.variables ?? {},
    ctx,
  };
  const rootType = selected.operation === 'mutation' ? 'Mutation' : 'Query';
  const root: ResolvedObject = { __typename: rootType };
  const data = executeSelectionSet(state, rootType, root, selected.selectionSet);
  const result: { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } = { data };
  if (state.errors.length) result.errors = state.errors;
  return result;
}

/** Execute a body that is either one operation or a batch array. */
export function executeGraphQLBody(
  ctx: GraphQLContext,
  body: unknown,
): unknown {
  if (Array.isArray(body)) {
    return body.map((entry) => {
      if (entry && typeof entry === 'object') {
        const op = entry as GraphQLOperation;
        return executeGraphQL(ctx, { query: String(op.query ?? ''), variables: (op.variables as Record<string, unknown>) ?? {}, operationName: op.operationName });
      }
      return { data: null, errors: [{ message: 'invalid operation in batch' }] };
    });
  }
  if (body && typeof body === 'object') {
    const op = body as GraphQLOperation;
    return executeGraphQL(ctx, { query: String(op.query ?? ''), variables: (op.variables as Record<string, unknown>) ?? {}, operationName: op.operationName });
  }
  return { data: null, errors: [{ message: 'invalid GraphQL body' }] };
}
