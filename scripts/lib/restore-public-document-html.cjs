// Reconstruct React streamed HTML fragments as data. Never evaluate page scripts.
function restorePublicDocumentHtml(html) {
  const replacements = new Map([...html.matchAll(/\$RS\("S:([^"]+)","P:([^"]+)"\)/g)].map(match => [`P:${match[2]}`, match[1]]));
  for (const match of html.matchAll(/\$(?:RC|RR)\("B:([^"]+)","S:([^"]+)"/g)) replacements.set(`B:${match[1]}`, match[2]);
  // Script strings contain HTML-like fragments; they must not participate in tag balancing.
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  const fragments = new Map();
  const ranges = [];
  const starts = /<div hidden id="S:([^"]+)"[^>]*>/g;
  let start;
  while ((start = starts.exec(html))) {
    const contentStart = starts.lastIndex;
    const tags = /<\/?div\b[^>]*>/g;
    tags.lastIndex = starts.lastIndex;
    let depth = 1; let tag;
    while ((tag = tags.exec(html))) {
      depth += tag[0].startsWith('</') ? -1 : 1;
      if (depth === 0) break;
    }
    if (!tag) continue;
    fragments.set(start[1], html.slice(contentStart, tag.index));
    ranges.push([start.index, tags.lastIndex]);
    starts.lastIndex = tags.lastIndex;
  }
  let output = ''; let position = 0;
  for (const [from, to] of ranges) { output += html.slice(position, from); position = to; }
  output += html.slice(position);
  for (let depth = 0; depth < 16; depth++) {
    let changed = false;
    output = output.replace(/<template id="([BP]:[^"]+)"[^>]*><\/template>/g, (original, id) => {
      const content = fragments.get(replacements.get(id) ?? id.slice(2));
      if (content === undefined) return original;
      changed = true; return content;
    });
    if (!changed) break;
  }
  return output;
}
module.exports = { restorePublicDocumentHtml };
