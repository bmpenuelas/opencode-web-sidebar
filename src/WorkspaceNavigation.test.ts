import { strictEqual } from 'node:assert';
import { test } from 'node:test';
import {
  decideTrackedIframePath,
  encodeOpenCodeRouteSegment,
  getWorkspaceSessionPath,
} from './WorkspaceNavigation';

test('encodes OpenCode route segments as unpadded Base64URL', () => {
  strictEqual(encodeOpenCodeRouteSegment('C:/tmp/ÿ'), 'QzovdG1wL8O_');
  strictEqual(encodeOpenCodeRouteSegment('࠾'), '4KC-');
});

test('builds a workspace new-session compatibility route', () => {
  strictEqual(
    getWorkspaceSessionPath('C:\\Users\\demo'),
    '/QzpcVXNlcnNcZGVtbw/session',
  );
  strictEqual(getWorkspaceSessionPath(''), '');
});

test('keeps a workspace launch pending at its compatibility route', () => {
  const route = '/QzpcV29ya3NwYWNl/session';
  const decision = decideTrackedIframePath(route, true, route);
  strictEqual(decision.accept, true);
  strictEqual(decision.completesWorkspaceLaunch, false);
});

test('ignores restored home and unrelated tab routes during workspace launch', () => {
  const route = '/QzpcV29ya3NwYWNl/session';
  strictEqual(decideTrackedIframePath('/', true, route).accept, false);
  strictEqual(decideTrackedIframePath('/new-session', true, route).accept, false);
  strictEqual(decideTrackedIframePath('/settings', true, route).accept, false);
});

test('accepts the new UI draft redirect and concrete sessions', () => {
  const route = '/QzpcV29ya3NwYWNl/session';
  for (const path of [
    '/new-session?draftId=draft_123',
    '/QzpcV29ya3NwYWNl/session/ses_123',
    '/server/aHR0cDovL2xvY2FsaG9zdDo0MDk2/session/ses_123',
  ]) {
    const decision = decideTrackedIframePath(path, true, route);
    strictEqual(decision.accept, true);
    strictEqual(decision.completesWorkspaceLaunch, true);
  }
});

test('tracks ordinary navigation after workspace launch completes', () => {
  const decision = decideTrackedIframePath('/', false, '/ignored/session');
  strictEqual(decision.accept, true);
  strictEqual(decision.completesWorkspaceLaunch, false);
});

test('rejects absolute and protocol-relative iframe paths', () => {
  strictEqual(decideTrackedIframePath('https://example.com/', false, '').accept, false);
  strictEqual(decideTrackedIframePath('//example.com/', false, '').accept, false);
});
