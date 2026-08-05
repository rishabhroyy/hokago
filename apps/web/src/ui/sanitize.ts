// Overview text arrives from providers as HTML (AniList descriptions carry
// <i>/<b>/<s>/<a> markup). Render it safely: allowlist inline tags only,
// strip every attribute except safe http(s) links, drop scripts/styles.

const ALLOWED_TAGS = new Set([
  "br", "i", "em", "b", "strong", "s", "strike", "u",
  "a", "sub", "sup", "small", "code", "pre",
]);

const FORBIDDEN_TAGS = new Set(["script", "style", "iframe", "object", "embed", "form", "input"]);

export function sanitizeOverview(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const clean = (node: ChildNode, into: DocumentFragment): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      into.appendChild(node.cloneNode());
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (FORBIDDEN_TAGS.has(tag)) return;
    if (!ALLOWED_TAGS.has(tag)) {
      for (const child of Array.from(el.childNodes)) clean(child, into);
      return;
    }
    const clone = el.cloneNode(false) as Element;
    const href = el.getAttribute("href");
    if (tag === "a" && href && /^https?:\/\//i.test(href)) {
      clone.setAttribute("href", href);
      clone.setAttribute("rel", "noopener noreferrer");
      clone.setAttribute("target", "_blank");
    }
    const sub = doc.createDocumentFragment();
    for (const child of Array.from(el.childNodes)) clean(child, sub);
    clone.appendChild(sub);
    into.appendChild(clone);
  };
  const out = doc.createDocumentFragment();
  for (const child of Array.from(doc.body.childNodes)) clean(child, out);
  return new XMLSerializer().serializeToString(out);
}
