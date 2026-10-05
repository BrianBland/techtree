/**
 * Just enough DOM for Preact to render into under Node: elements, text nodes, attributes,
 * styles and event listeners. Children are a linked list so sibling lookups stay O(1), like a browser.
 */
export class FakeNode {
  nodeType: number;
  localName: string;
  namespaceURI: string | null;
  data = "";
  parentNode: FakeNode | null = null;
  firstChild: FakeNode | null = null;
  lastChild: FakeNode | null = null;
  nextSibling: FakeNode | null = null;
  previousSibling: FakeNode | null = null;
  attributes = new Map<string, string>();
  listeners = new Map<string, (e: unknown) => void>();
  style = { setProperty() {}, cssText: "" } as Record<string, unknown>;
  ownerDocument: FakeDocument | null = null;

  constructor(nodeType: number, localName: string, namespaceURI: string | null) {
    this.nodeType = nodeType;
    this.localName = localName;
    this.namespaceURI = namespaceURI;
  }

  get childNodes(): FakeNode[] {
    const nodes: FakeNode[] = [];
    for (let n = this.firstChild; n; n = n.nextSibling) nodes.push(n);
    return nodes;
  }

  get textContent(): string {
    return this.nodeType === 3 ? this.data : this.childNodes.map((c) => c.textContent).join("");
  }

  insertBefore(node: FakeNode, ref: FakeNode | null): FakeNode {
    node.remove();
    node.parentNode = this;
    node.nextSibling = ref;
    node.previousSibling = ref ? ref.previousSibling : this.lastChild;
    if (node.previousSibling) node.previousSibling.nextSibling = node;
    else this.firstChild = node;
    if (ref) ref.previousSibling = node;
    else this.lastChild = node;
    return node;
  }

  appendChild(node: FakeNode): FakeNode {
    return this.insertBefore(node, null);
  }

  removeChild(node: FakeNode): FakeNode {
    node.remove();
    return node;
  }

  remove() {
    const parent = this.parentNode;
    if (!parent) return;
    if (this.previousSibling) this.previousSibling.nextSibling = this.nextSibling;
    else parent.firstChild = this.nextSibling;
    if (this.nextSibling) this.nextSibling.previousSibling = this.previousSibling;
    else parent.lastChild = this.previousSibling;
    this.parentNode = this.nextSibling = this.previousSibling = null;
  }

  setAttribute(name: string, value: unknown) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  addEventListener(type: string, listener: (e: unknown) => void) {
    this.listeners.set(type, listener);
  }

  removeEventListener(type: string) {
    this.listeners.delete(type);
  }

  /** Dispatch a bubbling event that honours `stopPropagation`. */
  dispatch(type: string, init: Record<string, unknown> = {}) {
    let stopped = false;
    const event: Record<string, unknown> = { type, target: this, stopPropagation: () => (stopped = true), preventDefault() {}, ...init };
    for (let n: FakeNode | null = this; n && !stopped; n = n.parentNode) {
      event.currentTarget = n;
      n.listeners.get(type)?.call(n, event);
    }
  }

  querySelectorAll(predicate: (n: FakeNode) => boolean): FakeNode[] {
    const out: FakeNode[] = [];
    for (let n = this.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 1 && predicate(n)) out.push(n);
      out.push(...n.querySelectorAll(predicate));
    }
    return out;
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: 1200, height: 800 };
  }

  get clientWidth() {
    return 1200;
  }

  get clientHeight() {
    return 800;
  }

  setPointerCapture() {}
  scrollTo() {}
}

export class FakeDocument extends FakeNode {
  body: FakeNode;

  constructor() {
    super(9, "#document", null);
    this.body = this.createElement("body");
    this.appendChild(this.body);
  }

  createElement(name: string): FakeNode {
    return this.createElementNS("http://www.w3.org/1999/xhtml", name);
  }

  createElementNS(namespace: string | null, name: string): FakeNode {
    const node = new FakeNode(1, name, namespace);
    node.ownerDocument = this;
    return node;
  }

  createTextNode(data: unknown): FakeNode {
    const node = new FakeNode(3, "#text", null);
    node.data = String(data);
    node.ownerDocument = this;
    return node;
  }
}
