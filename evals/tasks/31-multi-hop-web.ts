import type { EvalTask } from "../types.js";
import { fail, pass, write } from "../helpers.js";
import { chromeDevtoolsServer, htmlPage } from "../web.js";

// Hard suite: a two-hop question over a local site. The opening date of the new main span is on
// the bridge history page (and, relative to a newspaper date, in a news item); the mayors list is
// two links away from the start page. Decoys: the works began under the previous mayor, and an
// outdated 1985 leaflet planned the replacement for 1991–1992, under a later mayor.
const PAGES: Record<string, [string, string]> = {
  "index.html": [
    "Riverton city archive",
    `<h1>Riverton city archive</h1>
<ul>
<li><a href="city/bridges/harbor-point-history.html">Harbor Point Bridge: history</a></li>
<li><a href="archive/leaflet-1985.html">Bridge facts (leaflet, 1985)</a></li>
<li><a href="news/1987-10-03-reopening.html">Riverton Courier, 3 October 1987</a></li>
<li><a href="city/government/index.html">City government</a></li>
<li><a href="city/parks.html">City parks</a></li>
</ul>`,
  ],
  "city/bridges/harbor-point-history.html": [
    "Harbor Point Bridge: history",
    `<h1>Harbor Point Bridge: history</h1>
<p><em>City of Riverton, Department of Public Works.</em></p>
<p>The bridge opened in 1931. By 1985 inspectors had found the original main span badly corroded.</p>
<p>Work to replace the main span began in November 1986, and the bridge was closed while it lasted.
The new steel main span opened to traffic on 2 October 1987.</p>`,
  ],
  "archive/leaflet-1985.html": [
    "Bridge facts (1985)",
    `<h1>Bridge facts</h1>
<p><em>Leaflet printed by the Riverton tourist office, spring 1985.</em></p>
<p>The Harbor Point Bridge is 412 metres long. Its main span is corroded; replacing it is planned for 1991–1992, when funds allow.</p>`,
  ],
  "news/1987-10-03-reopening.html": [
    "Riverton Courier, 3 October 1987",
    `<h1>Harbor Point Bridge reopens</h1>
<p><em>Riverton Courier, Saturday 3 October 1987.</em></p>
<p>Yesterday afternoon crowds lined Shore Road as the mayor cut the ribbon on the bridge's new main span.</p>`,
  ],
  "city/government/index.html": [
    "City government",
    `<h1>City government</h1>
<ul>
<li><a href="council.html">City council</a></li>
<li><a href="mayors.html">Mayors of Riverton since 1975</a></li>
<li><a href="budget.html">Budget</a></li>
</ul>`,
  ],
  "city/government/mayors.html": [
    "Mayors of Riverton",
    `<h1>Mayors of Riverton since 1975</h1>
<table>
<tr><th>Mayor</th><th>Term</th></tr>
<tr><td>Ruth Calder</td><td>January 1975 – December 1980</td></tr>
<tr><td>Arthur Lindqvist</td><td>January 1981 – December 1986</td></tr>
<tr><td>Helen Okafor</td><td>January 1987 – December 1990</td></tr>
<tr><td>Marcus Bell</td><td>January 1991 – December 1994</td></tr>
<tr><td>Dana Whitfield</td><td>January 1995 – December 2002</td></tr>
</table>`,
  ],
  "city/government/council.html": ["City council", "<h1>City council</h1><p>The council has 11 members, elected every four years.</p>"],
  "city/government/budget.html": ["Budget", "<h1>Budget</h1><p>The budget is published every March.</p>"],
  "city/parks.html": ["City parks", "<h1>City parks</h1><p>Riverton has 14 public parks.</p>"],
};

export const task: EvalTask = {
  id: "multi-hop-web",
  description: "Hard: combine a date from one page with a term list two links away; an outdated leaflet and the start of works are decoys",
  prompt: ({ baseUrl }) =>
    `Starting from the web page at ${baseUrl}/index.html, find out who was the mayor of Riverton when the Harbor Point ` +
    "Bridge's new main span opened to traffic. Give the mayor's name, the date it opened, and the URLs of the pages you used.",
  suite: "hard",
  mcpServers: chromeDevtoolsServer(),
  maxSteps: 30,
  site(siteDir) {
    for (const [p, [title, body]] of Object.entries(PAGES)) write(siteDir, p, htmlPage(title, body));
  },
  check(_dir, result, { web }) {
    const text = result.finalText ?? "";
    const problems: string[] = [];
    if (!/Okafor/i.test(text)) problems.push("wrong mayor (not Helen Okafor)");
    if (!/\b2(?:nd)? Oct(?:ober|\.)? 1987|\bOct(?:ober|\.)? 2(?:nd)?,? 1987|1987-10-02/i.test(text)) problems.push("opening date missing (2 October 1987)");
    if (!/government\/mayors\.html/.test(text)) problems.push("no citation of the mayors list");
    if (!/harbor-point-history\.html|1987-10-03-reopening\.html/.test(text)) problems.push("no citation of a page with the opening date");
    const details = {
      mentionsLindqvist: /Lindqvist/i.test(text),
      mentionsBell: /\bBell\b/.test(text),
      pagesLoaded: Object.keys(PAGES).filter((p) => web?.requests.includes(`/${p}`)),
    };
    return problems.length ? { ...fail(problems.join("; ")), details } : { ...pass(), details };
  },
};
