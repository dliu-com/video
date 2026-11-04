// Shared rules for the /docs tabs written for people (dliu-com/status HEALTH.md): flows, numbers, tables and
// charts in plain words, every line bilingual, and no exact technical details (those live in the .md files).
const humanRules = (article, allowedLinks) => {
  expect(article).not.toMatch(/<code|<pre|<details|<summary|<kbd/);
  expect(article).not.toMatch(/\b(200|204|301|302|400|401|403|404|405|413|429|500|502|503)\b/);
  expect(article).not.toMatch(/application\/|text\/(html|javascript|markdown)|charset|Content-Type|Authorization|Cookie:|Location:|Cache-Control|\{"|":/i);
  expect(article).not.toMatch(/\b(GET|HEAD|POST|PUT|DELETE)\s+\//);
  const text = article.replace(/<[^>]*>/g, ' ');
  expect(text).not.toMatch(/https?:\/\/|\.amazonaws\.com|\bscope\b|video\.(read|write|delete)/);
  expect([...article.matchAll(/href="([^"]*)"/g)].map((m) => m[1])).toEqual(allowedLinks);
  // Bilingual: every element with English prose carries its Chinese text.
  const prose = [...article.matchAll(/<(p|li|strong|small|span|h[23]|figcaption|th|td|a)\b([^>]*)>([^<]*[A-Za-z]{3,} [A-Za-z]{2,}[^<]*)</g)];
  expect(prose.length).toBeGreaterThan(20);
  for (const [, , attributes, text] of prose) expect([text, attributes]).toEqual([text, expect.stringContaining('data-zh=')]);
};
module.exports = { humanRules };
