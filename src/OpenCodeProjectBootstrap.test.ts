import { strictEqual } from 'node:assert';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import {
  OPENCODE_PROJECT_BOOTSTRAP_SCRIPT,
  OPENCODE_SERVER_STATE_KEY,
} from './OpenCodeProjectBootstrap';
import { encodeOpenCodeRouteSegment } from './WorkspaceNavigation';

function runBootstrap(pathname: string, initialState?: unknown): Map<string, string> {
  const values = new Map<string, string>();
  if (initialState !== undefined) {
    values.set(OPENCODE_SERVER_STATE_KEY, JSON.stringify(initialState));
  }
  const window = {
    location: { pathname },
    localStorage: {
      getItem(key: string) {
        return values.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        values.set(key, value);
      },
    },
  };
  const source = OPENCODE_PROJECT_BOOTSTRAP_SCRIPT
    .replace(/^<script>\s*/, '')
    .replace(/\s*<\/script>$/, '');
  runInNewContext(source, {
    window,
    Uint8Array,
    TextDecoder,
    atob,
  });
  return values;
}

test('registers an unseen compatibility-route workspace before OpenCode starts', () => {
  const directory = 'C:\\Users\\demo\\new workspace';
  const pathname = `/${encodeOpenCodeRouteSegment(directory)}/session`;
  const values = runBootstrap(pathname, {
    list: [],
    projects: {
      local: [{ worktree: 'C:\\Users\\demo\\existing', expanded: false }],
    },
    lastProject: { local: 'C:\\Users\\demo\\existing' },
    recentlyClosed: { local: [directory] },
    untouched: { value: true },
  });
  const state = JSON.parse(values.get(OPENCODE_SERVER_STATE_KEY) ?? '{}');

  strictEqual(state.projects.local[0].worktree, directory);
  strictEqual(state.projects.local[0].expanded, true);
  strictEqual(state.projects.local[1].worktree, 'C:\\Users\\demo\\existing');
  strictEqual(state.lastProject.local, directory);
  strictEqual(state.recentlyClosed.local.length, 0);
  strictEqual(state.untouched.value, true);
});

test('does not duplicate a workspace already recorded with slash variations', () => {
  const directory = 'C:\\Users\\demo\\project\\';
  const pathname = `/${encodeOpenCodeRouteSegment(directory)}/session`;
  const values = runBootstrap(pathname, {
    projects: {
      local: [{ worktree: 'C:/Users/demo/project', expanded: false }],
    },
  });
  const state = JSON.parse(values.get(OPENCODE_SERVER_STATE_KEY) ?? '{}');

  strictEqual(state.projects.local.length, 1);
  strictEqual(state.lastProject.local, directory);
});

test('supports UTF-8 workspace paths and ignores unrelated routes', () => {
  const directory = '/home/demo/\u00e9tude';
  const route = `/${encodeOpenCodeRouteSegment(directory)}/session`;
  const registered = runBootstrap(route);
  const state = JSON.parse(registered.get(OPENCODE_SERVER_STATE_KEY) ?? '{}');
  strictEqual(state.projects.local[0].worktree, directory);

  const ignored = runBootstrap('/new-session?draftId=draft_123');
  strictEqual(ignored.has(OPENCODE_SERVER_STATE_KEY), false);
});
