/**
 * Tiny Little Office's editors as a client-side library, without its shell.
 *
 * Upstream's shell owns the address bar, the library, sharing and the service worker. A SilverBullet widget needs none
 * of that: every editor is an element that takes the document as `value` and fires "docchange" with the new text. This
 * file does the rest of what the shell does for an editor: it loads the editor, registers its commands, frames it in
 * <to-chrome> and forwards undo.
 */
import '../src/styles.css';
import { fromTlo, read, tlo, encode, link } from '../src/api.ts';
import type { Editor } from '../src/kit/core/app.ts';
import { appOf } from '../src/kit/core/apps.ts';
import { register, runKey } from '../src/kit/core/commands.ts';
import { initLanguage, onLanguage } from '../src/kit/core/i18n.ts';
import { REDO, UNDO } from '../src/kit/core/keys.ts';
import { routeHash } from '../src/kit/core/route.ts';
import { onIcons } from '../src/kit/draw/icons.ts';
import { installPlainCopy } from '../src/kit/text/clipboard.ts';
import '../src/kit/ui/chrome.ts';
import '../src/kit/ui/dialog.ts';
import '../src/kit/ui/toast.ts';
import { applySize } from '../src/kit/ui/zoom.ts';

/** What a fence holds: the app, the document's text and, when the fence stores a link, that link. */
export interface Opened {
  app: string;
  text: string;
  link?: string;
}

/** Read a fence body: a link, .tlo text, or plain words, which are a page of text. Throws with a readable message otherwise. */
export function openBody(body: string): Opened {
  const trimmed = body.trim();
  const opened: Opened = /^https?:\/\/\S+$/.test(trimmed) ? { ...read(trimmed), link: trimmed } : fromTlo(body);
  opened.app ||= 'write';
  if (!appOf(opened.app)) throw new Error(`Not a Tiny Little Office app: "${opened.app}"`);
  return { app: opened.app, text: opened.text, link: opened.link };
}

/** The fence body for `text`: .tlo text, or the same link with a new fragment. Trailing blank lines are dropped. */
export function bodyOf({ app, link: stored }: Opened, text: string): string {
  if (stored) return stored.slice(0, stored.indexOf('#')) + routeHash(app, encode(text));
  return tlo(app, text).replace(/\n+$/, '');
}

/** The document as .tlo text, whatever the fence stores. */
export const textBody = ({ app }: Opened, text: string): string => bodyOf({ app, text }, text);

/** A link to the document on the hosted site. The document stays in the fragment, which browsers never send. */
export const hostedLink = ({ app }: Opened, text: string): string => link(app, text);

export interface MountOptions {
  app: string;
  text: string;
  /** Called with the document's text on every edit. */
  onChange(text: string): void;
}

const registered = new Set<string>();

/** Every link in a document opens in a new tab: the widget's <base target="_top"> would replace SilverBullet. */
function keepLinksOut(root: HTMLElement) {
  root.addEventListener(
    'click',
    (e) => {
      const anchor = (e.target as Element).closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor) return;
      e.preventDefault();
      if (/^https?:/.test(anchor.protocol) && !anchor.getAttribute('href')?.startsWith('#')) window.open(anchor.href, '_blank', 'noopener');
    },
    true,
  );
}

/** Mount the app's editor inside `host`. Resolves to the editor once it is in the page. */
export async function mount(host: HTMLElement, { app, text, onChange }: MountOptions): Promise<Editor> {
  const def = appOf(app);
  if (!def) throw new Error(`Not a Tiny Little Office app: "${app}"`);
  const [{ tag }, commands] = await Promise.all([def.editor(), def.commands?.(), initLanguage()]);
  if (commands && !registered.has(app)) {
    registered.add(app);
    register(commands.default);
  }

  const editor = document.createElement(tag) as Editor & { requestUpdate(): void };
  editor.classList.add('to-editor');
  editor.value = text;
  editor.addEventListener('docchange', (e) => onChange((e as CustomEvent<string>).detail));

  const chrome = document.createElement('to-chrome') as HTMLElement & Record<string, unknown>;
  Object.assign(chrome, { main: editor, mainClass: 'to-main to-wide', label: def.name, barred: true });
  host.append(chrome, document.createElement('to-toast'));

  applySize();
  installPlainCopy();
  keepLinksOut(host);
  onIcons(() => editor.requestUpdate());
  onLanguage(() => editor.requestUpdate());
  window.addEventListener('keydown', (e) => runKey(e, [UNDO, REDO], { editor }));
  return editor;
}
