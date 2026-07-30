import { strictEqual } from 'node:assert';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { WEBSIDEBAR_CLIPBOARD_SCRIPT } from './ClipboardBridge';

type Message = Record<string, any>;

interface Harness {
  commands: string[];
  posted: Message[];
  clipboard: any;
  parent: object;
  press(key: string, overrides?: Message): void;
  emit(type: string): void;
  answer(id: number, payload: Message, source?: object): void;
  lastRequest(type: string): Message | undefined;
}

function runBridge(): Harness {
  const commands: string[] = [];
  const posted: Message[] = [];
  const documentListeners = new Map<string, Function[]>();
  const windowListeners = new Map<string, Function[]>();

  const listen = (store: Map<string, Function[]>, type: string, fn: Function) => {
    store.set(type, [...(store.get(type) ?? []), fn]);
  };

  const parent = { postMessage: (msg: Message) => { posted.push(msg); } };
  const nativeClipboard = {
    write: () => { commands.push('native.write'); return Promise.resolve(); },
    read: () => Promise.resolve([]),
    writeText: () => { commands.push('native.writeText'); return Promise.resolve(); },
  };

  const window = {
    parent,
    navigator: { clipboard: nativeClipboard },
    addEventListener: (type: string, fn: Function) => listen(windowListeners, type, fn),
  };
  const document = {
    addEventListener: (type: string, fn: Function) => listen(documentListeners, type, fn),
    removeEventListener: (type: string, fn: Function) => {
      documentListeners.set(type, (documentListeners.get(type) ?? []).filter(f => f !== fn));
    },
    execCommand: (name: string, _showUi?: boolean, value?: string) => {
      commands.push(value === undefined ? name : `${name}:${value}`);
      return true;
    },
  };

  const source = WEBSIDEBAR_CLIPBOARD_SCRIPT
    .replace(/^<script>\s*/, '')
    .replace(/\s*<\/script>$/, '');
  runInNewContext(source, { window, document, setTimeout, clearTimeout });

  const emit = (type: string, event?: Message) => {
    (documentListeners.get(type) ?? []).forEach(fn => fn(event ?? {}));
  };

  return {
    commands,
    posted,
    parent,
    get clipboard() { return window.navigator.clipboard as any; },
    press(key, overrides = {}) {
      emit('keydown', {
        isTrusted: true, defaultPrevented: false, metaKey: true,
        ctrlKey: false, altKey: false, shiftKey: false, key, ...overrides,
      });
    },
    emit: (type: string) => emit(type),
    answer(id, payload, source = parent) {
      (windowListeners.get('message') ?? []).forEach(fn => fn({
        source,
        data: { type: 'ocClipboardResponse', id, ...payload },
      }));
    },
    lastRequest(type) {
      return posted.filter(msg => msg.type === type).pop();
    },
  };
}

const settle = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));

test('falls back to execCommand when no native clipboard event fires', async () => {
  const bridge = runBridge();
  bridge.press('c');
  bridge.press('x');
  bridge.press('a');
  await settle();

  strictEqual(bridge.commands.includes('copy'), true);
  strictEqual(bridge.commands.includes('cut'), true);
  strictEqual(bridge.commands.includes('selectAll'), true);
});

test('leaves a working native copy alone', async () => {
  const bridge = runBridge();
  bridge.press('c');
  bridge.emit('copy');
  await settle();

  strictEqual(bridge.commands.includes('copy'), false);
});

test('pastes clipboard text supplied by the extension host', async () => {
  const bridge = runBridge();
  bridge.press('v');
  await settle();

  const request = bridge.lastRequest('ocClipboardReadRequest');
  strictEqual(typeof request?.id, 'number');

  bridge.answer(request!.id, { text: 'pasted' });
  await settle();
  strictEqual(bridge.commands.includes('insertText:pasted'), true);
});

test('routes copy buttons through the extension host instead of the Clipboard API', async () => {
  const bridge = runBridge();
  let resolved = false;
  bridge.clipboard.writeText('copied snippet').then(() => { resolved = true; });
  await settle();

  const request = bridge.lastRequest('ocClipboardWriteRequest');
  strictEqual(request?.text, 'copied snippet');
  strictEqual(bridge.commands.includes('native.writeText'), false);

  bridge.answer(request!.id, { ok: true });
  await settle();
  strictEqual(resolved, true);
});

test('reports a failed host write and keeps images on the native path', async () => {
  const bridge = runBridge();
  let rejected = false;
  bridge.clipboard.writeText('snippet').catch(() => { rejected = true; });
  await settle();
  bridge.answer(bridge.lastRequest('ocClipboardWriteRequest')!.id, { ok: false });
  await settle();
  strictEqual(rejected, true);

  bridge.clipboard.write([{}]);
  await settle();
  strictEqual(bridge.commands.includes('native.write'), true);
});

test('ignores untrusted keydowns, handled shortcuts and foreign message sources', async () => {
  const untrusted = runBridge();
  untrusted.press('c', { isTrusted: false });
  untrusted.press('a', { defaultPrevented: true });
  await settle();
  strictEqual(untrusted.commands.length, 0);

  const spoofed = runBridge();
  spoofed.press('v');
  await settle();
  const request = spoofed.lastRequest('ocClipboardReadRequest');
  spoofed.answer(request!.id, { text: 'injected' }, { hostile: true });
  await settle();
  strictEqual(spoofed.commands.includes('insertText:injected'), false);
});

test('gives up on a request the extension host never answers', async () => {
  const bridge = runBridge();
  let rejected = false;
  bridge.clipboard.readText().catch(() => { rejected = true; });
  bridge.press('v');
  await settle(1100);

  strictEqual(rejected, true);
  strictEqual(bridge.commands.some(name => name.startsWith('insertText')), false);
});
