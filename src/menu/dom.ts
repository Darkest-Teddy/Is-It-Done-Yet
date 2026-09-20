/**
 * A forty-line element factory, and the reason there is no `innerHTML` in this app.
 *
 * Panels here are built from data -- a scan result, a recipe match, a leaderboard row -- and
 * the obvious way to do that is a template string. It is also the way that silently breaks the
 * moment an ingredient is called `Jalape<bad markup>` or a player types their name into the
 * board. Building nodes means text is text, always.
 *
 * The signature is deliberately small: tag, optional props, then children. Anything more
 * elaborate would be a framework, and a framework is a download the headset does not need for
 * seven screens.
 */

type Child = Node | string | number | null | undefined | false;

export interface Props {
  readonly class?: string;
  readonly text?: string | number;
  readonly html?: never;
  readonly style?: Partial<CSSStyleDeclaration> & Record<string, string>;
  readonly on?: Readonly<Record<string, (event: Event) => void>>;
  readonly attrs?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly [key: string]: unknown;
}

const DIRECT = new Set(['class', 'text', 'style', 'on', 'attrs', 'html']);

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);

  if (props) {
    if (props.class !== undefined) el.className = props.class;
    if (props.text !== undefined) el.textContent = String(props.text);

    if (props.style) {
      for (const [key, value] of Object.entries(props.style)) {
        if (typeof value !== 'string') continue;
        if (key.startsWith('--')) el.style.setProperty(key, value);
        else el.style.setProperty(camelToKebab(key), value);
      }
    }

    if (props.attrs) {
      for (const [key, value] of Object.entries(props.attrs)) {
        if (value === undefined || value === false) el.removeAttribute(key);
        else el.setAttribute(key, value === true ? '' : String(value));
      }
    }

    if (props.on) {
      for (const [type, handler] of Object.entries(props.on)) el.addEventListener(type, handler);
    }

    for (const [key, value] of Object.entries(props)) {
      if (DIRECT.has(key) || value === undefined) continue;
      el.setAttribute(camelToKebab(key), String(value));
    }
  }

  append(el, children);
  return el;
}

const camelToKebab = (key: string): string => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

export function append(parent: Node, children: readonly Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
}

/** Replaces everything inside `parent`. */
export function fill(parent: Element, ...children: Child[]): void {
  parent.replaceChildren();
  append(parent, children);
}

/** `<button>` with the press handler already attached, because every one of them needs it. */
export function button(
  className: string,
  onClick: () => void,
  ...children: Child[]
): HTMLButtonElement {
  return h('button', { class: className, attrs: { type: 'button' }, on: { click: onClick } }, ...children);
}

/** One of the design's ingredient pictures, sized by the caller. */
export function art(src: string, remWidth: number, alt = ''): HTMLImageElement {
  return h('img', {
    class: 'art',
    attrs: { src, alt, draggable: 'false', decoding: 'async', loading: 'lazy' },
    style: { width: `${remWidth}rem`, height: `${remWidth}rem`, objectFit: 'contain' },
  });
}

/** Parses one of the design document's inline SVGs. Static markup only -- never user text. */
export function svg(markup: string): SVGElement {
  const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
  const node = doc.documentElement;
  return document.importNode(node, true) as unknown as SVGElement;
}
