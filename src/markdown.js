/**
 * A small Markdown subset, rendered safely.
 *
 * The order is the whole security argument: every character of the input is
 * HTML-escaped FIRST, and the markup is applied to the escaped text
 * afterwards. There is therefore no path by which anything an author typed
 * becomes a tag — not a `<script>`, not an `onerror=`, not a half-closed
 * attribute that swallows the rest of the page. A renderer that marks up first
 * and sanitises after is a list of tags someone forgot, and this site takes
 * posts from clinics and comments from the public.
 *
 * No library, and deliberately: a Worker bundle that pulls in a Markdown
 * parser and an HTML sanitiser inherits both of their vulnerability histories
 * to render bold text. The subset below is what a blog post actually needs.
 *
 * Supported: headings (## and ###), bold, italic, inline code, fenced code
 * blocks, links, unordered and ordered lists, blockquotes, horizontal rules,
 * paragraphs. Not supported, on purpose: raw HTML, images from arbitrary
 * hosts, and tables.
 */

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (character) => ESCAPES[character]);
}

/**
 * Whether a link may be rendered as a link.
 *
 * An allowlist, not a blocklist. `javascript:` is the one everybody
 * remembers, but `data:text/html` and `vbscript:` do the same job, and the
 * next scheme is one nobody has thought of yet. Anything not plainly http,
 * https or mailto renders as text.
 */
function safeHref(href) {
  const trimmed = String(href || "").trim();
  // Already escaped by the time this runs, so &quot; and friends cannot break
  // out of the attribute; this decides scheme only.
  if (/^https?:\/\/[^\s]+$/i.test(trimmed)) return trimmed;
  if (/^mailto:[^\s]+$/i.test(trimmed)) return trimmed;
  if (/^\/[^\s]*$/.test(trimmed)) return trimmed; // same-site, no scheme to abuse
  return null;
}

/** Inline markup, applied to text that is already escaped. */
function inline(text) {
  return text
    // Code first: whatever is inside a backtick pair is literal, so nothing
    // below may reinterpret it as emphasis.
    .replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label, href) => {
      const safe = safeHref(href);
      if (!safe) return label;
      // rel="ugc nofollow noopener" on every outbound link: this site publishes
      // clinics' and members' words, and an unqualified outbound link from a
      // veterinary domain is a thing people will come here to farm.
      const external = /^https?:/i.test(safe);
      const rel = external ? ' rel="ugc nofollow noopener" target="_blank"' : "";
      return `<a href="${safe}"${rel}>${label}</a>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
}

/**
 * Render a Markdown document to HTML.
 *
 * Block-level parsing is line-based rather than recursive; the subset does not
 * nest, which is the reason it can be read in one pass and understood by
 * whoever has to audit it next.
 */
export function renderMarkdown(source) {
  const lines = escapeHtml(source).split(/\r?\n/);
  const out = [];
  let paragraph = [];
  let list = null;          // "ul" | "ol" | null
  let inCodeBlock = false;
  let codeBuffer = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    out.push(`<p>${inline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    out.push(`</${list}>`);
    list = null;
  };

  for (const line of lines) {
    // A fence opens and closes verbatim mode. Inside it nothing is marked up
    // at all — the content is already escaped, so it prints as typed.
    if (/^```/.test(line.trim())) {
      if (inCodeBlock) {
        out.push(`<pre><code>${codeBuffer.join("\n")}</code></pre>`);
        codeBuffer = [];
        inCodeBlock = false;
      } else {
        flushParagraph();
        flushList();
        inCodeBlock = true;
      }
      continue;
    }
    if (inCodeBlock) { codeBuffer.push(line); continue; }

    const trimmed = line.trim();

    if (!trimmed) { flushParagraph(); flushList(); continue; }

    if (/^---+$/.test(trimmed)) { flushParagraph(); flushList(); out.push("<hr>"); continue; }

    // h1 is the page's own title, so a post body starts at h2 — a document
    // with two h1s is a document a screen reader cannot outline.
    const heading = trimmed.match(/^(#{2,3})\s+(.*)$/);
    if (heading) {
      flushParagraph(); flushList();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    const quote = trimmed.match(/^&gt;\s?(.*)$/);
    if (quote) {
      flushParagraph(); flushList();
      out.push(`<blockquote><p>${inline(quote[1])}</p></blockquote>`);
      continue;
    }

    const bullet = trimmed.match(/^[-*]\s+(.*)$/);
    if (bullet) {
      flushParagraph();
      if (list !== "ul") { flushList(); out.push("<ul>"); list = "ul"; }
      out.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }

    const numbered = trimmed.match(/^\d+\.\s+(.*)$/);
    if (numbered) {
      flushParagraph();
      if (list !== "ol") { flushList(); out.push("<ol>"); list = "ol"; }
      out.push(`<li>${inline(numbered[1])}</li>`);
      continue;
    }

    flushList();
    paragraph.push(trimmed);
  }

  // An unterminated fence still has to render: the author's text is not lost
  // because they forgot the closing line.
  if (inCodeBlock && codeBuffer.length) out.push(`<pre><code>${codeBuffer.join("\n")}</code></pre>`);
  flushParagraph();
  flushList();
  return out.join("\n");
}

/**
 * A one-line summary for a listing, from the body, when no excerpt was given.
 */
export function excerptFrom(markdown, maxLength = 200) {
  const plain = String(markdown || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*`_\-]/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= maxLength) return plain;
  return `${plain.slice(0, maxLength - 1).trimEnd()}…`;
}
