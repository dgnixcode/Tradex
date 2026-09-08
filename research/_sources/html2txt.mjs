// Minimal, dependency-free HTML -> text converter tuned for Slate-style API docs.
// Preserves heading levels, table rows (pipe-separated) and code blocks so the
// output can be grepped for exact endpoint paths and parameter names.
import { readFileSync, writeFileSync } from 'node:fs';

const [, , inFile, outFile] = process.argv;
let h = readFileSync(inFile, 'utf8');

// Drop non-content elements entirely.
h = h.replace(/<script[\s\S]*?<\/script>/gi, '');
h = h.replace(/<style[\s\S]*?<\/style>/gi, '');
h = h.replace(/<!--[\s\S]*?-->/g, '');

// Literal comparison operators. `price < min_price` is not markup, but the
// tag-stripping regex below would eat from the `<` to the next `>`, silently
// deleting the rest of the sentence. Park them on a sentinel and restore later.
// (4 occurrences in the CoinDCX reference, all in the futures error table.)
h = h.replace(/< /g, ' ');

// Headings -> markdown so section boundaries survive.
for (let i = 1; i <= 6; i++) {
  const open = new RegExp('<h' + i + '\\b[^>]*>', 'gi');
  const close = new RegExp('</h' + i + '>', 'gi');
  h = h.replace(open, '\n\n' + '#'.repeat(i) + ' ');
  h = h.replace(close, '\n');
}

// Tables: keep row/cell structure.
h = h.replace(/<\/tr>/gi, ' |\n');
h = h.replace(/<t[dh]\b[^>]*>/gi, ' | ');
h = h.replace(/<\/t[dh]>/gi, '');
h = h.replace(/<table\b[^>]*>/gi, '\n\n');
h = h.replace(/<\/table>/gi, '\n\n');

// Code blocks: fence them.
h = h.replace(/<pre\b[^>]*>/gi, '\n```\n');
h = h.replace(/<\/pre>/gi, '\n```\n');

// Block-level breaks.
h = h.replace(/<br\s*\/?>/gi, '\n');
h = h.replace(/<\/(p|div|li|ul|ol|section|article|blockquote)>/gi, '\n');
h = h.replace(/<li\b[^>]*>/gi, '- ');

// Anchors: keep href so source URLs stay traceable.
h = h.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, text) => {
  const t = text.replace(/<[^>]+>/g, '').trim();
  if (!t) return '';
  return href.startsWith('#') ? t : t + ' (' + href + ')';
});

// Everything else: strip tags.
h = h.replace(/<[^>]+>/g, '');

// Restore the parked comparison operators.
h = h.split('').join('<');

// Entities.
const ents = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&apos;': "'", '&rsquo;': '’', '&lsquo;': '‘',
  '&ldquo;': '“', '&rdquo;': '”', '&mdash;': '—', '&ndash;': '–',
  '&hellip;': '…', '&times;': '×', '&#x27;': "'", '&#x2F;': '/',
};
for (const [k, v] of Object.entries(ents)) h = h.split(k).join(v);
h = h.replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)));
h = h.replace(/&#x([0-9a-fA-F]+);/g, (m, d) => String.fromCodePoint(parseInt(d, 16)));

// Whitespace normalisation: keep indentation inside fences roughly intact but
// collapse the runs of blank lines Slate emits between every node.
h = h.replace(/[ \t]+\n/g, '\n');
h = h.replace(/\n{3,}/g, '\n\n');
h = h.replace(/^\s+/, '');

writeFileSync(outFile, h, 'utf8');
const lines = h.split('\n').length;
console.log('wrote ' + outFile + ' (' + h.length + ' chars, ' + lines + ' lines)');
